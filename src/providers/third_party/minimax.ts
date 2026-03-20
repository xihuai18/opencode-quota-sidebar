import { isRecord, swallow } from '../../helpers.js'
import type { QuotaSnapshot, QuotaWindow } from '../../types.js'
import {
  asNumber,
  configuredProviderEnabled,
  fetchWithTimeout,
  toIso,
} from '../common.js'
import type {
  AuthValue,
  QuotaFetchContext,
  QuotaProviderAdapter,
} from '../types.js'

function isMiniMaxBaseURL(value: unknown) {
  if (typeof value !== 'string' || !value) return false
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:') return false
    return parsed.host.includes('minimax')
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

async function fetchMiniMaxQuota({
  sourceProviderID,
  providerID,
  providerOptions,
  auth,
  config,
}: QuotaFetchContext): Promise<QuotaSnapshot> {
  const checkedAt = Date.now()
  const runtimeProviderID =
    typeof sourceProviderID === 'string' && sourceProviderID
      ? sourceProviderID
      : providerID

  const base: Pick<
    QuotaSnapshot,
    'providerID' | 'adapterID' | 'label' | 'shortLabel' | 'sortOrder'
  > = {
    providerID: runtimeProviderID,
    adapterID: 'minimax',
    label: 'MiniMax',
    shortLabel: 'MiniMax',
    sortOrder: 35,
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
    'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'opencode-quota-sidebar',
      },
    },
    config.quota.requestTimeoutMs,
  ).catch(swallow('fetchMiniMaxQuota'))

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

  const payload = await response.json().catch(swallow('fetchMiniMaxQuota:json'))
  if (!isRecord(payload)) {
    return {
      ...base,
      status: 'error',
      checkedAt,
      note: 'invalid response',
    }
  }

  const baseResp = payload.base_resp
  if (!isRecord(baseResp) || asNumber((baseResp as Record<string, unknown>).status_code) !== 0) {
    return {
      ...base,
      status: 'error',
      checkedAt,
      note: `api error: ${(baseResp as Record<string, unknown>)?.status_msg ?? 'unknown'}`,
    }
  }

  const modelRemains = Array.isArray(payload.model_remains)
    ? payload.model_remains.find(
        (m: unknown) => isRecord(m) && typeof m.model_name === 'string',
      )
    : undefined

  if (!isRecord(modelRemains)) {
    return {
      ...base,
      status: 'error',
      checkedAt,
      note: 'missing model_remains',
    }
  }

  const windows: QuotaWindow[] = []

  const intervalTotal = asNumber(modelRemains.current_interval_total_count)
  const intervalUsed = asNumber(modelRemains.current_interval_usage_count)
  if (intervalTotal !== undefined && intervalUsed !== undefined && intervalTotal > 0) {
    const remainingPercent = ((intervalTotal - intervalUsed) / intervalTotal) * 100
    const resetAt = toIso(modelRemains.end_time)
    windows.push({
      label: '5h',
      remainingPercent: Math.max(0, remainingPercent),
      usedPercent: (intervalUsed / intervalTotal) * 100,
      resetAt,
    })
  }

  const weeklyTotal = asNumber(modelRemains.current_weekly_total_count)
  const weeklyUsed = asNumber(modelRemains.current_weekly_usage_count)
  if (weeklyTotal !== undefined && weeklyUsed !== undefined && weeklyTotal > 0) {
    const remainingPercent = ((weeklyTotal - weeklyUsed) / weeklyTotal) * 100
    const resetAt = toIso(modelRemains.weekly_end_time)
    windows.push({
      label: 'Weekly',
      remainingPercent: Math.max(0, remainingPercent),
      usedPercent: (weeklyUsed / weeklyTotal) * 100,
      resetAt,
    })
  }

  const primary = windows[0]
  const remainingPercent = primary?.remainingPercent

  return {
    ...base,
    status: remainingPercent === undefined ? 'error' : 'ok',
    checkedAt,
    remainingPercent,
    usedPercent: primary?.usedPercent,
    resetAt: primary?.resetAt,
    windows: windows.length > 0 ? windows : undefined,
    note:
      remainingPercent === undefined
        ? 'missing quota fields'
        : windows.length > 1
          ? `5h + weekly quota`
          : undefined,
  }
}

export const minimaxAdapter: QuotaProviderAdapter = {
  id: 'minimax',
  label: 'MiniMax',
  shortLabel: 'MiniMax',
  sortOrder: 35,
  matchScore: ({ providerID, providerOptions }) => {
    if (isMiniMaxBaseURL(providerOptions?.baseURL)) return 100
    if (providerID && providerID.toLowerCase().includes('minimax')) return 50
    return 0
  },
  isEnabled: (config) =>
    configuredProviderEnabled(config.quota, 'minimax', true),
  fetch: fetchMiniMaxQuota,
}
