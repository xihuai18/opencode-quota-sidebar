import fs from 'node:fs/promises'

import type { QuotaSidebarConfig, QuotaSnapshot } from './types.js'

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function normalizeProviderID(providerID: string) {
  if (providerID.startsWith('github-copilot')) return 'github-copilot'
  return providerID
}

function asNumber(value: unknown) {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined
  return value
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
    .catch(() => undefined)

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

async function fetchOpenAIQuota(
  auth: AuthValue | undefined,
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

  if (!auth.access) {
    return {
      providerID: 'openai',
      label: 'OpenAI Codex',
      status: 'unavailable',
      checkedAt,
      note: 'missing oauth access token',
    }
  }

  let access = auth.access
  if (auth.expires && auth.refresh && auth.expires <= Date.now() + 60_000) {
    const refreshed = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: auth.refresh,
        client_id: OPENAI_OAUTH_CLIENT_ID,
      }).toString(),
    }).catch(() => undefined)

    if (refreshed?.ok) {
      const payload = await refreshed.json().catch(() => undefined)
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

        if (updateAuth && auth.refresh && auth.expires) {
          await updateAuth('openai', {
            type: 'oauth',
            access: auth.access,
            refresh: auth.refresh,
            expires: auth.expires,
            accountId: auth.accountId,
          }).catch(() => undefined)
        }
      }
    }
  }

  const headers = new Headers({
    Authorization: `Bearer ${access}`,
    Accept: 'application/json',
    'User-Agent': 'opencode-quota-sidebar',
  })

  if (auth.accountId) headers.set('ChatGPT-Account-Id', auth.accountId)

  const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers,
  }).catch(() => undefined)
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

  const payload = await response.json().catch(() => undefined)
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

  return {
    providerID: 'openai',
    label: 'OpenAI Codex',
    status: remainingPercent === undefined ? 'error' : 'ok',
    checkedAt,
    usedPercent,
    remainingPercent,
    resetAt,
    note: remainingPercent === undefined ? 'missing quota fields' : undefined,
  }
}

async function fetchCopilotQuota(
  auth: AuthValue | undefined,
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

  if (!auth.access) {
    return {
      providerID: 'github-copilot',
      label: 'GitHub Copilot',
      status: 'unavailable',
      checkedAt,
      note: 'missing oauth access token',
    }
  }

  const response = await fetch('https://api.github.com/copilot_internal/user', {
    headers: {
      Accept: 'application/json',
      Authorization: `token ${auth.access}`,
      'User-Agent': 'opencode-quota-sidebar',
      'Editor-Version': 'opencode/1.0.0',
      'Editor-Plugin-Version': 'opencode-quota-sidebar/0.1.0',
    },
  }).catch(() => undefined)

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

  const payload = await response.json().catch(() => undefined)
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

  return {
    providerID: 'github-copilot',
    label: 'GitHub Copilot',
    status: remainingPercent === undefined ? 'error' : 'ok',
    checkedAt,
    remainingPercent,
    resetAt,
    note: remainingPercent === undefined ? 'missing quota fields' : undefined,
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
    return fetchOpenAIQuota(authMap.openai, updateAuth)
  }

  if (normalized === 'github-copilot') {
    if (!config.quota.includeCopilot) return undefined
    const auth =
      authMap[providerID] ||
      authMap[normalized] ||
      authMap['github-copilot-enterprise']
    return fetchCopilotQuota(auth)
  }

  if (normalized === 'anthropic') {
    if (!config.quota.includeAnthropic) return undefined
    return fetchAnthropicQuota(authMap.anthropic)
  }

  return undefined
}
