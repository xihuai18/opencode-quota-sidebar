import path from 'node:path'

import type { AssistantMessage, Event, Message } from '@opencode-ai/sdk'
import { type Hooks, type PluginInput } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'

import {
  renderMarkdownReport,
  renderSidebarTitle,
  renderToastMessage,
} from './format.js'
import {
  createQuotaRuntime,
  listDefaultQuotaProviderIDs,
  loadAuthMap,
  quotaSort,
} from './quota.js'
import {
  authFilePath,
  dateKeyFromTimestamp,
  evictOldSessions,
  loadConfig,
  loadState,
  normalizeTimestampMs,
  resolveOpencodeDataDir,
  saveState,
  scanSessionsByCreatedRange,
  stateFilePath,
} from './storage.js'
import { asNumber, debug, isRecord, mapConcurrent, swallow } from './helpers.js'
import type { CachedSessionUsage, QuotaSnapshot } from './types.js'
import {
  calcEquivalentApiCostForMessage,
  canonicalApiCostProviderID,
  modelCostKey,
  type ModelCostRates,
  parseModelCostRates,
  SUBSCRIPTION_API_COST_PROVIDERS,
} from './cost.js'
import {
  canonicalizeTitle,
  looksDecorated,
  normalizeBaseTitle,
} from './title.js'
import { periodStart } from './period.js'
import {
  emptyUsageSummary,
  fromCachedSessionUsage,
  mergeUsage,
  summarizeMessagesIncremental,
  toCachedSessionUsage,
} from './usage.js'
import { TtlValueCache } from './cache.js'

const z = tool.schema

function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.role === 'assistant'
}

export async function QuotaSidebarPlugin(input: PluginInput): Promise<Hooks> {
  const quotaRuntime = createQuotaRuntime()
  const config = await loadConfig([
    path.join(input.directory, 'quota-sidebar.config.json'),
    path.join(input.worktree, 'quota-sidebar.config.json'),
  ])

  const dataDir = resolveOpencodeDataDir()
  const statePath = stateFilePath(dataDir)
  const authPath = authFilePath(dataDir)

  const state = await loadState(statePath)

  // M2: evict old sessions on startup
  evictOldSessions(state, config.retentionDays)

  const refreshTimer = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingAppliedTitle = new Map<
    string,
    { title: string; expiresAt: number }
  >()
  const dirtyDateKeys = new Set<string>()

  // Per-session queue for applyTitle
  const applyTitleLocks = new Map<string, Promise<void>>()

  // M1: track sessions that have been cleaned up from refreshTimer
  // (we clean up on each scheduleTitleRefresh call)

  // P1: track sessions needing full rescan (after message.removed)
  const forceRescanSessions = new Set<string>()

  const authCache = new TtlValueCache<Awaited<ReturnType<typeof loadAuthMap>>>()
  const getAuthMap = async () => {
    const cached = authCache.get()
    if (cached) return cached
    const value = await loadAuthMap(authPath)
    return authCache.set(value, 30_000)
  }

  const providerOptionsCache = new TtlValueCache<
    Record<string, Record<string, unknown>>
  >()

  const getProviderOptionsMap = async () => {
    const cached = providerOptionsCache.get()
    if (cached) return cached

    const configClient = input.client as unknown as {
      config?: {
        providers?: (args: {
          query: { directory: string }
          throwOnError: true
        }) => Promise<unknown>
      }
    }

    if (!configClient.config?.providers) {
      return providerOptionsCache.set({}, 30_000)
    }

    const response = await configClient.config
      .providers({
        query: { directory: input.directory },
        throwOnError: true,
      })
      .catch(swallow('getProviderOptionsMap'))

    const data =
      response &&
      typeof response === 'object' &&
      'data' in response &&
      response.data &&
      typeof response.data === 'object' &&
      'providers' in response.data
        ? (response.data.providers as unknown)
        : undefined

    const map = Array.isArray(data)
      ? data.reduce<Record<string, Record<string, unknown>>>((acc, item) => {
          if (!item || typeof item !== 'object') return acc
          const record = item as Record<string, unknown>
          const id = record.id
          const options = record.options
          if (typeof id !== 'string') return acc
          if (
            !options ||
            typeof options !== 'object' ||
            Array.isArray(options)
          ) {
            acc[id] = {}
            return acc
          }
          acc[id] = options as Record<string, unknown>
          return acc
        }, {})
      : {}

    return providerOptionsCache.set(map, 30_000)
  }

  const modelCostCache = new TtlValueCache<Record<string, ModelCostRates>>()
  const missingApiCostRateKeys = new Set<string>()

  const getModelCostMap = async () => {
    const cached = modelCostCache.get()
    if (cached) return cached

    const providerClient = input.client as unknown as {
      provider?: {
        list?: (args: {
          query: { directory: string }
          throwOnError: true
        }) => Promise<unknown>
      }
    }

    if (!providerClient.provider?.list) {
      return modelCostCache.set({}, 30_000)
    }

    const response = await providerClient.provider
      .list({
        query: { directory: input.directory },
        throwOnError: true,
      })
      .catch(swallow('getModelCostMap'))

    const all =
      response &&
      typeof response === 'object' &&
      'data' in response &&
      isRecord(response.data) &&
      Array.isArray(response.data.all)
        ? response.data.all
        : []

    const map = all.reduce<Record<string, ModelCostRates>>((acc, provider) => {
      if (!isRecord(provider)) return acc
      const providerID =
        typeof provider.id === 'string'
          ? canonicalApiCostProviderID(provider.id)
          : undefined
      if (!providerID) return acc
      if (!SUBSCRIPTION_API_COST_PROVIDERS.has(providerID)) return acc
      const models = isRecord(provider.models) ? provider.models : undefined
      if (!models) return acc

      for (const [modelKey, modelValue] of Object.entries(models)) {
        if (!isRecord(modelValue)) continue
        const rates = parseModelCostRates(modelValue.cost)
        if (!rates) continue

        const modelID =
          typeof modelValue.id === 'string' ? modelValue.id : modelKey
        acc[modelCostKey(providerID, modelID)] = rates
        if (modelKey !== modelID) {
          acc[modelCostKey(providerID, modelKey)] = rates
        }
      }

      return acc
    }, {})

    return modelCostCache.set(map, Math.max(30_000, config.quota.refreshMs))
  }

  const calcEquivalentApiCost = (
    message: AssistantMessage,
    modelCostMap: Record<string, ModelCostRates>,
  ) => {
    const providerID = canonicalApiCostProviderID(message.providerID)
    if (!SUBSCRIPTION_API_COST_PROVIDERS.has(providerID)) return 0

    const rates = modelCostMap[modelCostKey(providerID, message.modelID)]
    if (!rates) {
      const key = modelCostKey(providerID, message.modelID)
      if (!missingApiCostRateKeys.has(key)) {
        missingApiCostRateKeys.add(key)
        debug(`apiCost skipped: no model price for ${key}`)
      }
      return 0
    }

    return calcEquivalentApiCostForMessage(message, rates)
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let saveInFlight = Promise.resolve()

  /**
   * H2 fix: capture and delete specific dirty keys instead of clearing the whole set.
   * Keys added between capture and write completion are preserved.
   */
  const persistState = () => {
    const dirty = Array.from(dirtyDateKeys)
    if (dirty.length === 0) return saveInFlight
    // H2: delete only the captured keys, not clear()
    for (const key of dirty) {
      dirtyDateKeys.delete(key)
    }
    const write = saveInFlight
      .catch(swallow('persistState:wait'))
      .then(() => saveState(statePath, state, { dirtyDateKeys: dirty }))
      .catch((error) => {
        // Re-add captured keys so they are not lost on failed persistence.
        for (const key of dirty) {
          dirtyDateKeys.add(key)
        }
        throw error
      })
      .catch(swallow('persistState:save'))
    saveInFlight = write
    return write
  }

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      void persistState()
    }, 200)
  }

  /**
   * M5 fix: always flush current dirty keys, even when no timer is pending.
   */
  const flushSave = async () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = undefined
    }
    // M5: always persist if there are dirty keys, regardless of timer state
    if (dirtyDateKeys.size > 0) {
      await persistState()
      return
    }
    await saveInFlight
  }

  const ensureSessionState = (
    sessionID: string,
    title: string,
    createdAt = Date.now(),
  ) => {
    const existing = state.sessions[sessionID]
    if (existing) {
      if (!state.sessionDateMap[sessionID]) {
        state.sessionDateMap[sessionID] = dateKeyFromTimestamp(
          existing.createdAt,
        )
      }
      return existing
    }
    const normalizedCreatedAt = normalizeTimestampMs(createdAt)
    const created = {
      createdAt: normalizedCreatedAt,
      baseTitle: normalizeBaseTitle(title),
      lastAppliedTitle: undefined as string | undefined,
      usage: undefined,
      cursor: undefined,
    }
    state.sessions[sessionID] = created
    state.sessionDateMap[sessionID] = dateKeyFromTimestamp(normalizedCreatedAt)
    dirtyDateKeys.add(state.sessionDateMap[sessionID])
    return created
  }

  const loadSessionEntries = async (sessionID: string) => {
    const response = await input.client.session
      .messages({
        path: { id: sessionID },
        query: { directory: input.directory },
        throwOnError: true,
      })
      .catch(swallow('loadSessionEntries'))
    return response?.data ?? []
  }

  /**
   * P1: Incremental usage aggregation for current session.
   */
  const summarizeSessionUsage = async (sessionID: string) => {
    const entries = await loadSessionEntries(sessionID)
    const modelCostMap = await getModelCostMap()

    const sessionState = state.sessions[sessionID]
    const forceRescan = forceRescanSessions.has(sessionID)
    if (forceRescan) forceRescanSessions.delete(sessionID)

    const { usage, cursor } = summarizeMessagesIncremental(
      entries,
      sessionState?.usage,
      sessionState?.cursor,
      forceRescan,
      {
        calcApiCost: (message) => calcEquivalentApiCost(message, modelCostMap),
      },
    )
    usage.sessionCount = 1

    // Update cursor in state
    if (sessionState) {
      sessionState.cursor = cursor
    }

    return usage
  }

  /**
   * M10 fix: parallelize API calls for range usage with concurrency limit.
   */
  const summarizeRangeUsage = async (period: 'day' | 'week' | 'month') => {
    const startAt = periodStart(period)
    await flushSave()
    // M9: pass memoryState so we prefer in-memory data
    const sessions = await scanSessionsByCreatedRange(
      statePath,
      startAt,
      Date.now(),
      state,
    )
    const usage = emptyUsageSummary()
    usage.sessionCount = sessions.length
    const modelCostMap = await getModelCostMap()

    const shouldRecomputeApiCost = (cached: CachedSessionUsage) => {
      if (cached.assistantMessages <= 0) return false
      if (cached.apiCost > 0) return false
      if (cached.total <= 0) return false
      return true
    }

    // Separate sessions with cached usage from those needing API calls
    const needsFetch: typeof sessions = []
    for (const session of sessions) {
      if (session.state.usage) {
        if (shouldRecomputeApiCost(session.state.usage)) {
          needsFetch.push(session)
        } else {
          mergeUsage(usage, fromCachedSessionUsage(session.state.usage, 0))
        }
      } else {
        needsFetch.push(session)
      }
    }

    // M10: fetch in parallel with concurrency limit
    if (needsFetch.length > 0) {
      const fetched = await mapConcurrent(needsFetch, 5, async (session) => {
        const entries = await loadSessionEntries(session.sessionID)
        const { usage: computed } = summarizeMessagesIncremental(
          entries,
          undefined,
          undefined,
          true,
          {
            calcApiCost: (message) =>
              calcEquivalentApiCost(message, modelCostMap),
          },
        )
        return { sessionID: session.sessionID, computed }
      })

      let dirty = false
      for (const { sessionID, computed } of fetched) {
        // Range stats already know the session count (sessions.length).
        // Do not double-count sessionCount when merging per-session summaries.
        mergeUsage(usage, { ...computed, sessionCount: 0 })
        const memoryState = state.sessions[sessionID]
        if (memoryState) {
          memoryState.usage = toCachedSessionUsage(computed)
          const dateKey =
            state.sessionDateMap[sessionID] ||
            dateKeyFromTimestamp(memoryState.createdAt)
          state.sessionDateMap[sessionID] = dateKey
          dirtyDateKeys.add(dateKey)
          dirty = true
        }
      }
      if (dirty) scheduleSave()
    }

    return usage
  }

  const getQuotaSnapshots = async (
    providerIDs: string[],
    options?: { allowDefault?: boolean },
  ) => {
    const isValidQuotaCache = (snapshot: QuotaSnapshot) => {
      // Guard against stale RightCode cache entries from pre-daily format.
      if (snapshot.adapterID !== 'rightcode' || snapshot.status !== 'ok') {
        return true
      }
      if (!snapshot.windows || snapshot.windows.length === 0) return true
      const primary = snapshot.windows[0]
      if (!primary.label.startsWith('Daily $')) return false
      if (primary.showPercent !== false) return false
      return true
    }

    const [authMap, providerOptionsMap] = await Promise.all([
      getAuthMap(),
      getProviderOptionsMap(),
    ])

    const optionsForProvider = (providerID: string) => {
      return (
        providerOptionsMap[providerID] ||
        providerOptionsMap[quotaRuntime.normalizeProviderID(providerID)]
      )
    }

    const directCandidates = providerIDs.map((providerID) => ({
      providerID,
      providerOptions: optionsForProvider(providerID),
    }))

    const defaultCandidates = options?.allowDefault
      ? [
          ...Object.keys(providerOptionsMap).map((providerID) => ({
            providerID,
            providerOptions: providerOptionsMap[providerID],
          })),
          ...listDefaultQuotaProviderIDs().map((providerID) => ({
            providerID,
            providerOptions: optionsForProvider(providerID),
          })),
        ]
      : []

    const rawCandidates = directCandidates.length
      ? directCandidates
      : defaultCandidates

    const matchedCandidates = rawCandidates.filter((candidate) =>
      Boolean(
        quotaRuntime.resolveQuotaAdapter(
          candidate.providerID,
          candidate.providerOptions,
        ),
      ),
    )

    const dedupedCandidates = Array.from(
      matchedCandidates
        .reduce((acc, candidate) => {
          const key = quotaRuntime.quotaCacheKey(
            candidate.providerID,
            candidate.providerOptions,
          )
          if (!acc.has(key)) acc.set(key, candidate)
          return acc
        }, new Map<string, { providerID: string; providerOptions?: Record<string, unknown> }>())
        .values(),
    )

    const fetched = await Promise.all(
      dedupedCandidates.map(async ({ providerID, providerOptions }) => {
        const cacheKey = quotaRuntime.quotaCacheKey(providerID, providerOptions)
        const cached = state.quotaCache[cacheKey]
        if (cached && Date.now() - cached.checkedAt <= config.quota.refreshMs) {
          if (isValidQuotaCache(cached)) {
            return cached
          }
          delete state.quotaCache[cacheKey]
        }

        const latest = await quotaRuntime.fetchQuotaSnapshot(
          providerID,
          authMap,
          config,
          async (id, auth) => {
            await input.client.auth
              .set({
                path: { id },
                query: { directory: input.directory },
                body: {
                  type: auth.type,
                  access: auth.access,
                  refresh: auth.refresh,
                  expires: auth.expires,
                  enterpriseUrl: auth.enterpriseUrl,
                },
                throwOnError: true,
              })
              .catch(swallow('getQuotaSnapshots:authSet'))
          },
          providerOptions,
        )
        if (!latest) return undefined
        state.quotaCache[cacheKey] = latest
        return latest
      }),
    )

    const snapshots = fetched.filter((value): value is QuotaSnapshot =>
      Boolean(value),
    )
    snapshots.sort(quotaSort)
    scheduleSave()
    return snapshots
  }

  /**
   * Per-session apply queue.
   * New updates chain behind the previous one to preserve ordering.
   */
  const applyTitle = async (sessionID: string) => {
    const previous = applyTitleLocks.get(sessionID) ?? Promise.resolve()
    const promise = previous
      .catch(() => undefined)
      .then(() => applyTitleInner(sessionID))
    applyTitleLocks.set(sessionID, promise)
    try {
      await promise
    } finally {
      if (applyTitleLocks.get(sessionID) === promise) {
        applyTitleLocks.delete(sessionID)
      }
    }
  }

  const applyTitleInner = async (sessionID: string) => {
    if (!config.sidebar.enabled || !state.titleEnabled) return

    const session = await input.client.session
      .get({
        path: { id: sessionID },
        query: { directory: input.directory },
        throwOnError: true,
      })
      .catch(swallow('applyTitle:getSession'))

    if (!session) return

    const sessionState = ensureSessionState(
      sessionID,
      session.data.title,
      session.data.time.created,
    )

    // Detect whether the current title is our own decorated form.
    const currentTitle = session.data.title
    if (
      canonicalizeTitle(currentTitle) !==
      canonicalizeTitle(sessionState.lastAppliedTitle || '')
    ) {
      if (looksDecorated(currentTitle)) {
        // Ignore decorated echoes as base-title source.
        debug(`ignoring decorated current title for session ${sessionID}`)
      } else {
        sessionState.baseTitle = normalizeBaseTitle(currentTitle)
      }
      sessionState.lastAppliedTitle = undefined
    }

    const usage = await summarizeSessionUsage(sessionID)
    const quotaProviders = Array.from(
      new Set(
        Object.keys(usage.providers).map((id) =>
          quotaRuntime.normalizeProviderID(id),
        ),
      ),
    )
    const quotas =
      config.sidebar.showQuota && quotaProviders.length > 0
        ? await getQuotaSnapshots(quotaProviders)
        : ([] as QuotaSnapshot[])
    const nextTitle = renderSidebarTitle(
      sessionState.baseTitle,
      usage,
      quotas,
      config,
    )
    sessionState.usage = toCachedSessionUsage(usage)
    dirtyDateKeys.add(state.sessionDateMap[sessionID])

    if (
      canonicalizeTitle(nextTitle) === canonicalizeTitle(session.data.title)
    ) {
      scheduleSave()
      return
    }

    // Mark pending title to ignore the immediate echo `session.updated` event.
    // H3 fix: use longer TTL (15s) and add decoration detection as backup.
    pendingAppliedTitle.set(sessionID, {
      title: nextTitle,
      expiresAt: Date.now() + 15_000,
    })
    const previousApplied = sessionState.lastAppliedTitle
    sessionState.lastAppliedTitle = nextTitle
    dirtyDateKeys.add(state.sessionDateMap[sessionID])

    const updated = await input.client.session
      .update({
        path: { id: sessionID },
        query: { directory: input.directory },
        body: { title: nextTitle },
        throwOnError: true,
      })
      .catch(swallow('applyTitle:update'))

    if (!updated) {
      pendingAppliedTitle.delete(sessionID)
      sessionState.lastAppliedTitle = previousApplied
      scheduleSave()
      return
    }
    pendingAppliedTitle.delete(sessionID)
    scheduleSave()
  }

  const scheduleTitleRefresh = (sessionID: string, delay = 250) => {
    // M1: clean up completed timer entry before setting new one
    const previous = refreshTimer.get(sessionID)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      refreshTimer.delete(sessionID)
      void applyTitle(sessionID).catch(swallow('scheduleTitleRefresh'))
    }, delay)
    refreshTimer.set(sessionID, timer)
  }

  const restoreSessionTitle = async (sessionID: string) => {
    const session = await input.client.session
      .get({
        path: { id: sessionID },
        query: { directory: input.directory },
        throwOnError: true,
      })
      .catch(swallow('restoreSessionTitle:get'))
    if (!session) return

    const sessionState = ensureSessionState(
      sessionID,
      session.data.title,
      session.data.time.created,
    )
    const baseTitle = normalizeBaseTitle(sessionState.baseTitle)
    if (session.data.title === baseTitle) return

    await input.client.session
      .update({
        path: { id: sessionID },
        query: { directory: input.directory },
        body: { title: baseTitle },
        throwOnError: true,
      })
      .catch(swallow('restoreSessionTitle:update'))

    sessionState.lastAppliedTitle = undefined
    dirtyDateKeys.add(state.sessionDateMap[sessionID])
    scheduleSave()
  }

  /**
   * P3 fix: concurrency-limited title restoration.
   */
  const restoreAllVisibleTitles = async () => {
    const list = await input.client.session
      .list({
        query: { directory: input.directory },
        throwOnError: true,
      })
      .catch(swallow('restoreAllVisibleTitles:list'))
    if (!list?.data) return
    // Only restore sessions we've touched (have lastAppliedTitle)
    const touched = list.data.filter(
      (s) => state.sessions[s.id]?.lastAppliedTitle,
    )
    // P3: limit concurrency to 5
    await mapConcurrent(touched, 5, async (s) => {
      await restoreSessionTitle(s.id)
    })
  }

  const summarizeForTool = async (
    period: 'session' | 'day' | 'week' | 'month',
    sessionID: string,
  ) => {
    if (period === 'session') return summarizeSessionUsage(sessionID)
    return summarizeRangeUsage(period)
  }

  const showToast = async (
    period: 'session' | 'day' | 'week' | 'month' | 'toggle',
    message: string,
  ) => {
    await input.client.tui
      .showToast({
        query: { directory: input.directory },
        body: {
          title: `Quota ${period}`,
          message,
          variant: 'info',
          duration: config.toast.durationMs,
        },
        throwOnError: true,
      })
      .catch(swallow('showToast'))
  }

  const onEvent = async (event: Event) => {
    if (event.type === 'session.created') {
      ensureSessionState(
        event.properties.info.id,
        event.properties.info.title,
        event.properties.info.time.created,
      )
      scheduleSave()
      return
    }

    if (event.type === 'session.updated') {
      const sessionState = ensureSessionState(
        event.properties.info.id,
        event.properties.info.title,
        event.properties.info.time.created,
      )
      const pending = pendingAppliedTitle.get(event.properties.info.id)
      if (pending) {
        if (pending.expiresAt > Date.now()) {
          if (
            canonicalizeTitle(event.properties.info.title) ===
            canonicalizeTitle(pending.title)
          ) {
            pendingAppliedTitle.delete(event.properties.info.id)
            sessionState.lastAppliedTitle = pending.title
            dirtyDateKeys.add(state.sessionDateMap[event.properties.info.id])
            scheduleSave()
            return
          }
        } else {
          pendingAppliedTitle.delete(event.properties.info.id)
        }
      }

      // H3 fix: if the incoming title looks decorated, it's likely a late echo
      // of our own update. Extract the base title from line 1 instead of
      // treating the whole decorated string as the new base title.
      const incomingTitle = event.properties.info.title
      if (
        canonicalizeTitle(incomingTitle) ===
        canonicalizeTitle(sessionState.lastAppliedTitle || '')
      ) {
        return
      }

      if (looksDecorated(incomingTitle)) {
        // Late echo — ignore as base-title source.
        debug(
          `ignoring late decorated echo for session ${event.properties.info.id}`,
        )
        return
      } else {
        sessionState.baseTitle = normalizeBaseTitle(incomingTitle)
      }

      sessionState.lastAppliedTitle = undefined
      dirtyDateKeys.add(state.sessionDateMap[event.properties.info.id])
      scheduleSave()
      // External rename detected — re-render sidebar with new base title
      scheduleTitleRefresh(event.properties.info.id)
      return
    }

    if (event.type === 'message.removed') {
      // P1: mark session for full rescan since message order changed
      forceRescanSessions.add(event.properties.sessionID)
      // Also invalidate cached usage
      const sessionState = state.sessions[event.properties.sessionID]
      if (sessionState) {
        sessionState.usage = undefined
        sessionState.cursor = undefined
        const dateKey =
          state.sessionDateMap[event.properties.sessionID] ||
          dateKeyFromTimestamp(sessionState.createdAt)
        state.sessionDateMap[event.properties.sessionID] = dateKey
        dirtyDateKeys.add(dateKey)
        scheduleSave()
      }
      scheduleTitleRefresh(event.properties.sessionID)
      return
    }

    if (event.type !== 'message.updated') return
    if (!isAssistantMessage(event.properties.info)) return
    if (!event.properties.info.time.completed) return
    scheduleTitleRefresh(event.properties.info.sessionID)
  }

  return {
    event: async ({ event }) => {
      try {
        await onEvent(event)
      } catch (error) {
        debug(`event handler failed: ${String(error)}`)
      }
    },
    tool: {
      quota_summary: tool({
        description: 'Show usage and quota summary for session/day/week/month.',
        args: {
          period: z.enum(['session', 'day', 'week', 'month']).optional(),
          toast: z.boolean().optional(),
        },
        execute: async (args, context) => {
          const period = args.period || 'session'
          const usage = await summarizeForTool(period, context.sessionID)
          // For quota_summary, always show all subscription quota balances,
          // regardless of which providers were used in the session.
          const quotas = await getQuotaSnapshots([], { allowDefault: true })
          const markdown = renderMarkdownReport(period, usage, quotas, {
            showCost: config.sidebar.showCost,
          })

          if (args.toast !== false) {
            await showToast(
              period,
              renderToastMessage(period, usage, quotas, {
                showCost: config.sidebar.showCost,
                width: Math.max(44, config.sidebar.width + 18),
              }),
            )
          }

          return markdown
        },
      }),
      quota_show: tool({
        description:
          'Toggle sidebar title display mode. When on, titles show token usage and quota; when off, titles revert to original.',
        args: {
          enabled: z
            .boolean()
            .optional()
            .describe('Explicit on/off. Omit to toggle current state.'),
        },
        execute: async (args, context) => {
          const next =
            args.enabled !== undefined ? args.enabled : !state.titleEnabled
          state.titleEnabled = next
          scheduleSave()

          if (next) {
            // Turning on — re-render current session immediately
            scheduleTitleRefresh(context.sessionID, 0)
            await showToast('toggle', 'Sidebar usage display: ON')
            return 'Sidebar usage display is now ON. Session titles will show token usage and quota.'
          }

          // Turning off — restore all touched sessions to base titles
          await restoreAllVisibleTitles()
          await showToast('toggle', 'Sidebar usage display: OFF')
          return 'Sidebar usage display is now OFF. Session titles restored to original.'
        },
      }),
    },
  }
}

export default QuotaSidebarPlugin

// O5: Export consumer types
export type {
  QuotaSidebarConfig,
  QuotaSidebarState,
  QuotaSnapshot,
  QuotaStatus,
  SessionState,
  CachedSessionUsage,
  CachedProviderUsage,
  IncrementalCursor,
} from './types.js'
export type { UsageSummary } from './usage.js'
