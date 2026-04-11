import { debug, debugError, isRecord, swallow } from '../../helpers.js'
import type {
  QuotaSidebarConfig,
  QuotaSnapshot,
  QuotaWindow,
} from '../../types.js'
import {
  OPENAI_OAUTH_CLIENT_ID,
  asNumber,
  configuredProviderEnabled,
  fetchWithTimeout,
  toIso,
  windowLabel,
} from '../common.js'
import type { QuotaProviderAdapter } from '../types.js'

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return undefined
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as unknown
    return isRecord(payload) ? payload : undefined
  } catch {
    return undefined
  }
}

function extractAccountIdFromJwt(token: string): string | undefined {
  const payload = decodeJwtPayload(token)
  if (!payload) return undefined
  const authClaim = payload['https://api.openai.com/auth']
  if (!isRecord(authClaim)) return undefined
  const accountID = authClaim.chatgpt_account_id
  return typeof accountID === 'string' && accountID ? accountID : undefined
}

function normalizeOpenAIQuotaPercent(value: unknown) {
  const numeric = asNumber(value)
  if (numeric === undefined || Number.isNaN(numeric)) return undefined
  const expanded = numeric > 0 && numeric < 1 ? numeric * 100 : numeric
  if (expanded < 0) return 0
  if (expanded > 100) return 100
  return expanded
}

function windowResetAt(
  win: Record<string, unknown>,
  fallback?: Record<string, unknown>,
) {
  const absolute = toIso(win.reset_at ?? fallback?.reset_at)
  if (absolute) return absolute
  const resetAfterSeconds =
    asNumber(win.reset_after_seconds) ?? asNumber(fallback?.reset_after_seconds)
  if (resetAfterSeconds === undefined || resetAfterSeconds < 0) return undefined
  return new Date(Date.now() + resetAfterSeconds * 1000).toISOString()
}

function parseOpenAIWindow(
  win: Record<string, unknown>,
  fallbackLabel: string,
  labelPrefix = '',
): QuotaWindow | undefined {
  const usedPercent = normalizeOpenAIQuotaPercent(win.used_percent)
  const remainingPercent =
    normalizeOpenAIQuotaPercent(win.remaining_percent) ??
    (usedPercent === undefined ? undefined : 100 - usedPercent)
  if (remainingPercent === undefined) return undefined
  return {
    label: `${labelPrefix}${windowLabel(win, fallbackLabel)}`.trim(),
    remainingPercent,
    usedPercent,
    resetAt: windowResetAt(win),
  }
}

function additionalRateLimitPrefix(
  limitName: unknown,
  meteredFeature: unknown,
) {
  if (meteredFeature === 'codex_bengalfox') return 'Spark '
  if (typeof meteredFeature === 'string' && meteredFeature) return undefined
  if (typeof limitName !== 'string' || !limitName) return undefined
  if (/codex-spark/i.test(limitName)) return 'Spark '
  return undefined
}

async function fetchOpenAIQuota(ctx: {
  providerID: string
  auth:
    | {
        type: 'oauth' | 'api' | 'wellknown'
        access?: string
        refresh?: string
        expires?: number
        accountId?: string
        enterpriseUrl?: string
      }
    | undefined
  config: QuotaSidebarConfig
  updateAuth?: (
    providerID: string,
    auth: {
      type: 'oauth'
      access: string
      refresh: string
      expires: number
      accountId?: string
      enterpriseUrl?: string
    },
  ) => Promise<void>
}): Promise<QuotaSnapshot> {
  const checkedAt = Date.now()
  const base: Pick<
    QuotaSnapshot,
    'providerID' | 'label' | 'adapterID' | 'shortLabel' | 'sortOrder'
  > = {
    providerID: ctx.providerID,
    adapterID: 'openai',
    label: 'OpenAI Codex',
    shortLabel: 'OpenAI',
    sortOrder: 10,
  }

  if (!ctx.auth) {
    return {
      ...base,
      status: 'unavailable',
      checkedAt,
      note: 'auth not found',
    }
  }

  if (ctx.auth.type !== 'oauth') {
    return {
      ...base,
      status: 'unsupported',
      checkedAt,
      note: 'api key auth has no quota endpoint',
    }
  }

  if (typeof ctx.auth.access !== 'string' || !ctx.auth.access) {
    return {
      ...base,
      status: 'unavailable',
      checkedAt,
      note: 'missing oauth access token',
    }
  }

  let access = ctx.auth.access
  let refreshWarning: string | undefined
  if (
    ctx.config.quota.refreshAccessToken &&
    ctx.auth.expires &&
    typeof ctx.auth.refresh === 'string' &&
    ctx.auth.refresh &&
    ctx.auth.expires <= Date.now() + 60_000
  ) {
    const refreshed = await fetchWithTimeout(
      'https://auth.openai.com/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: ctx.auth.refresh,
          client_id: OPENAI_OAUTH_CLIENT_ID,
        }).toString(),
      },
      ctx.config.quota.requestTimeoutMs,
    ).catch(swallow('fetchOpenAIQuota:refresh'))

    if (refreshed?.ok) {
      const payload = await refreshed
        .json()
        .catch(swallow('fetchOpenAIQuota:refreshJson'))
      if (isRecord(payload) && typeof payload.access_token === 'string') {
        access = payload.access_token
        ctx.auth.access = payload.access_token
        ctx.auth.refresh =
          typeof payload.refresh_token === 'string'
            ? payload.refresh_token
            : ctx.auth.refresh
        ctx.auth.expires =
          Date.now() +
          (typeof payload.expires_in === 'number' ? payload.expires_in : 3600) *
            1000

        if (ctx.updateAuth && ctx.auth.refresh && ctx.auth.expires) {
          try {
            await ctx.updateAuth(ctx.providerID, {
              type: 'oauth',
              access: ctx.auth.access,
              refresh: ctx.auth.refresh,
              expires: ctx.auth.expires,
              accountId: ctx.auth.accountId,
              enterpriseUrl: ctx.auth.enterpriseUrl,
            })
            debug('openai oauth token refreshed and persisted')
          } catch (error) {
            debugError('updateAuth:openai', error)
            refreshWarning =
              'token refreshed but failed to persist; using in-memory token'
          }
        }
      }
    }
  }

  const accountId =
    (typeof ctx.auth.accountId === 'string' && ctx.auth.accountId) ||
    extractAccountIdFromJwt(access)

  const headers = new Headers({
    Authorization: `Bearer ${access}`,
    Accept: 'application/json',
    'User-Agent': 'opencode-quota-sidebar',
  })
  if (accountId) {
    headers.set('ChatGPT-Account-Id', accountId)
  }

  const response = await fetchWithTimeout(
    'https://chatgpt.com/backend-api/wham/usage',
    { headers },
    ctx.config.quota.requestTimeoutMs,
  ).catch(swallow('fetchOpenAIQuota:usage'))

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

  const payload = await response.json().catch(swallow('fetchOpenAIQuota:json'))
  if (!isRecord(payload)) {
    return {
      ...base,
      status: 'error',
      checkedAt,
      note: 'invalid response',
    }
  }

  const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : {}
  const primary = isRecord(rateLimit.primary_window)
    ? rateLimit.primary_window
    : {}

  const usedPercent = normalizeOpenAIQuotaPercent(primary.used_percent)
  const remainingPercent =
    normalizeOpenAIQuotaPercent(primary.remaining_percent) ??
    (usedPercent === undefined ? undefined : 100 - usedPercent)
  const resetAt = windowResetAt(primary, rateLimit)

  const windows: QuotaWindow[] = []
  if (remainingPercent !== undefined) {
    const primaryWin = parseOpenAIWindow(primary, '')
    if (primaryWin) windows.push(primaryWin)
  }
  if (isRecord(rateLimit.secondary_window)) {
    const secondaryWin = parseOpenAIWindow(rateLimit.secondary_window, 'Weekly')
    if (secondaryWin) windows.push(secondaryWin)
  }

  const additionalRateLimits = Array.isArray(payload.additional_rate_limits)
    ? payload.additional_rate_limits
    : []
  for (const item of additionalRateLimits) {
    if (!isRecord(item)) continue
    const prefix = additionalRateLimitPrefix(
      item.limit_name,
      item.metered_feature,
    )
    if (!prefix) continue
    const itemRateLimit = isRecord(item.rate_limit)
      ? item.rate_limit
      : undefined
    if (!itemRateLimit) continue
    if (isRecord(itemRateLimit.primary_window)) {
      const primaryWin = parseOpenAIWindow(
        itemRateLimit.primary_window,
        '',
        prefix,
      )
      if (primaryWin) windows.push(primaryWin)
    }
    if (isRecord(itemRateLimit.secondary_window)) {
      const secondaryWin = parseOpenAIWindow(
        itemRateLimit.secondary_window,
        'Weekly',
        prefix,
      )
      if (secondaryWin) windows.push(secondaryWin)
    }
  }

  return {
    ...base,
    status: remainingPercent === undefined ? 'error' : 'ok',
    checkedAt,
    usedPercent,
    remainingPercent,
    resetAt,
    note:
      remainingPercent === undefined ? 'missing quota fields' : refreshWarning,
    windows: windows.length > 0 ? windows : undefined,
  }
}

export const openaiAdapter: QuotaProviderAdapter = {
  id: 'openai',
  label: 'OpenAI Codex',
  shortLabel: 'OpenAI',
  sortOrder: 10,
  matchScore: ({ providerID }) => (providerID === 'openai' ? 80 : 0),
  isEnabled: (config) =>
    configuredProviderEnabled(
      config.quota,
      'openai',
      config.quota.includeOpenAI,
    ),
  fetch: fetchOpenAIQuota,
}
