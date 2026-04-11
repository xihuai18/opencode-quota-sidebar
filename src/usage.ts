import type { AssistantMessage, Message } from '@opencode-ai/sdk'

import type {
  CacheCoverageMetrics,
  CacheCoverageMode,
  CacheUsageBucket,
  CacheUsageBuckets,
  CachedProviderUsage,
  CachedSessionUsage,
  IncrementalCursor,
  RecentProviderEvent,
} from './types.js'

/**
 * Billing cache version — bump this whenever the persisted `CachedSessionUsage`
 * shape changes in a way that requires recomputation (e.g. new aggregate
 * fields).  This is distinct from the plugin *state* version managed by the
 * persistence layer; billing version only governs usage-cache staleness.
 */
export const USAGE_BILLING_CACHE_VERSION = 9

const MAX_RECENT_PROVIDER_EVENTS = 100

export type ProviderUsage = {
  providerID: string
  input: number
  output: number
  /** Reasoning tokens (merged into output for display; persisted as 0). */
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  cost: number
  apiCost: number
  assistantMessages: number
  cacheBuckets?: CacheUsageBuckets
}

export type UsageSummary = {
  input: number
  output: number
  /** Reasoning tokens (merged into output for display; persisted as 0). */
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  cost: number
  apiCost: number
  assistantMessages: number
  sessionCount: number
  cacheBuckets?: CacheUsageBuckets
  recentProviders?: RecentProviderEvent[]
  providers: Record<string, ProviderUsage>
}

export type UsageOptions = {
  /** Equivalent API cost calculator for the message. */
  calcApiCost?: (message: AssistantMessage) => number
  /** Cache-behavior classifier for the message model/provider. */
  classifyCacheMode?: (message: AssistantMessage) => CacheCoverageMode
}

function emptyCacheUsageBucket(): CacheUsageBucket {
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    assistantMessages: 0,
  }
}

function emptyCacheUsageBuckets(): CacheUsageBuckets {
  return {
    readOnly: emptyCacheUsageBucket(),
    readWrite: emptyCacheUsageBucket(),
  }
}

function cloneCacheUsageBucket(bucket?: CacheUsageBucket): CacheUsageBucket {
  return {
    input: bucket?.input ?? 0,
    cacheRead: bucket?.cacheRead ?? 0,
    cacheWrite: bucket?.cacheWrite ?? 0,
    assistantMessages: bucket?.assistantMessages ?? 0,
  }
}

function cloneCacheUsageBuckets(
  buckets?: CacheUsageBuckets,
): CacheUsageBuckets | undefined {
  if (!buckets) return undefined
  return {
    readOnly: cloneCacheUsageBucket(buckets.readOnly),
    readWrite: cloneCacheUsageBucket(buckets.readWrite),
  }
}

function mergeCacheUsageBucket(
  target: CacheUsageBucket,
  source?: CacheUsageBucket,
) {
  if (!source) return target
  target.input += source.input
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.assistantMessages += source.assistantMessages
  return target
}

function addMessageCacheUsage(
  target: CacheUsageBucket,
  message: AssistantMessage,
) {
  target.input += message.tokens.input
  target.cacheRead += message.tokens.cache.read
  target.cacheWrite += message.tokens.cache.write
  target.assistantMessages += 1
}

/**
 * Best-effort fallback for legacy cached data that lacks per-message cache
 * buckets.  When `cacheWrite > 0` we assume all tokens came from a read-write
 * model (Anthropic-like); when only `cacheRead > 0` we assume read-only
 * (OpenAI-like).  Mixed-provider sessions that were cached before v3 will be
 * attributed to a single bucket — this is a known limitation; new sessions
 * classify per-message and are not affected.
 */
function fallbackCacheUsageBuckets(
  usage: Pick<
    UsageSummary,
    'input' | 'cacheRead' | 'cacheWrite' | 'assistantMessages'
  >,
): CacheUsageBuckets | undefined {
  if (usage.cacheWrite > 0) {
    return {
      readOnly: emptyCacheUsageBucket(),
      readWrite: {
        input: usage.input,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        assistantMessages: usage.assistantMessages,
      },
    }
  }

  if (usage.cacheRead > 0) {
    return {
      readOnly: {
        input: usage.input,
        cacheRead: usage.cacheRead,
        cacheWrite: 0,
        assistantMessages: usage.assistantMessages,
      },
      readWrite: emptyCacheUsageBucket(),
    }
  }

  return undefined
}

function resolvedCacheUsageBuckets(
  usage: Pick<
    UsageSummary,
    'input' | 'cacheRead' | 'cacheWrite' | 'assistantMessages' | 'cacheBuckets'
  >,
): CacheUsageBuckets {
  const explicit = cloneCacheUsageBuckets(usage.cacheBuckets)
  if (!explicit) {
    return (
      cloneCacheUsageBuckets(fallbackCacheUsageBuckets(usage)) ||
      emptyCacheUsageBuckets()
    )
  }

  const accountedInput = explicit.readOnly.input + explicit.readWrite.input
  const accountedCacheRead =
    explicit.readOnly.cacheRead + explicit.readWrite.cacheRead
  const accountedCacheWrite =
    explicit.readOnly.cacheWrite + explicit.readWrite.cacheWrite
  const accountedAssistantMessages =
    explicit.readOnly.assistantMessages + explicit.readWrite.assistantMessages

  const residual = fallbackCacheUsageBuckets({
    input: Math.max(0, usage.input - accountedInput),
    cacheRead: Math.max(0, usage.cacheRead - accountedCacheRead),
    cacheWrite: Math.max(0, usage.cacheWrite - accountedCacheWrite),
    assistantMessages: Math.max(
      0,
      usage.assistantMessages - accountedAssistantMessages,
    ),
  })

  if (residual) {
    mergeCacheUsageBucket(explicit.readOnly, residual.readOnly)
    mergeCacheUsageBucket(explicit.readWrite, residual.readWrite)
  }

  return explicit
}

export function getCacheCoverageMetrics(
  usage: Pick<
    UsageSummary,
    'input' | 'cacheRead' | 'cacheWrite' | 'assistantMessages' | 'cacheBuckets'
  >,
): CacheCoverageMetrics {
  const hasCacheActivity = usage.cacheRead > 0 || usage.cacheWrite > 0
  const cachedSurface = usage.input + usage.cacheRead

  return {
    cachedRatio:
      hasCacheActivity && cachedSurface > 0
        ? usage.cacheRead / cachedSurface
        : undefined,
  }
}

export function getProviderCacheCoverageMetrics(
  usage: Pick<
    ProviderUsage,
    'input' | 'cacheRead' | 'cacheWrite' | 'assistantMessages' | 'cacheBuckets'
  >,
): CacheCoverageMetrics {
  return getCacheCoverageMetrics(usage)
}

export function emptyUsageSummary(): UsageSummary {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
    apiCost: 0,
    assistantMessages: 0,
    sessionCount: 0,
    recentProviders: undefined,
    providers: {},
  }
}

function emptyProviderUsage(providerID: string): ProviderUsage {
  return {
    providerID,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
    apiCost: 0,
    assistantMessages: 0,
    cacheBuckets: undefined,
  }
}

function isAssistant(message: Message): message is AssistantMessage {
  return message.role === 'assistant'
}

function tokenTotal(message: AssistantMessage) {
  return (
    message.tokens.input +
    message.tokens.output +
    message.tokens.reasoning +
    message.tokens.cache.read +
    message.tokens.cache.write
  )
}

function mergedOutput(message: AssistantMessage) {
  // Reasoning is counted into output to keep one output statistic.
  return message.tokens.output + message.tokens.reasoning
}

function mergeRecentProviderEvents(
  target?: RecentProviderEvent[],
  source?: RecentProviderEvent[],
) {
  const merged = [...(target || []), ...(source || [])]
    .filter(
      (item): item is RecentProviderEvent =>
        !!item &&
        typeof item.providerID === 'string' &&
        typeof item.completedAt === 'number' &&
        Number.isFinite(item.completedAt),
    )
    .sort((left, right) => right.completedAt - left.completedAt)

  return merged.length > MAX_RECENT_PROVIDER_EVENTS
    ? merged.slice(0, MAX_RECENT_PROVIDER_EVENTS)
    : merged
}

function addMessageUsage(
  target: UsageSummary,
  message: AssistantMessage,
  options?: UsageOptions,
) {
  const total = tokenTotal(message)
  const output = mergedOutput(message)
  const cost =
    typeof message.cost === 'number' && Number.isFinite(message.cost)
      ? message.cost
      : 0
  const apiCostRaw = options?.calcApiCost ? options.calcApiCost(message) : 0
  const apiCost = Number.isFinite(apiCostRaw) && apiCostRaw > 0 ? apiCostRaw : 0
  target.input += message.tokens.input
  target.output += output
  target.cacheRead += message.tokens.cache.read
  target.cacheWrite += message.tokens.cache.write
  target.total += total
  target.assistantMessages += 1
  target.cost += cost
  target.apiCost += apiCost
  target.recentProviders = mergeRecentProviderEvents(target.recentProviders, [
    {
      providerID: message.providerID,
      completedAt: completedTimeOf(message) || message.time.created,
    },
  ])

  const provider =
    target.providers[message.providerID] ||
    emptyProviderUsage(message.providerID)

  provider.input += message.tokens.input
  provider.output += output
  provider.cacheRead += message.tokens.cache.read
  provider.cacheWrite += message.tokens.cache.write
  provider.total += total
  provider.cost += cost
  provider.apiCost += apiCost
  provider.assistantMessages += 1
  target.providers[message.providerID] = provider

  const cacheMode = options?.classifyCacheMode?.(message) || 'none'
  if (cacheMode === 'read-only') {
    const buckets = (target.cacheBuckets ||= emptyCacheUsageBuckets())
    addMessageCacheUsage(buckets.readOnly, message)
    const providerBuckets = (provider.cacheBuckets ||= emptyCacheUsageBuckets())
    addMessageCacheUsage(providerBuckets.readOnly, message)
  } else if (cacheMode === 'read-write') {
    const buckets = (target.cacheBuckets ||= emptyCacheUsageBuckets())
    addMessageCacheUsage(buckets.readWrite, message)
    const providerBuckets = (provider.cacheBuckets ||= emptyCacheUsageBuckets())
    addMessageCacheUsage(providerBuckets.readWrite, message)
  }
}

function completedTimeOf(message: AssistantMessage) {
  const completed = message.time.completed
  if (typeof completed !== 'number') return undefined
  if (!Number.isFinite(completed)) return undefined
  return completed
}

function isCompletedAssistantInRange(
  message: Message,
  startAt = 0,
  endAt = Number.POSITIVE_INFINITY,
): message is AssistantMessage {
  if (!isAssistant(message)) return false
  const completed = completedTimeOf(message)
  if (completed === undefined) return false
  return completed >= startAt && completed < endAt
}

export function summarizeMessages(
  entries: Array<{ info: Message }>,
  startAt = 0,
  sessionCount = 1,
  options?: UsageOptions,
) {
  const summary = emptyUsageSummary()
  summary.sessionCount = sessionCount

  for (const entry of entries) {
    if (!isCompletedAssistantInRange(entry.info, startAt)) continue
    addMessageUsage(summary, entry.info, options)
  }

  return summary
}

export function summarizeMessagesInCompletedRange(
  entries: Array<{ info: Message }>,
  startAt: number,
  endAt: number,
  sessionCount = 1,
  options?: UsageOptions,
) {
  const summary = emptyUsageSummary()
  summary.sessionCount = sessionCount

  for (const entry of entries) {
    if (!isCompletedAssistantInRange(entry.info, startAt, endAt)) continue
    addMessageUsage(summary, entry.info, options)
  }

  return summary
}

function rangeIndexForCompletedAt(
  ranges: Array<{ startAt: number; endAt: number }>,
  completedAt: number,
) {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const range = ranges[mid]
    if (completedAt < range.startAt) {
      high = mid - 1
      continue
    }
    if (completedAt >= range.endAt) {
      low = mid + 1
      continue
    }
    return mid
  }
  return -1
}

export function summarizeMessagesAcrossCompletedRanges(
  entries: Array<{ info: Message }>,
  ranges: Array<{ startAt: number; endAt: number }>,
  options?: UsageOptions,
) {
  const summaries = ranges.map(() => emptyUsageSummary())
  const touched = new Set<number>()

  if (ranges.length === 0) return summaries

  for (const entry of entries) {
    if (!isAssistant(entry.info)) continue
    const completed = completedTimeOf(entry.info)
    if (completed === undefined) continue
    const index = rangeIndexForCompletedAt(ranges, completed)
    if (index < 0) continue
    addMessageUsage(summaries[index], entry.info, options)
    touched.add(index)
  }

  for (const index of touched) {
    summaries[index].sessionCount = 1
  }

  return summaries
}

/**
 * P1: Incremental usage aggregation.
 * Only processes messages newer than the cursor. Returns updated cursor.
 * If `forceRescan` is true (e.g. after message.removed), does a full rescan.
 */
export function summarizeMessagesIncremental(
  entries: Array<{ info: Message }>,
  existingUsage: CachedSessionUsage | undefined,
  cursor: IncrementalCursor | undefined,
  forceRescan: boolean,
  options?: UsageOptions,
): { usage: UsageSummary; cursor: IncrementalCursor } {
  // If no cursor or force rescan, do full scan
  if (
    forceRescan ||
    !cursor?.lastMessageId ||
    typeof cursor.lastMessageTime !== 'number' ||
    !Number.isFinite(cursor.lastMessageTime) ||
    !existingUsage
  ) {
    const usage = summarizeMessages(entries, 0, 1, options)
    const lastMsg = findLastCompletedAssistant(entries)
    return {
      usage,
      cursor: {
        lastMessageId: lastMsg?.id,
        lastMessageTime: lastMsg?.time.completed ?? undefined,
        lastMessageIdsAtTime:
          lastMsg?.time.completed === undefined
            ? undefined
            : collectCompletedAssistantIdsAt(entries, lastMsg.time.completed),
      },
    }
  }

  // Incremental: start from existing usage, only process new messages.
  // Order-independent: use completed-time cursor (with id tie-breaker).
  const summary = fromCachedSessionUsage(existingUsage, 1)
  const cursorTime = cursor.lastMessageTime
  const cursorID = cursor.lastMessageId
  const cursorIDsAtTime = Array.isArray(cursor.lastMessageIdsAtTime)
    ? new Set(cursor.lastMessageIdsAtTime)
    : undefined

  // If the cursor doesn't record ids-at-time, and we see other messages with the
  // same completed timestamp but "earlier" ids, the id tie-breaker can miss
  // newly-arrived messages. Force a full rescan once to initialize ids-at-time.
  if (!cursorIDsAtTime) {
    for (const entry of entries) {
      const msg = entry.info
      if (!isAssistant(msg)) continue
      if (typeof msg.time.completed !== 'number') continue
      if (!Number.isFinite(msg.time.completed)) continue
      if (msg.id === cursorID) continue
      if (
        msg.time.completed === cursorTime &&
        msg.id.localeCompare(cursorID) < 0
      ) {
        const usage = summarizeMessages(entries, 0, 1, options)
        const lastMsg = findLastCompletedAssistant(entries)
        return {
          usage,
          cursor: {
            lastMessageId: lastMsg?.id,
            lastMessageTime: lastMsg?.time.completed ?? undefined,
            lastMessageIdsAtTime:
              lastMsg?.time.completed === undefined
                ? undefined
                : collectCompletedAssistantIdsAt(
                    entries,
                    lastMsg.time.completed,
                  ),
          },
        }
      }
    }
  }

  const isAfterCursor = (message: AssistantMessage) => {
    const completed = message.time.completed
    if (typeof completed !== 'number' || !Number.isFinite(completed))
      return false
    if (completed > cursorTime) return true
    if (completed < cursorTime) return false
    if (cursorIDsAtTime) {
      return !cursorIDsAtTime.has(message.id)
    }
    // Same timestamp: best-effort tie-breaker.
    return message.id.localeCompare(cursorID) > 0
  }

  const newerThan = (
    left: { id: string; time: number },
    right: { id: string; time: number },
  ) => {
    if (left.time !== right.time) return left.time > right.time
    return left.id.localeCompare(right.id) > 0
  }

  let foundCursor = false
  let nextCursor: IncrementalCursor = { ...cursor }

  for (const entry of entries) {
    const msg = entry.info
    if (!isAssistant(msg)) continue
    if (typeof msg.time.completed !== 'number') continue
    if (!Number.isFinite(msg.time.completed)) continue

    if (msg.id === cursorID) foundCursor = true
    if (!isAfterCursor(msg)) continue

    addMessageUsage(summary, msg, options)
    const candidate = { id: msg.id, time: msg.time.completed }
    const current = {
      id: nextCursor.lastMessageId || cursorID,
      time: nextCursor.lastMessageTime ?? cursorTime,
    }
    if (newerThan(candidate, current)) {
      const idsAtCursorTime = new Set(
        nextCursor.lastMessageIdsAtTime ||
          cursor.lastMessageIdsAtTime ||
          (current.id ? [current.id] : []),
      )
      idsAtCursorTime.add(msg.id)
      nextCursor = {
        lastMessageId: msg.id,
        lastMessageTime: msg.time.completed,
        lastMessageIdsAtTime:
          candidate.time > current.time
            ? [msg.id]
            : Array.from(idsAtCursorTime).sort(),
      }
    } else if (nextCursor.lastMessageTime === msg.time.completed) {
      const ids = new Set(nextCursor.lastMessageIdsAtTime || [])
      ids.add(msg.id)
      nextCursor.lastMessageIdsAtTime = Array.from(ids).sort()
    }
  }

  // If we never found the cursor message, the history may have been modified.
  // Fall back to full rescan.
  if (!foundCursor) {
    const usage = summarizeMessages(entries, 0, 1, options)
    const lastMsg = findLastCompletedAssistant(entries)
    return {
      usage,
      cursor: {
        lastMessageId: lastMsg?.id,
        lastMessageTime: lastMsg?.time.completed ?? undefined,
        lastMessageIdsAtTime:
          lastMsg?.time.completed === undefined
            ? undefined
            : collectCompletedAssistantIdsAt(entries, lastMsg.time.completed),
      },
    }
  }

  return { usage: summary, cursor: nextCursor }
}

function collectCompletedAssistantIdsAt(
  entries: Array<{ info: Message }>,
  completedTime: number,
) {
  const ids: string[] = []
  for (const entry of entries) {
    const msg = entry.info
    if (!isAssistant(msg)) continue
    if (typeof msg.time.completed !== 'number') continue
    if (!Number.isFinite(msg.time.completed)) continue
    if (msg.time.completed !== completedTime) continue
    ids.push(msg.id)
  }
  return Array.from(new Set(ids)).sort()
}

function findLastCompletedAssistant(
  entries: Array<{ info: Message }>,
): AssistantMessage | undefined {
  let best: AssistantMessage | undefined
  let bestTime = -Infinity
  let bestID = ''
  for (const entry of entries) {
    const msg = entry.info
    if (!isAssistant(msg)) continue
    if (typeof msg.time.completed !== 'number') continue
    if (!Number.isFinite(msg.time.completed)) continue
    const t = msg.time.completed
    if (t > bestTime || (t === bestTime && msg.id.localeCompare(bestID) > 0)) {
      best = msg
      bestTime = t
      bestID = msg.id
    }
  }
  return best
}

export function mergeUsage(
  target: UsageSummary,
  source: UsageSummary,
  options?: { includeCost?: boolean },
) {
  const includeCost = options?.includeCost !== false
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.total += source.total
  if (includeCost) {
    target.cost += source.cost
  }
  target.apiCost += source.apiCost
  target.assistantMessages += source.assistantMessages
  target.sessionCount += source.sessionCount
  target.recentProviders = mergeRecentProviderEvents(
    target.recentProviders,
    source.recentProviders,
  )

  const sourceBuckets = source.cacheBuckets
  if (sourceBuckets) {
    const targetBuckets = (target.cacheBuckets ||= emptyCacheUsageBuckets())
    mergeCacheUsageBucket(targetBuckets.readOnly, sourceBuckets.readOnly)
    mergeCacheUsageBucket(targetBuckets.readWrite, sourceBuckets.readWrite)
  }

  for (const provider of Object.values(source.providers)) {
    const existing =
      target.providers[provider.providerID] ||
      emptyProviderUsage(provider.providerID)

    existing.input += provider.input
    existing.output += provider.output
    existing.cacheRead += provider.cacheRead
    existing.cacheWrite += provider.cacheWrite
    existing.total += provider.total
    if (includeCost) {
      existing.cost += provider.cost
    }
    existing.apiCost += provider.apiCost
    existing.assistantMessages += provider.assistantMessages
    if (provider.cacheBuckets) {
      const providerBuckets = (existing.cacheBuckets ||=
        emptyCacheUsageBuckets())
      mergeCacheUsageBucket(
        providerBuckets.readOnly,
        provider.cacheBuckets.readOnly,
      )
      mergeCacheUsageBucket(
        providerBuckets.readWrite,
        provider.cacheBuckets.readWrite,
      )
    }
    target.providers[provider.providerID] = existing
  }

  return target
}

export function toCachedSessionUsage(
  summary: UsageSummary,
): CachedSessionUsage {
  const providers = Object.entries(summary.providers).reduce<
    Record<string, CachedProviderUsage>
  >((acc, [providerID, provider]) => {
    acc[providerID] = {
      input: provider.input,
      output: provider.output,
      // Always 0 after merge into output; kept for serialization shape.
      reasoning: provider.reasoning,
      cacheRead: provider.cacheRead,
      cacheWrite: provider.cacheWrite,
      total: provider.total,
      cost: provider.cost,
      apiCost: provider.apiCost,
      assistantMessages: provider.assistantMessages,
      cacheBuckets: cloneCacheUsageBuckets(provider.cacheBuckets),
    }
    return acc
  }, {})

  return {
    billingVersion: USAGE_BILLING_CACHE_VERSION,
    input: summary.input,
    output: summary.output,
    // Always 0 after merge into output; kept for serialization shape.
    reasoning: summary.reasoning,
    cacheRead: summary.cacheRead,
    cacheWrite: summary.cacheWrite,
    total: summary.total,
    cost: summary.cost,
    apiCost: summary.apiCost,
    assistantMessages: summary.assistantMessages,
    cacheBuckets: cloneCacheUsageBuckets(summary.cacheBuckets),
    recentProviders: summary.recentProviders?.slice(
      0,
      MAX_RECENT_PROVIDER_EVENTS,
    ),
    providers,
  }
}

export function fromCachedSessionUsage(
  cached: CachedSessionUsage,
  sessionCount = 1,
): UsageSummary {
  // Merge cached reasoning into output for a single output metric.
  const mergedOutputValue = cached.output + cached.reasoning
  const cacheBuckets = cloneCacheUsageBuckets(cached.cacheBuckets)
  return {
    input: cached.input,
    output: mergedOutputValue,
    reasoning: 0,
    cacheRead: cached.cacheRead,
    cacheWrite: cached.cacheWrite,
    total: cached.total,
    cost: cached.cost,
    apiCost: cached.apiCost || 0,
    assistantMessages: cached.assistantMessages,
    sessionCount,
    cacheBuckets,
    recentProviders: cached.recentProviders?.slice(
      0,
      MAX_RECENT_PROVIDER_EVENTS,
    ),
    providers: Object.entries(cached.providers).reduce<
      Record<string, ProviderUsage>
    >((acc, [providerID, provider]) => {
      acc[providerID] = {
        providerID,
        input: provider.input,
        output: provider.output + provider.reasoning,
        reasoning: 0,
        cacheRead: provider.cacheRead,
        cacheWrite: provider.cacheWrite,
        total: provider.total,
        cost: provider.cost,
        apiCost: provider.apiCost || 0,
        assistantMessages: provider.assistantMessages,
        cacheBuckets: cloneCacheUsageBuckets(provider.cacheBuckets),
      }
      return acc
    }, {}),
  }
}
