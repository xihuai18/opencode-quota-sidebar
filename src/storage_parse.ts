import { asNumber, isRecord } from './helpers.js'
import type {
  CachedProviderUsage,
  CachedSessionUsage,
  IncrementalCursor,
  QuotaSidebarState,
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
  }
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
    input: asNumber(value.input, 0),
    output: asNumber(value.output, 0),
    reasoning: asNumber(value.reasoning, 0),
    cacheRead: asNumber(value.cacheRead, 0),
    cacheWrite: asNumber(value.cacheWrite, 0),
    total: asNumber(value.total, 0),
    cost: asNumber(value.cost, 0),
    apiCost: asNumber(value.apiCost, 0),
    assistantMessages: asNumber(value.assistantMessages, 0),
    providers,
  }
}

function parseCursor(value: unknown): IncrementalCursor | undefined {
  if (!isRecord(value)) return undefined
  return {
    lastMessageId:
      typeof value.lastMessageId === 'string' ? value.lastMessageId : undefined,
    lastMessageTime: asNumber(value.lastMessageTime),
  }
}

export function parseSessionState(value: unknown): SessionState | undefined {
  if (!isRecord(value)) return undefined
  const title = parseSessionTitleState(value)
  if (!title) return undefined

  const createdAt = asNumber(value.createdAt, 0)
  if (!createdAt) return undefined

  return {
    ...title,
    createdAt,
    usage: parseCachedUsage(value.usage),
    cursor: parseCursor(value.cursor),
  }
}

export function parseSessionTitleForMigration(
  value: unknown,
): SessionTitleState | undefined {
  return parseSessionTitleState(value)
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
        balance,
        note: typeof item.note === 'string' ? item.note : undefined,
        windows,
      }
      return acc
    },
    {},
  )
}
