import { isRecord, swallow } from '../../helpers.js'
import type { QuotaSnapshot, QuotaWindow } from '../../types.js'
import {
  asNumber,
  configuredProviderEnabled,
  fetchWithTimeout,
  sanitizeBaseURL,
  toIso,
} from '../common.js'
import type {
  AuthValue,
  QuotaFetchContext,
  QuotaProviderAdapter,
} from '../types.js'

const ZHIPU_QUOTA_URL = 'https://bigmodel.cn/api/monitor/usage/quota/limit'
const ZHIPU_INTL_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit'

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

function parseBaseURL(value: unknown) {
  const normalized = sanitizeBaseURL(value)
  if (!normalized) return undefined
  try {
    return new URL(normalized)
  } catch {
    return undefined
  }
}

function isZhipuCodingBaseURL(value: unknown) {
  const parsed = parseBaseURL(value)
  if (!parsed || parsed.protocol !== 'https:') return false
  const pathname = parsed.pathname.replace(/\/+$/, '')
  const isKnownHost =
    parsed.host === 'open.bigmodel.cn' || parsed.host === 'api.z.ai'
  if (!isKnownHost) return false
  return pathname === '/api/anthropic' || pathname === '/api/coding/paas/v4'
}

function quotaUrl(baseURL: unknown) {
  const parsed = parseBaseURL(baseURL)
  if (parsed?.host === 'api.z.ai') return ZHIPU_INTL_QUOTA_URL
  return ZHIPU_QUOTA_URL
}

function normalizeUsedPercent(value: unknown) {
  const numeric = asNumber(value)
  if (numeric === undefined || !Number.isFinite(numeric)) return undefined
  if (numeric < 0) return 0
  if (numeric > 100) return 100
  return numeric
}

function tokenWindowLabel(unit: unknown, count: unknown) {
  const unitValue = asNumber(unit)
  const countValue = asNumber(count)
  if (unitValue === 3 && countValue && countValue > 0) {
    return `${Math.round(countValue)}h`
  }
  if (unitValue === 1 && countValue === 7) return 'Weekly'
  if (unitValue === 1 && countValue && countValue > 0) {
    return `${Math.round(countValue)}d`
  }
  if (unitValue === 5 && countValue && countValue > 0) {
    return `${Math.round(countValue)}m`
  }
  return 'Tokens'
}

function formatCountValue(value: number) {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function parseTokenWindow(
  value: Record<string, unknown>,
): QuotaWindow | undefined {
  if (value.type !== 'TOKENS_LIMIT') return undefined
  const usedPercent = normalizeUsedPercent(value.percentage)
  if (usedPercent === undefined) return undefined
  return {
    label: tokenWindowLabel(value.unit, value.number),
    remainingPercent: 100 - usedPercent,
    usedPercent,
    resetAt: toIso(value.nextResetTime),
  }
}

async function fetchZhipuCodingPlanQuota({
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
    adapterID: 'zhipuai-coding-plan',
    label: 'Zhipu Coding Plan',
    shortLabel: 'Zhipu',
    sortOrder: 16,
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
    quotaUrl(providerOptions?.baseURL),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'opencode-quota-sidebar',
      },
    },
    config.quota.requestTimeoutMs,
  ).catch(swallow('fetchZhipuCodingPlanQuota:usage'))

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
    .catch(swallow('fetchZhipuCodingPlanQuota:json'))
  if (!isRecord(payload)) {
    return {
      ...base,
      status: 'error',
      checkedAt,
      note: 'invalid response',
    }
  }

  if (payload.success !== true || asNumber(payload.code) !== 200) {
    return {
      ...base,
      status: 'error',
      checkedAt,
      note:
        typeof payload.msg === 'string' && payload.msg
          ? payload.msg
          : 'quota request failed',
    }
  }

  const data = isRecord(payload.data) ? payload.data : undefined
  const level =
    typeof data?.level === 'string' && data.level
      ? `${data.level.toUpperCase()} plan`
      : undefined
  const limits = Array.isArray(data?.limits)
    ? data.limits.filter((item): item is Record<string, unknown> =>
        isRecord(item),
      )
    : []

  const token = limits
    .map((item) => parseTokenWindow(item))
    .find((value): value is QuotaWindow => Boolean(value))
  const windows = [token].filter((value): value is QuotaWindow =>
    Boolean(value),
  )
  const primary = token || windows[0]

  return {
    ...base,
    status: primary ? 'ok' : 'error',
    checkedAt,
    remainingPercent: primary?.remainingPercent,
    resetAt: primary?.resetAt,
    note: primary ? level : 'missing quota fields',
    windows: windows.length > 0 ? windows : undefined,
  }
}

export const zhipuCodingPlanAdapter: QuotaProviderAdapter = {
  id: 'zhipuai-coding-plan',
  label: 'Zhipu Coding Plan',
  shortLabel: 'Zhipu',
  sortOrder: 16,
  normalizeID: (providerID) =>
    providerID === 'zhipuai-coding-plan' ? 'zhipuai-coding-plan' : undefined,
  matchScore: ({ providerID, providerOptions }) => {
    if (providerID === 'zhipuai-coding-plan') return 100
    return isZhipuCodingBaseURL(providerOptions?.baseURL) ? 95 : 0
  },
  isEnabled: (config) =>
    configuredProviderEnabled(config.quota, 'zhipuai-coding-plan', true),
  fetch: fetchZhipuCodingPlanQuota,
}
