import type { QuotaSnapshot, QuotaWindow } from '../../types.js'
import {
  asRecord,
  configuredProviderEnabled,
  fetchWithTimeout,
  normalizePercent,
  toIso,
} from '../common.js'
import type { QuotaFetchContext, QuotaProviderAdapter } from '../types.js'

const ANTHROPIC_OAUTH_USAGE_BETA = 'oauth-2025-04-20'

const ANTHROPIC_WINDOW_FIELDS = [
  ['five_hour', '5h'],
  ['seven_day', 'Weekly'],
  ['seven_day_sonnet', 'Sonnet 7d'],
  ['seven_day_opus', 'Opus 7d'],
  ['seven_day_oauth_apps', 'OAuth Apps 7d'],
  ['seven_day_cowork', 'Cowork 7d'],
] as const

function parseAnthropicWindow(value: unknown, label: string) {
  const win = asRecord(value)
  if (!win) return undefined

  const usedPercent = normalizePercent(win.utilization)
  if (usedPercent === undefined) return undefined

  const parsed: QuotaWindow = {
    label,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetAt: toIso(win.resets_at),
  }
  return parsed
}

function anthropicFetchErrorNote(error: unknown) {
  if (error instanceof Error && error.name === 'AbortError') {
    return 'timeout'
  }
  return 'network request failed'
}

async function fetchAnthropicUsage(
  accessToken: string,
  timeoutMs: number,
): Promise<{ response?: Response; errorNote?: string }> {
  let lastErrorNote: string | undefined

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchWithTimeout(
        'https://api.anthropic.com/api/oauth/usage',
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'opencode-quota-sidebar',
            'anthropic-beta': ANTHROPIC_OAUTH_USAGE_BETA,
          },
        },
        timeoutMs,
      )

      if (response.ok || response.status < 500 || attempt > 0) {
        return { response }
      }
      lastErrorNote = `http ${response.status}`
    } catch (error) {
      lastErrorNote = anthropicFetchErrorNote(error)
    }
  }

  return { errorNote: lastErrorNote || 'network request failed' }
}

async function fetchAnthropicQuota({
  providerID,
  auth,
  config,
}: QuotaFetchContext): Promise<QuotaSnapshot> {
  const checkedAt = Date.now()
  const base: Pick<
    QuotaSnapshot,
    'providerID' | 'adapterID' | 'label' | 'shortLabel' | 'sortOrder'
  > = {
    providerID,
    adapterID: 'anthropic',
    label: 'Anthropic',
    shortLabel: 'Anthropic',
    sortOrder: 30,
  }

  if (!auth) {
    return {
      ...base,
      status: 'unavailable',
      checkedAt,
      note: 'auth not found',
    }
  }

  if (auth.type !== 'oauth') {
    return {
      ...base,
      status: 'unsupported',
      checkedAt,
      note: 'api key auth has no quota endpoint',
    }
  }

  if (typeof auth.access !== 'string' || !auth.access) {
    return {
      ...base,
      status: 'unavailable',
      checkedAt,
      note: 'missing oauth access token',
    }
  }

  const { response, errorNote } = await fetchAnthropicUsage(
    auth.access,
    config.quota.requestTimeoutMs,
  )

  if (!response) {
    return {
      ...base,
      status: 'error',
      checkedAt,
      note: errorNote || 'network request failed',
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

  const payload = await response.json().catch(() => undefined)
  const usage = asRecord(payload)
  if (!usage) {
    return {
      ...base,
      status: 'error',
      checkedAt,
      note: 'invalid response',
    }
  }

  const windows = ANTHROPIC_WINDOW_FIELDS.map(([field, label]) =>
    parseAnthropicWindow(usage[field], label),
  ).filter((window): window is QuotaWindow => Boolean(window))

  const primary = windows[0]
  return {
    ...base,
    status: primary ? 'ok' : 'error',
    checkedAt,
    usedPercent: primary?.usedPercent,
    remainingPercent: primary?.remainingPercent,
    resetAt: primary?.resetAt,
    note: primary ? undefined : 'missing quota fields',
    windows: windows.length > 0 ? windows : undefined,
  }
}

export const anthropicAdapter: QuotaProviderAdapter = {
  id: 'anthropic',
  label: 'Anthropic',
  shortLabel: 'Anthropic',
  sortOrder: 30,
  matchScore: ({ providerID }) => (providerID === 'anthropic' ? 80 : 0),
  isEnabled: (config) =>
    configuredProviderEnabled(
      config.quota,
      'anthropic',
      config.quota.includeAnthropic,
    ),
  fetch: fetchAnthropicQuota,
}
