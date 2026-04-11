import { asNumber, isRecord } from './helpers.js'
import { normalizeTimestampMs } from './storage_dates.js'
import type {
  CacheUsageBucket,
  CacheUsageBuckets,
  CachedProviderUsage,
  CachedSessionUsage,
  IncrementalCursor,
  QuotaSidebarState,
  QuotaStaleReasonKind,
  QuotaSnapshot,
  RecentProviderEvent,
  SidebarPanelState,
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

function parseQuotaSnapshot(value: unknown): QuotaSnapshot | undefined {
  if (!isRecord(value)) return undefined

  const checkedAt = asNumber(value.checkedAt, 0)
  if (!checkedAt) return undefined

  const status = value.status
  if (
    status !== 'ok' &&
    status !== 'unavailable' &&
    status !== 'unsupported' &&
    status !== 'error'
  ) {
    return undefined
  }

  const label = typeof value.label === 'string' ? value.label : ''
  const adapterID =
    typeof value.adapterID === 'string' ? value.adapterID : undefined
  const shortLabel =
    typeof value.shortLabel === 'string' ? value.shortLabel : undefined
  const sortOrder =
    typeof value.sortOrder === 'number' ? value.sortOrder : undefined
  const balance = isRecord(value.balance)
    ? {
        amount:
          typeof value.balance.amount === 'number' ? value.balance.amount : 0,
        currency:
          typeof value.balance.currency === 'string'
            ? value.balance.currency
            : '$',
      }
    : undefined
  const windows = Array.isArray(value.windows)
    ? value.windows
        .filter((window): window is Record<string, unknown> => isRecord(window))
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
  const stale = isRecord(value.stale)
    ? (() => {
        const staleReasonKind: QuotaStaleReasonKind =
          value.stale.staleReasonKind === 'timeout' ||
          value.stale.staleReasonKind === 'network' ||
          value.stale.staleReasonKind === 'http_5xx' ||
          value.stale.staleReasonKind === 'invalid_response' ||
          value.stale.staleReasonKind === 'unknown'
            ? value.stale.staleReasonKind
            : 'unknown'
        return {
          staleAt:
            typeof value.stale.staleAt === 'number' ? value.stale.staleAt : 0,
          staleReason:
            typeof value.stale.staleReason === 'string'
              ? value.stale.staleReason
              : '',
          staleReasonKind,
        }
      })()
    : undefined

  return {
    providerID: typeof value.providerID === 'string' ? value.providerID : label,
    adapterID,
    label,
    shortLabel,
    sortOrder,
    status,
    checkedAt,
    remainingPercent:
      typeof value.remainingPercent === 'number'
        ? value.remainingPercent
        : undefined,
    usedPercent:
      typeof value.usedPercent === 'number' ? value.usedPercent : undefined,
    resetAt: typeof value.resetAt === 'string' ? value.resetAt : undefined,
    expiresAt:
      typeof value.expiresAt === 'string' ? value.expiresAt : undefined,
    balance,
    note: typeof value.note === 'string' ? value.note : undefined,
    windows,
    stale: stale && stale.staleAt > 0 && stale.staleReason ? stale : undefined,
  }
}

function parseQuotaSnapshots(value: unknown): QuotaSnapshot[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parsed = value
    .map((item) => parseQuotaSnapshot(item))
    .filter((item): item is QuotaSnapshot => Boolean(item))
  return parsed.length > 0 ? parsed : []
}

function parseSidebarPanel(value: unknown): SidebarPanelState | undefined {
  if (!isRecord(value)) return undefined
  const version = asNumber(value.version, 1)
  if (version !== 1) return undefined
  const updatedAt = asNumber(value.updatedAt, 0)
  if (!updatedAt) return undefined
  return {
    version: 1,
    updatedAt,
    usage: parseCachedUsage(value.usage),
    panelQuotas: parseQuotaSnapshots(value.panelQuotas),
    quotas: parseQuotaSnapshots(value.quotas),
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
    sidebarPanel: parseSidebarPanel(value.sidebarPanel),
  }
}

export function parseQuotaCache(value: unknown) {
  const raw = isRecord(value) ? value : {}
  return Object.entries(raw).reduce<QuotaSidebarState['quotaCache']>(
    (acc, [key, item]) => {
      const parsed = parseQuotaSnapshot(item)
      if (!parsed) return acc
      acc[key] = parsed.label ? parsed : { ...parsed, label: key }
      return acc
    },
    {},
  )
}
