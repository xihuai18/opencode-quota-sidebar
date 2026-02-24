import { debug, debugError, isRecord, swallow } from '../../helpers.js'
import type {
  QuotaSidebarConfig,
  QuotaSnapshot,
  QuotaWindow,
} from '../../types.js'
import {
  OPENAI_OAUTH_CLIENT_ID,
  configuredProviderEnabled,
  fetchWithTimeout,
  normalizePercent,
  parseRateLimitWindow,
  toIso,
} from '../common.js'
import type { QuotaProviderAdapter } from '../types.js'

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

  const headers = new Headers({
    Authorization: `Bearer ${access}`,
    Accept: 'application/json',
    'User-Agent': 'opencode-quota-sidebar',
  })
  if (typeof ctx.auth.accountId === 'string' && ctx.auth.accountId) {
    headers.set('ChatGPT-Account-Id', ctx.auth.accountId)
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

  const usedPercent = normalizePercent(primary.used_percent)
  const remainingPercent =
    normalizePercent(primary.remaining_percent) ??
    (usedPercent === undefined ? undefined : 100 - usedPercent)
  const resetAt = toIso(primary.reset_at ?? rateLimit.reset_at)

  const windows: QuotaWindow[] = []
  if (remainingPercent !== undefined) {
    const primaryWin = parseRateLimitWindow(primary, '')
    if (primaryWin) windows.push(primaryWin)
  }
  if (isRecord(rateLimit.secondary_window)) {
    const secondaryWin = parseRateLimitWindow(
      rateLimit.secondary_window,
      'Weekly',
    )
    if (secondaryWin) windows.push(secondaryWin)
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
