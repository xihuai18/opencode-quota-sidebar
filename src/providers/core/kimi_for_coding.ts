import { isRecord, swallow } from '../../helpers.js'
import type { QuotaSnapshot, QuotaWindow } from '../../types.js'
import {
  asNumber,
  configuredProviderEnabled,
  fetchWithTimeout,
  sanitizeBaseURL,
  toIso,
} from '../common.js'
import type { AuthValue, QuotaFetchContext, QuotaProviderAdapter } from '../types.js'

const KIMI_FOR_CODING_BASE_URL = 'https://api.kimi.com/coding/v1'

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

function isKimiCodingBaseURL(value: unknown) {
  const normalized = sanitizeBaseURL(value)
  if (!normalized) return false
  try {
    const parsed = new URL(normalized)
    if (parsed.protocol !== 'https:') return false
    const pathname = parsed.pathname.replace(/\/+$/, '')
    return parsed.host === 'api.kimi.com' && pathname === '/coding/v1'
  } catch {
    return false
  }
}

function usagesUrl(baseURL: unknown) {
  const normalized = sanitizeBaseURL(baseURL)
  if (isKimiCodingBaseURL(normalized)) {
    return `${normalized}/usages`
  }
  return `${KIMI_FOR_CODING_BASE_URL}/usages`
}

function percentFromQuota(limit: unknown, remaining: unknown) {
  const total =
    asNumber(limit) ??
    (typeof limit === 'string' && limit.trim() ? Number(limit) : undefined)
  const left =
    asNumber(remaining) ??
    (typeof remaining === 'string' && remaining.trim()
      ? Number(remaining)
      : undefined)
  if (total === undefined || left === undefined || total <= 0) return undefined
  if (!Number.isFinite(total) || !Number.isFinite(left)) return undefined
  return Math.max(0, Math.min(100, (left / total) * 100))
}

function windowLabel(duration: number | undefined, timeUnit: string | undefined) {
  if (timeUnit === 'TIME_UNIT_MINUTE' && duration === 300) return '5h'
  if (timeUnit === 'TIME_UNIT_DAY' && duration === 7) return 'Weekly'
  if (timeUnit === 'TIME_UNIT_MINUTE' && duration && duration > 0) {
    const hours = duration / 60
    if (hours <= 24) return `${Math.round(hours)}h`
  }
  if (timeUnit === 'TIME_UNIT_HOUR' && duration && duration > 0) {
    if (duration <= 24) return `${Math.round(duration)}h`
    const days = duration / 24
    if (days <= 6) return `${Math.round(days)}d`
  }
  if (timeUnit === 'TIME_UNIT_DAY' && duration && duration > 0) {
    if (duration <= 6) return `${Math.round(duration)}d`
    if (duration === 7) return 'Weekly'
  }
  return undefined
}

function parseWindow(value: unknown): QuotaWindow | undefined {
  if (!isRecord(value)) return undefined
  const window = isRecord(value.window) ? value.window : undefined
  const detail = isRecord(value.detail) ? value.detail : undefined
  if (!window || !detail) return undefined

  const duration = asNumber(window.duration)
  const timeUnit =
    typeof window.timeUnit === 'string' ? window.timeUnit : undefined
  const label = windowLabel(duration, timeUnit)
  const remainingPercent = percentFromQuota(detail.limit, detail.remaining)
  if (!label || remainingPercent === undefined) return undefined

  return {
    label,
    remainingPercent,
    resetAt: toIso(detail.resetTime),
  }
}

function dedupeWindows(windows: QuotaWindow[]) {
  const seen = new Set<string>()
  const deduped: QuotaWindow[] = []
  for (const window of windows) {
    const key = `${window.label}|${window.resetAt || ''}|${window.remainingPercent ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(window)
  }
  return deduped
}

async function fetchKimiForCodingQuota({
  providerID,
  providerOptions,
  auth,
  config,
}: QuotaFetchContext): Promise<QuotaSnapshot> {
  const checkedAt = Date.now()
  const base: Pick<
    QuotaSnapshot,
    'providerID' | 'adapterID' | 'label' | 'shortLabel' | 'sortOrder'
  > = {
    providerID,
    adapterID: 'kimi-for-coding',
    label: 'Kimi For Coding',
    shortLabel: 'Kimi',
    sortOrder: 15,
  }

  const apiKey = resolveApiKey(auth, providerOptions)
  if (!apiKey) {
    return {
      ...base,
      status: 'unavailable',
      checkedAt,
      note: 'missing api key',
    }
  }

  const response = await fetchWithTimeout(
    usagesUrl(providerOptions?.baseURL),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'opencode-quota-sidebar',
      },
    },
    config.quota.requestTimeoutMs,
  ).catch(swallow('fetchKimiForCodingQuota:usage'))

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
    .catch(swallow('fetchKimiForCodingQuota:json'))
  if (!isRecord(payload)) {
    return {
      ...base,
      status: 'error',
      checkedAt,
      note: 'invalid response',
    }
  }

  const windows = Array.isArray(payload.limits)
    ? payload.limits.map((item) => parseWindow(item)).filter(Boolean)
    : []

  const usage = isRecord(payload.usage) ? payload.usage : undefined
  const topLevelRemainingPercent = usage
    ? percentFromQuota(usage.limit, usage.remaining)
    : undefined
  const topLevelResetAt = usage ? toIso(usage.resetTime) : undefined

  const allWindows = dedupeWindows(
    [
      ...windows,
      topLevelRemainingPercent !== undefined
        ? {
            label: 'Weekly',
            remainingPercent: topLevelRemainingPercent,
            resetAt: topLevelResetAt,
          }
        : undefined,
    ].filter((value): value is QuotaWindow => Boolean(value)),
  ).sort((left, right) => {
    const order = (label: string) => {
      if (label === '5h') return 0
      if (label === 'Weekly') return 1
      return 2
    }
    return order(left.label) - order(right.label)
  })

  const primary = allWindows[0]
  return {
    ...base,
    status: primary ? 'ok' : 'error',
    checkedAt,
    remainingPercent: primary?.remainingPercent,
    resetAt: primary?.resetAt,
    note: primary ? undefined : 'missing quota fields',
    windows: allWindows.length > 0 ? allWindows : undefined,
  }
}

export const kimiForCodingAdapter: QuotaProviderAdapter = {
  id: 'kimi-for-coding',
  label: 'Kimi For Coding',
  shortLabel: 'Kimi',
  sortOrder: 15,
  normalizeID: (providerID) =>
    providerID === 'kimi-for-coding' ? 'kimi-for-coding' : undefined,
  matchScore: ({ providerID, providerOptions }) => {
    if (providerID === 'kimi-for-coding') return 100
    return isKimiCodingBaseURL(providerOptions?.baseURL) ? 95 : 0
  },
  isEnabled: (config) =>
    configuredProviderEnabled(config.quota, 'kimi-for-coding', true),
  fetch: fetchKimiForCodingQuota,
}
