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
  fetchQuotaSnapshot,
  loadAuthMap,
  normalizeProviderID,
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
import { debug, mapConcurrent, swallow } from './helpers.js'
import type { QuotaSnapshot } from './types.js'
import {
  emptyUsageSummary,
  fromCachedSessionUsage,
  mergeUsage,
  summarizeMessagesIncremental,
  toCachedSessionUsage,
} from './usage.js'

const z = tool.schema

function normalizeBaseTitle(title: string) {
  return title.split(/\r?\n/, 1)[0] || 'Session'
}

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, '')
}

function canonicalizeTitle(value: string) {
  return stripAnsi(value)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join('\n')
}

function periodStart(period: 'day' | 'week' | 'month') {
  const now = new Date()
  if (period === 'month') {
    return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  }
  if (period === 'week') {
    const day = now.getDay()
    const shift = day === 0 ? 6 : day - 1
    const start = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - shift,
    )
    start.setHours(0, 0, 0, 0)
    return start.getTime()
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.role === 'assistant'
}

function quotaSort(left: QuotaSnapshot, right: QuotaSnapshot) {
  const order: Record<string, number> = {
    openai: 0,
    'github-copilot': 1,
    anthropic: 2,
  }
  const leftOrder = order[left.providerID] ?? 99
  const rightOrder = order[right.providerID] ?? 99
  if (leftOrder !== rightOrder) return leftOrder - rightOrder
  return left.providerID.localeCompare(right.providerID)
}

/**
 * H3 fix: detect if a title already contains our decoration.
 * Current layout has token/quota lines after base title line.
 */
function looksDecorated(title: string): boolean {
  const lines = stripAnsi(title).split(/\r?\n/)
  if (lines.length < 2) return false
  const detail = lines.slice(1).map((line) => line.trim())
  return detail.some((line) => {
    if (!line) return false
    if (/^Input\s+\S+\s+Output\s+\S+/.test(line)) return true
    if (/^Cache\s+(Read|Write)\s+\S+/.test(line)) return true
    if (/^Reasoning\s+\S+/.test(line)) return true
    if (/^(OpenAI|Copilot|Claude)\b/.test(line)) return true
    return false
  })
}

const SUBSCRIPTION_QUOTA_PROVIDERS = new Set(['openai', 'github-copilot'])

function subscriptionProvidersUsed(providerIDs: string[]) {
  const normalized = providerIDs.map((id) => normalizeProviderID(id))
  return Array.from(new Set(normalized)).filter((id) =>
    SUBSCRIPTION_QUOTA_PROVIDERS.has(id),
  )
}

export async function QuotaSidebarPlugin(input: PluginInput): Promise<Hooks> {
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

  let authCache:
    | { expiresAt: number; value: Awaited<ReturnType<typeof loadAuthMap>> }
    | undefined
  const getAuthMap = async () => {
    if (authCache && authCache.expiresAt > Date.now()) return authCache.value
    const value = await loadAuthMap(authPath)
    authCache = { value, expiresAt: Date.now() + 30_000 }
    return value
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

    const sessionState = state.sessions[sessionID]
    const forceRescan = forceRescanSessions.has(sessionID)
    if (forceRescan) forceRescanSessions.delete(sessionID)

    const { usage, cursor } = summarizeMessagesIncremental(
      entries,
      sessionState?.usage,
      sessionState?.cursor,
      forceRescan,
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

    // Separate sessions with cached usage from those needing API calls
    const needsFetch: typeof sessions = []
    for (const session of sessions) {
      if (session.state.usage) {
        mergeUsage(usage, fromCachedSessionUsage(session.state.usage, 0))
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
        )
        return { sessionID: session.sessionID, computed }
      })

      let dirty = false
      for (const { sessionID, computed } of fetched) {
        computed.sessionCount = 0
        mergeUsage(usage, computed)
        const memoryState = state.sessions[sessionID]
        if (memoryState) {
          memoryState.usage = toCachedSessionUsage(computed)
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
    const normalized = Array.from(
      new Set(providerIDs.map((providerID) => normalizeProviderID(providerID))),
    )
    const authMap = await getAuthMap()

    const candidates = normalized.length
      ? normalized
      : options?.allowDefault
        ? (['openai', 'github-copilot', 'anthropic'] as Array<
            'openai' | 'github-copilot' | 'anthropic'
          >)
        : ([] as string[])

    const fetched = await Promise.all(
      candidates.map(async (providerID) => {
        const cached = state.quotaCache[providerID]
        if (cached && Date.now() - cached.checkedAt <= config.quota.refreshMs)
          return cached
        const latest = await fetchQuotaSnapshot(
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
        )
        if (!latest) return undefined
        state.quotaCache[providerID] = latest
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
    const providers = Object.keys(usage.providers)
    const quotaProviders = subscriptionProvidersUsed(providers)
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
      await onEvent(event)
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
            await showToast(period, renderToastMessage(period, usage, quotas))
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
