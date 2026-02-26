import { isRecord, swallow } from '../../helpers.js'
import type { QuotaSnapshot, QuotaWindow } from '../../types.js'
import {
  asNumber,
  basePathPrefixes,
  configuredProviderEnabled,
  fetchWithTimeout,
  sanitizeBaseURL,
  toIso,
} from '../common.js'
import type { AuthValue, QuotaProviderAdapter } from '../types.js'

function isRightCodeBaseURL(value: unknown) {
  const normalized = sanitizeBaseURL(value)
  if (!normalized) return false
  try {
    const parsed = new URL(normalized)
    if (parsed.protocol !== 'https:') return false
    return parsed.host === 'www.right.codes' || parsed.host === 'right.codes'
  } catch {
    return false
  }
}

function resolveApiKey(
  auth: AuthValue | undefined,
  providerOptions: Record<string, unknown> | undefined,
) {
  const optionKey = providerOptions?.apiKey
  if (typeof optionKey === 'string' && optionKey) return optionKey
  if (!auth) return undefined
  if (auth.type === 'api' && typeof auth.key === 'string' && auth.key) {
    return auth.key
  }
  if (auth.type === 'wellknown') {
    if (typeof auth.key === 'string' && auth.key) return auth.key
    if (typeof auth.token === 'string' && auth.token) return auth.token
  }
  if (auth.type === 'oauth' && typeof auth.access === 'string' && auth.access) {
    return auth.access
  }
  return undefined
}

function matchesSubscriptionPrefix(
  providerPrefixes: string[],
  availablePrefixes: string[],
) {
  if (providerPrefixes.length === 0 || availablePrefixes.length === 0) {
    return false
  }
  for (const providerPrefix of providerPrefixes) {
    for (const availablePrefix of availablePrefixes) {
      if (providerPrefix === availablePrefix) return true
      if (providerPrefix.startsWith(`${availablePrefix}/`)) return true
    }
  }
  return false
}

type ParsedSubscription = {
  name: string
  dailyTotal: number
  dailyRemaining: number
  remainingPercent?: number
  expiresAt?: string
}

function formatQuotaValue(value: number) {
  if (!Number.isFinite(value)) return '0'
  const rounded = Number(value.toFixed(2))
  return Number.isInteger(rounded) ? `${Math.trunc(rounded)}` : `${rounded}`
}

function parseSubscription(
  value: Record<string, unknown>,
): ParsedSubscription | undefined {
  const total = asNumber(value.total_quota)
  const remaining = asNumber(value.remaining_quota)
  // Ignore tiny/non-primary plans (badges, gifts, etc.).
  if (total === undefined || remaining === undefined || total < 10) {
    return undefined
  }

  // RightCode daily quota semantics:
  // - reset_today=true  => normal same-day ratio: remaining / total
  // - reset_today=false => include today's fresh quota: (remaining + total) / total
  const resetToday = value.reset_today === true
  const dailyRemaining = resetToday ? remaining : remaining + total
  // Intentionally not using normalizePercent(): daily ratio can exceed 100%.
  const remainingPercent = (dailyRemaining / total) * 100

  return {
    name: typeof value.name === 'string' ? value.name : 'Subscription',
    dailyTotal: total,
    dailyRemaining,
    remainingPercent,
    expiresAt: toIso(value.expired_at),
  }
}

function extractPrefixes(value: Record<string, unknown>) {
  const raw = value.available_prefixes
  if (!Array.isArray(raw)) return [] as string[]
  return raw.filter(
    (item): item is string => typeof item === 'string' && !!item,
  )
}

async function fetchRightCodeQuota(ctx: {
  sourceProviderID?: string
  providerID: string
  providerOptions?: Record<string, unknown>
  auth: AuthValue | undefined
  config: {
    quota: {
      requestTimeoutMs: number
    }
  }
}): Promise<QuotaSnapshot> {
  const checkedAt = Date.now()

  const sourceProviderID =
    typeof ctx.sourceProviderID === 'string' && ctx.sourceProviderID
      ? ctx.sourceProviderID
      : ctx.providerID
  const shortLabel = sourceProviderID.startsWith('rightcode-')
    ? `RC-${sourceProviderID.slice('rightcode-'.length)}`
    : 'RC'

  const base: Pick<
    QuotaSnapshot,
    'providerID' | 'adapterID' | 'label' | 'shortLabel' | 'sortOrder'
  > = {
    providerID: sourceProviderID,
    adapterID: 'rightcode',
    label: 'RightCode',
    shortLabel,
    sortOrder: 5,
  }

  const apiKey = resolveApiKey(ctx.auth, ctx.providerOptions)
  if (!apiKey) {
    return {
      ...base,
      status: 'unavailable',
      checkedAt,
      note: 'missing api key',
    }
  }

  const response = await fetchWithTimeout(
    'https://www.right.codes/account/summary',
    {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'opencode-quota-sidebar',
      },
    },
    ctx.config.quota.requestTimeoutMs,
  ).catch(swallow('fetchRightCodeQuota'))

  if (!response) {
    return {
      ...base,
      status: 'error',
      checkedAt,
      note: 'network request failed',
    }
  }

  if (!response.ok) {
    return {
      ...base,
      status: 'error',
      checkedAt,
      note: `http ${response.status}`,
    }
  }

  const payload = await response
    .json()
    .catch(swallow('fetchRightCodeQuota:json'))
  if (!isRecord(payload)) {
    return {
      ...base,
      status: 'error',
      checkedAt,
      note: 'invalid response',
    }
  }

  const balance = asNumber(payload.balance)

  const providerPrefixes = basePathPrefixes(ctx.providerOptions?.baseURL)
  if (providerPrefixes.length === 0) {
    providerPrefixes.push(`/${ctx.providerID}`)
  }

  const subscriptions = Array.isArray(payload.subscriptions)
    ? payload.subscriptions.filter((item): item is Record<string, unknown> =>
        isRecord(item),
      )
    : []

  const matched = subscriptions
    .filter((subscription) => {
      const available = extractPrefixes(subscription)
      return matchesSubscriptionPrefix(providerPrefixes, available)
    })
    .map((subscription) => parseSubscription(subscription))
    .filter((subscription): subscription is ParsedSubscription =>
      Boolean(subscription),
    )

  if (matched.length > 0) {
    const dailyTotal = matched.reduce(
      (sum, subscription) => sum + subscription.dailyTotal,
      0,
    )
    const dailyRemaining = matched.reduce(
      (sum, subscription) => sum + subscription.dailyRemaining,
      0,
    )
    const dailyPercent =
      dailyTotal > 0 ? (dailyRemaining / dailyTotal) * 100 : undefined
    const parsedExpiries = matched
      .map((subscription) => subscription.expiresAt)
      .filter((iso): iso is string => typeof iso === 'string' && !!iso)
      .map((iso) => ({ iso, ts: Date.parse(iso) }))
      .filter((item) => !Number.isNaN(item.ts))

    const uniqueExpiryTimestamps = new Set(parsedExpiries.map((e) => e.ts))
    const hasMultipleExpiries = uniqueExpiryTimestamps.size > 1

    const expiry = parsedExpiries.reduce<string | undefined>((acc, item) => {
      if (!acc) return item.iso
      const existing = Date.parse(acc)
      if (Number.isNaN(existing) || item.ts < existing) return item.iso
      return acc
    }, undefined)

    const windows: QuotaWindow[] = [
      {
        label: `Daily $${formatQuotaValue(dailyRemaining)}/$${formatQuotaValue(dailyTotal)}`,
        showPercent: false,
        remainingPercent: dailyPercent,
        resetAt: expiry,
        resetLabel: hasMultipleExpiries ? 'Exp+' : 'Exp',
      },
    ]

    const names = matched.map((subscription) => subscription.name).join(', ')
    return {
      ...base,
      status: dailyPercent === undefined ? 'error' : 'ok',
      checkedAt,
      remainingPercent: dailyPercent,
      balance:
        balance === undefined
          ? undefined
          : {
              amount: balance,
              currency: '$',
            },
      windows,
      note:
        dailyPercent === undefined
          ? 'matched subscription has no daily quota fields'
          : `subscription daily quota: ${names}`,
    }
  }

  if (balance !== undefined) {
    return {
      ...base,
      status: 'ok',
      checkedAt,
      balance: {
        amount: balance,
        currency: '$',
      },
      note: 'no matching subscription for provider prefix',
    }
  }

  return {
    ...base,
    status: 'error',
    checkedAt,
    note: 'missing balance and subscription fields',
  }
}

export const rightCodeAdapter: QuotaProviderAdapter = {
  id: 'rightcode',
  label: 'RightCode',
  shortLabel: 'RC',
  sortOrder: 5,
  matchScore: ({ providerOptions }) =>
    isRightCodeBaseURL(providerOptions?.baseURL) ? 100 : 0,
  isEnabled: (config) =>
    configuredProviderEnabled(config.quota, 'rightcode', true),
  fetch: fetchRightCodeQuota,
}
