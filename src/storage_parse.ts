import { asNumber, isRecord } from './helpers.js'
import { normalizeTimestampMs } from './storage_dates.js'
import type {
  CacheUsageBucket,
  CacheUsageBuckets,
  CachedProviderUsage,
  CachedSessionUsage,
  IncrementalCursor,
  QuotaSidebarState,
  RecentProviderEvent,
  SessionState,
  SessionTitleState,
} from './types.js'

function parseSessionTitleState(value: unknown): SessionTitleState | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.baseTitle !== 'string') return undefined
  if (
    value.lastAppliedTitle !== undefined &&
    typeof value.lastAppliedTitle !== 'string'
  ) {
    return undefined
  }
  return {
    baseTitle: value.baseTitle,
    lastAppliedTitle: value.lastAppliedTitle,
  }
}

function parseProviderUsage(value: unknown): CachedProviderUsage | undefined {
  if (!isRecord(value)) return undefined
  return {
    input: asNumber(value.input, 0),
    output: asNumber(value.output, 0),
    reasoning: asNumber(value.reasoning, 0),
    cacheRead: asNumber(value.cacheRead, 0),
    cacheWrite: asNumber(value.cacheWrite, 0),
    total: asNumber(value.total, 0),
    cost: asNumber(value.cost, 0),
    apiCost: asNumber(value.apiCost, 0),
    assistantMessages: asNumber(value.assistantMessages, 0),
    cacheBuckets: parseCacheUsageBuckets(value.cacheBuckets),
  }
}

function parseCacheUsageBucket(value: unknown): CacheUsageBucket | undefined {
  if (!isRecord(value)) return undefined
  return {
    input: asNumber(value.input, 0),
    cacheRead: asNumber(value.cacheRead, 0),
    cacheWrite: asNumber(value.cacheWrite, 0),
    assistantMessages: asNumber(value.assistantMessages, 0),
  }
}

function parseCacheUsageBuckets(value: unknown): CacheUsageBuckets | undefined {
  if (!isRecord(value)) return undefined
  const readOnly = parseCacheUsageBucket(value.readOnly)
  const readWrite = parseCacheUsageBucket(value.readWrite)
  if (!readOnly && !readWrite) return undefined
  return {
    readOnly: readOnly || {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      assistantMessages: 0,
    },
    readWrite: readWrite || {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      assistantMessages: 0,
    },
  }
}

function parseRecentProviders(
  value: unknown,
): RecentProviderEvent[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parsed = value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => ({
      providerID:
        typeof item.providerID === 'string' && item.providerID
          ? item.providerID
          : undefined,
      completedAt: asNumber(item.completedAt),
    }))
    .filter(
      (item): item is RecentProviderEvent =>
        typeof item.providerID === 'string' &&
        typeof item.completedAt === 'number' &&
        Number.isFinite(item.completedAt),
    )
  return parsed.length > 0 ? parsed : undefined
}

function parseCachedUsage(value: unknown): CachedSessionUsage | undefined {
  if (!isRecord(value)) return undefined
  const providersRaw = isRecord(value.providers) ? value.providers : {}
  const providers = Object.entries(providersRaw).reduce<
    Record<string, CachedProviderUsage>
  >((acc, [providerID, providerUsage]) => {
    const parsed = parseProviderUsage(providerUsage)
    if (!parsed) return acc
    acc[providerID] = parsed
    return acc
  }, {})

  return {
    billingVersion: asNumber(value.billingVersion),
    input: asNumber(value.input, 0),
    output: asNumber(value.output, 0),
    reasoning: asNumber(value.reasoning, 0),
    cacheRead: asNumber(value.cacheRead, 0),
    cacheWrite: asNumber(value.cacheWrite, 0),
    total: asNumber(value.total, 0),
    cost: asNumber(value.cost, 0),
    apiCost: asNumber(value.apiCost, 0),
    assistantMessages: asNumber(value.assistantMessages, 0),
    cacheBuckets: parseCacheUsageBuckets(value.cacheBuckets),
    recentProviders: parseRecentProviders(value.recentProviders),
    providers,
  }
}

function parseCursor(value: unknown): IncrementalCursor | undefined {
  if (!isRecord(value)) return undefined
  const idsRaw = value.lastMessageIdsAtTime
  const lastMessageIdsAtTime = Array.isArray(idsRaw)
    ? idsRaw.filter(
        (item): item is string => typeof item === 'string' && !!item,
      )
    : undefined
  return {
    lastMessageId:
      typeof value.lastMessageId === 'string' ? value.lastMessageId : undefined,
    lastMessageTime: asNumber(value.lastMessageTime),
    lastMessageIdsAtTime:
      lastMessageIdsAtTime && lastMessageIdsAtTime.length
        ? Array.from(new Set(lastMessageIdsAtTime)).sort()
        : undefined,
  }
}

export function parseSessionState(value: unknown): SessionState | undefined {
  if (!isRecord(value)) return undefined
  const title = parseSessionTitleState(value)
  if (!title) return undefined

  const createdAt = normalizeTimestampMs(value.createdAt, 0)
  if (!createdAt) return undefined

  return {
    ...title,
    createdAt,
    parentID: typeof value.parentID === 'string' ? value.parentID : undefined,
    expiryToastShown: value.expiryToastShown === true,
    usage: parseCachedUsage(value.usage),
    dirty: value.dirty === true,
    cursor: parseCursor(value.cursor),
  }
}

export function parseQuotaCache(value: unknown) {
  const raw = isRecord(value) ? value : {}
  return Object.entries(raw).reduce<QuotaSidebarState['quotaCache']>(
    (acc, [key, item]) => {
      if (!isRecord(item)) return acc

      const checkedAt = asNumber(item.checkedAt, 0)
      if (!checkedAt) return acc
      const status = item.status
      if (
        status !== 'ok' &&
        status !== 'unavailable' &&
        status !== 'unsupported' &&
        status !== 'error'
      ) {
        return acc
      }
      const label = typeof item.label === 'string' ? item.label : key
      const adapterID =
        typeof item.adapterID === 'string' ? item.adapterID : undefined
      const shortLabel =
        typeof item.shortLabel === 'string' ? item.shortLabel : undefined
      const sortOrder =
        typeof item.sortOrder === 'number' ? item.sortOrder : undefined
      const balance = isRecord(item.balance)
        ? {
            amount:
              typeof item.balance.amount === 'number' ? item.balance.amount : 0,
            currency:
              typeof item.balance.currency === 'string'
                ? item.balance.currency
                : '$',
          }
        : undefined
      const windows = Array.isArray(item.windows)
        ? item.windows
            .filter((window): window is Record<string, unknown> =>
              isRecord(window),
            )
            .map((window) => ({
              label: typeof window.label === 'string' ? window.label : '',
              showPercent:
                typeof window.showPercent === 'boolean'
                  ? window.showPercent
                  : undefined,
              resetLabel:
                typeof window.resetLabel === 'string'
                  ? window.resetLabel
                  : undefined,
              note: typeof window.note === 'string' ? window.note : undefined,
              remainingPercent:
                typeof window.remainingPercent === 'number'
                  ? window.remainingPercent
                  : undefined,
              usedPercent:
                typeof window.usedPercent === 'number'
                  ? window.usedPercent
                  : undefined,
              resetAt:
                typeof window.resetAt === 'string' ? window.resetAt : undefined,
            }))
            .filter(
              (window) => window.label || window.remainingPercent !== undefined,
            )
        : undefined
      acc[key] = {
        providerID: typeof item.providerID === 'string' ? item.providerID : key,
        adapterID,
        label,
        shortLabel,
        sortOrder,
        status,
        checkedAt,
        remainingPercent:
          typeof item.remainingPercent === 'number'
            ? item.remainingPercent
            : undefined,
        usedPercent:
          typeof item.usedPercent === 'number' ? item.usedPercent : undefined,
        resetAt: typeof item.resetAt === 'string' ? item.resetAt : undefined,
        expiresAt:
          typeof item.expiresAt === 'string' ? item.expiresAt : undefined,
        balance,
        note: typeof item.note === 'string' ? item.note : undefined,
        windows,
      }
      return acc
    },
    {},
  )
}
