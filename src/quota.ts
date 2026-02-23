import fs from 'node:fs/promises'

import { debug, debugError, isRecord, swallow } from './helpers.js'
import type { QuotaSidebarConfig, QuotaSnapshot, QuotaWindow } from './types.js'

const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

type OAuthAuth = {
  type: 'oauth'
  access?: string
  refresh?: string
  expires?: number
  accountId?: string
  enterpriseUrl?: string
}

type ApiAuth = {
  type: 'api'
  key?: string
}

type WellKnownAuth = {
  type: 'wellknown'
  key?: string
  token?: string
}

type AuthValue = OAuthAuth | ApiAuth | WellKnownAuth

type RefreshedOAuthAuth = {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
}

type AuthUpdate = (
  providerID: string,
  auth: RefreshedOAuthAuth,
) => Promise<void>

async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function asNumber(value: unknown) {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined
  return value
}

export function normalizeProviderID(providerID: string) {
  if (providerID.startsWith('github-copilot')) return 'github-copilot'
  return providerID
}

function normalizePercent(value: unknown) {
  const numeric = asNumber(value)
  if (numeric === undefined) return undefined
  const expanded = numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric
  if (Number.isNaN(expanded)) return undefined
  if (expanded < 0) return 0
  if (expanded > 100) return 100
  return expanded
}

function toIso(value: unknown) {
  if (typeof value === 'string') {
    const time = Date.parse(value)
    if (!Number.isNaN(time)) return new Date(time).toISOString()
    return value
  }
  const number = asNumber(value)
  if (number === undefined) return undefined
  const milliseconds = number > 10_000_000_000 ? number : number * 1000
  return new Date(milliseconds).toISOString()
}

export async function loadAuthMap(authPath: string) {
  const parsed = await fs
    .readFile(authPath, 'utf8')
    .then((value) => JSON.parse(value) as unknown)
    .catch(swallow('loadAuthMap'))

  if (!isRecord(parsed)) return {} as Record<string, AuthValue>

  return Object.entries(parsed).reduce<Record<string, AuthValue>>(
    (acc, [key, value]) => {
      if (!isRecord(value)) return acc
      const type = value.type
      if (type !== 'oauth' && type !== 'api' && type !== 'wellknown') return acc
      acc[key] = value as AuthValue
      return acc
    },
    {},
  )
}

/**
 * Derive a human-readable window label from `limit_window_seconds`.
 * Falls back to estimating from `reset_at` if limit_window_seconds is missing.
 */
function windowLabel(win: Record<string, unknown>, fallback = ''): string {
  // Prefer limit_window_seconds — this is the total window duration
  const limitSec = asNumber(win.limit_window_seconds)
  if (limitSec !== undefined && limitSec > 0) {
    const hours = limitSec / 3600
    if (hours <= 24) return `${Math.round(hours)}h`
    const days = hours / 24
    if (days <= 6) return `${Math.round(days)}d`
    return 'Weekly'
  }
  // Fallback: estimate from reset_at
  const resetAt = win.reset_at
  if (resetAt === undefined || resetAt === null) return fallback
  const resetMs =
    typeof resetAt === 'number'
      ? resetAt > 10_000_000_000
        ? resetAt
        : resetAt * 1000
      : typeof resetAt === 'string'
        ? Date.parse(resetAt as string)
        : NaN
  if (Number.isNaN(resetMs)) return fallback
  const hoursLeft = Math.max(0, (resetMs - Date.now()) / 3_600_000)
  if (hoursLeft <= 12) return `${Math.max(1, Math.round(hoursLeft))}h`
  if (hoursLeft <= 48) return `${Math.round(hoursLeft / 24)}d`
  return 'Weekly'
}

/** Parse a single rate limit window object into a QuotaWindow. */
function parseRateLimitWindow(
  win: Record<string, unknown>,
  fallbackLabel: string,
): QuotaWindow | undefined {
  const winUsed = normalizePercent(win.used_percent)
  const winRemaining =
    normalizePercent(win.remaining_percent) ??
    (winUsed === undefined ? undefined : 100 - winUsed)
  if (winRemaining === undefined) return undefined
  return {
    label: windowLabel(win, fallbackLabel),
    remainingPercent: winRemaining,
    usedPercent: winUsed,
    resetAt: toIso(win.reset_at),
  }
}

async function fetchOpenAIQuota(
  auth: AuthValue | undefined,
  config: QuotaSidebarConfig,
  updateAuth?: AuthUpdate,
): Promise<QuotaSnapshot> {
  const checkedAt = Date.now()
  if (!auth) {
    return {
      providerID: 'openai',
      label: 'OpenAI Codex',
      status: 'unavailable',
      checkedAt,
      note: 'auth not found',
    }
  }

  if (auth.type !== 'oauth') {
    return {
      providerID: 'openai',
      label: 'OpenAI Codex',
      status: 'unsupported',
      checkedAt,
      note: 'api key auth has no quota endpoint',
    }
  }

  if (typeof auth.access !== 'string' || !auth.access) {
    return {
      providerID: 'openai',
      label: 'OpenAI Codex',
      status: 'unavailable',
      checkedAt,
      note: 'missing oauth access token',
    }
  }

  let access = auth.access
  let refreshWarning: string | undefined
  if (
    config.quota.refreshAccessToken &&
    auth.expires &&
    typeof auth.refresh === 'string' &&
    auth.refresh &&
    auth.expires <= Date.now() + 60_000
  ) {
    const refreshed = await fetchWithTimeout(
      'https://auth.openai.com/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: auth.refresh,
          client_id: OPENAI_OAUTH_CLIENT_ID,
        }).toString(),
      },
      config.quota.requestTimeoutMs,
    ).catch(swallow('fetchOpenAIQuota:refresh'))

    if (refreshed?.ok) {
      const payload = await refreshed
        .json()
        .catch(swallow('fetchOpenAIQuota:refreshJson'))
      if (isRecord(payload) && typeof payload.access_token === 'string') {
        access = payload.access_token
        auth.access = payload.access_token
        auth.refresh =
          typeof payload.refresh_token === 'string'
            ? payload.refresh_token
            : auth.refresh
        auth.expires =
          Date.now() +
          (typeof payload.expires_in === 'number' ? payload.expires_in : 3600) *
            1000

        // H4 fix: log and propagate auth persistence failure instead of silently swallowing
        if (updateAuth && auth.refresh && auth.expires) {
          try {
            await updateAuth('openai', {
              type: 'oauth',
              access: auth.access,
              refresh: auth.refresh,
              expires: auth.expires,
              accountId: auth.accountId,
            })
            debug('openai oauth token refreshed and persisted')
          } catch (error) {
            debugError('updateAuth:openai', error)
            // Continue with in-memory token so quota fetch still works.
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

  if (typeof auth.accountId === 'string' && auth.accountId)
    headers.set('ChatGPT-Account-Id', auth.accountId)

  const response = await fetchWithTimeout(
    'https://chatgpt.com/backend-api/wham/usage',
    { headers },
    config.quota.requestTimeoutMs,
  ).catch(swallow('fetchOpenAIQuota:usage'))
  if (!response) {
    return {
      providerID: 'openai',
      label: 'OpenAI Codex',
      status: 'error',
      checkedAt,
      note: 'network request failed',
    }
  }

  if (!response.ok) {
    return {
      providerID: 'openai',
      label: 'OpenAI Codex',
      status: 'error',
      checkedAt,
      note: `http ${response.status}`,
    }
  }

  const payload = await response.json().catch(swallow('fetchOpenAIQuota:json'))
  if (!isRecord(payload)) {
    return {
      providerID: 'openai',
      label: 'OpenAI Codex',
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

  // Build multi-window array
  const windows: QuotaWindow[] = []

  // Primary window (short-term, e.g. 3h/5h)
  if (remainingPercent !== undefined) {
    const primaryWin = parseRateLimitWindow(primary, '')
    if (primaryWin) windows.push(primaryWin)
  }

  // Secondary window (long-term, e.g. weekly) — singular object, not array
  if (isRecord(rateLimit.secondary_window)) {
    const secondaryWin = parseRateLimitWindow(
      rateLimit.secondary_window,
      'Weekly',
    )
    if (secondaryWin) windows.push(secondaryWin)
  }

  return {
    providerID: 'openai',
    label: 'OpenAI Codex',
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

async function fetchCopilotQuota(
  auth: AuthValue | undefined,
  config: QuotaSidebarConfig,
): Promise<QuotaSnapshot> {
  const checkedAt = Date.now()
  if (!auth) {
    return {
      providerID: 'github-copilot',
      label: 'GitHub Copilot',
      status: 'unavailable',
      checkedAt,
      note: 'auth not found',
    }
  }

  if (auth.type !== 'oauth') {
    return {
      providerID: 'github-copilot',
      label: 'GitHub Copilot',
      status: 'unsupported',
      checkedAt,
      note: 'oauth token required',
    }
  }

  if (typeof auth.access !== 'string' || !auth.access) {
    return {
      providerID: 'github-copilot',
      label: 'GitHub Copilot',
      status: 'unavailable',
      checkedAt,
      note: 'missing oauth access token',
    }
  }

  const response = await fetchWithTimeout(
    'https://api.github.com/copilot_internal/user',
    {
      headers: {
        Accept: 'application/json',
        Authorization: `token ${auth.access}`,
        'User-Agent': 'GitHubCopilotChat/0.35.0',
        'Editor-Version': 'vscode/1.107.0',
        'Editor-Plugin-Version': 'copilot-chat/0.35.0',
        'Copilot-Integration-Id': 'vscode-chat',
      },
    },
    config.quota.requestTimeoutMs,
  ).catch(swallow('fetchCopilotQuota'))

  if (!response) {
    return {
      providerID: 'github-copilot',
      label: 'GitHub Copilot',
      status: 'error',
      checkedAt,
      note: 'network request failed',
    }
  }

  if (!response.ok) {
    return {
      providerID: 'github-copilot',
      label: 'GitHub Copilot',
      status: 'error',
      checkedAt,
      note: `http ${response.status}`,
    }
  }

  const payload = await response.json().catch(swallow('fetchCopilotQuota:json'))
  if (!isRecord(payload)) {
    return {
      providerID: 'github-copilot',
      label: 'GitHub Copilot',
      status: 'error',
      checkedAt,
      note: 'invalid response',
    }
  }

  const snapshots = isRecord(payload.quota_snapshots)
    ? payload.quota_snapshots
    : {}
  const premium = isRecord(snapshots.premium_interactions)
    ? snapshots.premium_interactions
    : {}

  const remainingPercent =
    normalizePercent(premium.percent_remaining) ??
    (() => {
      const entitlement = asNumber(premium.entitlement)
      const remaining = asNumber(premium.remaining)
      if (
        entitlement === undefined ||
        remaining === undefined ||
        entitlement <= 0
      )
        return undefined
      return normalizePercent(remaining / entitlement)
    })()

  const resetAt = toIso(premium.quota_reset_date_utc)

  const windows: QuotaWindow[] = []
  if (remainingPercent !== undefined) {
    windows.push({
      label: 'Monthly',
      remainingPercent,
      resetAt,
    })
  }

  return {
    providerID: 'github-copilot',
    label: 'GitHub Copilot',
    status: remainingPercent === undefined ? 'error' : 'ok',
    checkedAt,
    remainingPercent,
    resetAt,
    note: remainingPercent === undefined ? 'missing quota fields' : undefined,
    windows: windows.length > 0 ? windows : undefined,
  }
}

function fetchAnthropicQuota(auth: AuthValue | undefined): QuotaSnapshot {
  const checkedAt = Date.now()
  if (!auth) {
    return {
      providerID: 'anthropic',
      label: 'Anthropic Claude',
      status: 'unavailable',
      checkedAt,
      note: 'auth not found',
    }
  }

  if (auth.type === 'api') {
    return {
      providerID: 'anthropic',
      label: 'Anthropic Claude',
      status: 'unsupported',
      checkedAt,
      note: 'api key has no public quota endpoint',
    }
  }

  return {
    providerID: 'anthropic',
    label: 'Anthropic Claude',
    status: 'unsupported',
    checkedAt,
    note: 'oauth quota endpoint is not publicly documented',
  }
}

export async function fetchQuotaSnapshot(
  providerID: string,
  authMap: Record<string, AuthValue>,
  config: QuotaSidebarConfig,
  updateAuth?: AuthUpdate,
) {
  const normalized = normalizeProviderID(providerID)
  if (normalized === 'openai') {
    if (!config.quota.includeOpenAI) return undefined
    return fetchOpenAIQuota(authMap.openai, config, updateAuth)
  }

  if (normalized === 'github-copilot') {
    if (!config.quota.includeCopilot) return undefined
    const auth =
      authMap[providerID] ||
      authMap[normalized] ||
      authMap['github-copilot-enterprise']
    return fetchCopilotQuota(auth, config)
  }

  if (normalized === 'anthropic') {
    if (!config.quota.includeAnthropic) return undefined
    return fetchAnthropicQuota(authMap.anthropic)
  }

  return undefined
}
