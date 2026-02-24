import type { AssistantMessage, Message } from '@opencode-ai/sdk'

import type {
  CachedProviderUsage,
  CachedSessionUsage,
  IncrementalCursor,
} from './types.js'

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
  providers: Record<string, ProviderUsage>
}

export type UsageOptions = {
  /** Equivalent API cost calculator for the message. */
  calcApiCost?: (message: AssistantMessage) => number
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
    if (!isAssistant(entry.info)) continue
    if (typeof entry.info.time.completed !== 'number') continue
    if (!Number.isFinite(entry.info.time.completed)) continue
    if (entry.info.time.created < startAt) continue
    addMessageUsage(summary, entry.info, options)
  }

  return summary
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
      nextCursor = {
        lastMessageId: msg.id,
        lastMessageTime: msg.time.completed,
        lastMessageIdsAtTime: [msg.id],
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

export function mergeUsage(target: UsageSummary, source: UsageSummary) {
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.total += source.total
  target.cost += source.cost
  target.apiCost += source.apiCost
  target.assistantMessages += source.assistantMessages
  target.sessionCount += source.sessionCount

  for (const provider of Object.values(source.providers)) {
    const existing =
      target.providers[provider.providerID] ||
      emptyProviderUsage(provider.providerID)

    existing.input += provider.input
    existing.output += provider.output
    existing.cacheRead += provider.cacheRead
    existing.cacheWrite += provider.cacheWrite
    existing.total += provider.total
    existing.cost += provider.cost
    existing.apiCost += provider.apiCost
    existing.assistantMessages += provider.assistantMessages
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
    }
    return acc
  }, {})

  return {
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
    providers,
  }
}

export function fromCachedSessionUsage(
  cached: CachedSessionUsage,
  sessionCount = 1,
): UsageSummary {
  // Merge cached reasoning into output for a single output metric.
  const mergedOutputValue = cached.output + cached.reasoning
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
      }
      return acc
    }, {}),
  }
}
