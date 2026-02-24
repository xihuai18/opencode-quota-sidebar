import type { AssistantMessage, Message } from '@opencode-ai/sdk'
import type { PluginInput } from '@opencode-ai/plugin'

import { TtlValueCache } from './cache.js'
import {
  calcEquivalentApiCostForMessage,
  canonicalApiCostProviderID,
  modelCostKey,
  parseModelCostRates,
  SUBSCRIPTION_API_COST_PROVIDERS,
  type ModelCostRates,
} from './cost.js'
import { dateKeyFromTimestamp, scanSessionsByCreatedRange } from './storage.js'
import { periodStart } from './period.js'
import { debug, isRecord, mapConcurrent, swallow } from './helpers.js'
import {
  emptyUsageSummary,
  fromCachedSessionUsage,
  mergeUsage,
  summarizeMessagesIncremental,
  toCachedSessionUsage,
  type UsageSummary,
} from './usage.js'
import type {
  CachedSessionUsage,
  QuotaSidebarConfig,
  QuotaSidebarState,
} from './types.js'

type DescendantsResolver = {
  listDescendantSessionIDs: (
    sessionID: string,
    opts: { maxDepth: number; maxSessions: number; concurrency: number },
  ) => Promise<string[]>
}

type Persistence = {
  markDirty: (dateKey: string | undefined) => void
  scheduleSave: () => void
  flushSave: () => Promise<void>
}

export function createUsageService(deps: {
  state: QuotaSidebarState
  config: QuotaSidebarConfig
  statePath: string
  client: PluginInput['client']
  directory: string
  persistence: Persistence
  descendantsResolver: DescendantsResolver
}) {
  const forceRescanSessions = new Set<string>()
  const dirtyGeneration = new Map<string, number>()
  const cleanGeneration = new Map<string, number>()

  const bumpDirty = (sessionID: string) => {
    dirtyGeneration.set(sessionID, (dirtyGeneration.get(sessionID) || 0) + 1)
  }

  const isDirty = (sessionID: string) => {
    return (
      (dirtyGeneration.get(sessionID) || 0) !==
      (cleanGeneration.get(sessionID) || 0)
    )
  }

  // Serialize per-session usage aggregation to avoid redundant message fetches
  // and cursor races when both a child session and its parent (includeChildren)
  // are refreshed concurrently.
  //
  // Track the generation the promise corresponds to; if new messages arrive
  // (generation bumps), callers should not reuse a stale in-flight computation.
  const usageInFlight = new Map<
    string,
    { generation: number; promise: Promise<SessionUsageResult> }
  >()

  const modelCostCache = new TtlValueCache<Record<string, ModelCostRates>>()
  const missingApiCostRateKeys = new Set<string>()

  const getModelCostMap = async () => {
    const cached = modelCostCache.get()
    if (cached) return cached

    const providerClient = deps.client as unknown as {
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
        query: { directory: deps.directory },
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

      const models = provider.models
      if (!isRecord(models)) return acc

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

    return modelCostCache.set(
      map,
      Math.max(30_000, deps.config.quota.refreshMs),
    )
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

  type MessageEntry = { info: Message }

  const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value)

  type Tokens = {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }

  const decodeTokens = (value: unknown): Tokens | undefined => {
    if (!isRecord(value)) return undefined
    if (!isFiniteNumber(value.input)) return undefined
    if (!isFiniteNumber(value.output)) return undefined

    const reasoning = isFiniteNumber(value.reasoning) ? value.reasoning : 0
    const cacheRaw = isRecord(value.cache) ? value.cache : {}
    const read = isFiniteNumber(cacheRaw.read) ? cacheRaw.read : 0
    const write = isFiniteNumber(cacheRaw.write) ? cacheRaw.write : 0
    return {
      input: value.input,
      output: value.output,
      reasoning,
      cache: { read, write },
    }
  }

  const decodeMessageInfo = (value: unknown): Message | undefined => {
    if (!isRecord(value)) return undefined
    if (typeof value.id !== 'string') return undefined
    if (typeof value.sessionID !== 'string') return undefined
    if (typeof value.role !== 'string') return undefined
    if (typeof value.providerID !== 'string') return undefined
    if (typeof value.modelID !== 'string') return undefined
    if (!isRecord(value.time)) return undefined
    if (!isFiniteNumber(value.time.created)) return undefined
    if (
      value.time.completed !== undefined &&
      !isFiniteNumber(value.time.completed)
    ) {
      return undefined
    }

    const tokens = decodeTokens(value.tokens)
    if (!tokens) return undefined

    // Normalize token fields to a stable shape (some providers/SDK versions may
    // omit reasoning/cache.write; treat them as 0).
    return {
      ...(value as any),
      time: {
        created: value.time.created,
        completed: value.time.completed,
      },
      tokens,
    } as Message
  }

  const decodeMessageEntry = (value: unknown): MessageEntry | undefined => {
    if (!isRecord(value)) return undefined
    const decoded = decodeMessageInfo(value.info)
    if (!decoded) return undefined
    return { info: decoded }
  }

  const decodeMessageEntries = (value: unknown): MessageEntry[] | undefined => {
    if (!Array.isArray(value)) return undefined
    const decoded = value
      .map((item) => decodeMessageEntry(item))
      .filter((item): item is MessageEntry => Boolean(item))

    if (decoded.length > 0 && decoded.length < value.length) {
      debug(
        `message entries partially decoded: kept ${decoded.length}/${value.length}`,
      )
    }

    // If the API returned entries but none match the expected shape,
    // treat it as a load failure so we don't silently undercount.
    if (decoded.length === 0 && value.length > 0) return undefined
    return decoded
  }

  const loadSessionEntries = async (sessionID: string) => {
    const response = await deps.client.session
      .messages({
        path: { id: sessionID },
        query: { directory: deps.directory },
        throwOnError: true,
      })
      .catch(swallow('loadSessionEntries'))
    if (!response) return undefined
    const data = (response as { data?: unknown }).data
    return decodeMessageEntries(data)
  }

  const persistSessionUsage = (
    sessionID: string,
    usage: CachedSessionUsage,
  ) => {
    const sessionState = deps.state.sessions[sessionID]
    if (!sessionState) return
    sessionState.usage = usage
    const dateKey =
      deps.state.sessionDateMap[sessionID] ||
      dateKeyFromTimestamp(sessionState.createdAt)
    deps.state.sessionDateMap[sessionID] = dateKey
    deps.persistence.markDirty(dateKey)
  }

  type SessionUsageResult = { usage: UsageSummary; persist: boolean }

  const summarizeSessionUsage = async (
    sessionID: string,
    generationAtStart: number,
  ): Promise<SessionUsageResult> => {
    const entries = await loadSessionEntries(sessionID)
    const sessionState = deps.state.sessions[sessionID]

    // If we can't load messages (transient API failure), fall back to cached
    // usage if available and avoid mutating cursor/dirty state.
    if (!entries) {
      if (sessionState?.usage) {
        return {
          usage: fromCachedSessionUsage(sessionState.usage, 1),
          persist: false,
        }
      }
      const empty = emptyUsageSummary()
      empty.sessionCount = 1
      return { usage: empty, persist: false }
    }

    const modelCostMap = await getModelCostMap()

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

    if ((dirtyGeneration.get(sessionID) || 0) === generationAtStart) {
      cleanGeneration.set(sessionID, generationAtStart)
    }

    return { usage, persist: true }
  }

  const summarizeSessionUsageLocked = async (sessionID: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const generationAtStart = dirtyGeneration.get(sessionID) || 0

      const existing = usageInFlight.get(sessionID)
      if (existing && existing.generation === generationAtStart) {
        const result = await existing.promise
        if ((dirtyGeneration.get(sessionID) || 0) !== generationAtStart)
          continue
        return result
      }

      const promise = summarizeSessionUsage(sessionID, generationAtStart)
      const entry = { generation: generationAtStart, promise }
      promise.finally(() => {
        const current = usageInFlight.get(sessionID)
        if (current?.promise === promise) usageInFlight.delete(sessionID)
      })
      usageInFlight.set(sessionID, entry)

      const result = await promise
      if ((dirtyGeneration.get(sessionID) || 0) !== generationAtStart) continue
      return result
    }

    const generationAtStart = dirtyGeneration.get(sessionID) || 0
    return summarizeSessionUsage(sessionID, generationAtStart)
  }

  const summarizeSessionUsageForDisplay = async (
    sessionID: string,
    includeChildren: boolean,
  ): Promise<UsageSummary> => {
    const root = await summarizeSessionUsageLocked(sessionID)
    const usage = root.usage
    if (root.persist) {
      persistSessionUsage(sessionID, toCachedSessionUsage(usage))
    }
    if (!includeChildren) return usage

    const descendantIDs =
      await deps.descendantsResolver.listDescendantSessionIDs(sessionID, {
        maxDepth: deps.config.sidebar.childrenMaxDepth,
        maxSessions: deps.config.sidebar.childrenMaxSessions,
        concurrency: deps.config.sidebar.childrenConcurrency,
      })
    if (descendantIDs.length === 0) return usage

    const merged = emptyUsageSummary()
    mergeUsage(merged, usage)

    const needsFetch: string[] = []
    for (const childID of descendantIDs) {
      const cached = deps.state.sessions[childID]?.usage
      if (cached && !isDirty(childID)) {
        mergeUsage(merged, fromCachedSessionUsage(cached, 1))
      } else {
        needsFetch.push(childID)
      }
    }

    if (needsFetch.length > 0) {
      const fetched = await mapConcurrent(
        needsFetch,
        deps.config.sidebar.childrenConcurrency,
        async (childID) => {
          const child = await summarizeSessionUsageLocked(childID)
          if (child.persist) {
            persistSessionUsage(childID, toCachedSessionUsage(child.usage))
          }
          return child.usage
        },
      )

      for (const childUsage of fetched) {
        mergeUsage(merged, childUsage)
      }
    }

    return merged
  }

  const RANGE_USAGE_CONCURRENCY = 5

  const summarizeRangeUsage = async (period: 'day' | 'week' | 'month') => {
    const startAt = periodStart(period)
    await deps.persistence.flushSave()
    const sessions = await scanSessionsByCreatedRange(
      deps.statePath,
      startAt,
      Date.now(),
      deps.state,
    )
    const usage = emptyUsageSummary()
    usage.sessionCount = sessions.length
    const modelCostMap = await getModelCostMap()
    const hasPricing = Object.keys(modelCostMap).length > 0

    const hasAnySubscriptionProvider = (cached: CachedSessionUsage) => {
      const providerIDs = Object.keys(cached.providers)
      // Back-compat: older cached chunks may have empty providers.
      // In that case, allow recompute so we can persist apiCost.
      if (providerIDs.length === 0) return true
      return providerIDs.some((providerID) => {
        const canonical = canonicalApiCostProviderID(providerID)
        return SUBSCRIPTION_API_COST_PROVIDERS.has(canonical)
      })
    }

    const shouldRecomputeApiCost = (cached: CachedSessionUsage) => {
      if (!hasPricing) return false
      if (cached.assistantMessages <= 0) return false
      if (cached.apiCost > 0) return false
      if (cached.total <= 0) return false
      if (!hasAnySubscriptionProvider(cached)) return false
      return true
    }

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

    if (needsFetch.length > 0) {
      const fetched = await mapConcurrent(
        needsFetch,
        RANGE_USAGE_CONCURRENCY,
        async (session) => {
          const entries = await loadSessionEntries(session.sessionID)
          if (!entries) {
            if (session.state.usage) {
              return {
                sessionID: session.sessionID,
                computed: fromCachedSessionUsage(session.state.usage, 1),
                persist: false,
              }
            }
            const empty = emptyUsageSummary()
            empty.sessionCount = 1
            return {
              sessionID: session.sessionID,
              computed: empty,
              persist: false,
            }
          }

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
          return { sessionID: session.sessionID, computed, persist: true }
        },
      )

      let dirty = false
      for (const { sessionID, computed, persist } of fetched) {
        mergeUsage(usage, { ...computed, sessionCount: 0 })
        const memoryState = deps.state.sessions[sessionID]
        if (persist && memoryState) {
          memoryState.usage = toCachedSessionUsage(computed)
          const dateKey =
            deps.state.sessionDateMap[sessionID] ||
            dateKeyFromTimestamp(memoryState.createdAt)
          deps.state.sessionDateMap[sessionID] = dateKey
          deps.persistence.markDirty(dateKey)
          dirty = true
        }
      }
      if (dirty) deps.persistence.scheduleSave()
    }

    return usage
  }

  const summarizeForTool = async (
    period: 'session' | 'day' | 'week' | 'month',
    sessionID: string,
    includeChildren: boolean,
  ) => {
    if (period === 'session') {
      return summarizeSessionUsageForDisplay(sessionID, includeChildren)
    }
    return summarizeRangeUsage(period)
  }

  const markSessionDirty = (sessionID: string) => {
    bumpDirty(sessionID)
  }

  const markForceRescan = (sessionID: string) => {
    forceRescanSessions.add(sessionID)
    bumpDirty(sessionID)
    const sessionState = deps.state.sessions[sessionID]
    if (sessionState) {
      sessionState.usage = undefined
      sessionState.cursor = undefined
      const dateKey =
        deps.state.sessionDateMap[sessionID] ||
        dateKeyFromTimestamp(sessionState.createdAt)
      deps.state.sessionDateMap[sessionID] = dateKey
      deps.persistence.markDirty(dateKey)
      deps.persistence.scheduleSave()
    }
  }

  const forgetSession = (sessionID: string) => {
    forceRescanSessions.delete(sessionID)
    dirtyGeneration.delete(sessionID)
    cleanGeneration.delete(sessionID)
    usageInFlight.delete(sessionID)
  }

  return {
    summarizeSessionUsageForDisplay,
    summarizeForTool,
    markSessionDirty,
    markForceRescan,
    forgetSession,
  }
}
