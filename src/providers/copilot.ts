import { isRecord, swallow } from '../helpers.js'
import type { QuotaSnapshot } from '../types.js'
import {
  asNumber,
  configuredProviderEnabled,
  fetchWithTimeout,
  normalizePercent,
  toIso,
} from './common.js'
import type { QuotaProviderAdapter } from './types.js'

async function fetchCopilotQuota(ctx: {
  providerID: string
  auth:
    | {
        type: 'oauth' | 'api' | 'wellknown'
        access?: string
      }
    | undefined
  config: {
    quota: {
      requestTimeoutMs: number
    }
  }
}): Promise<QuotaSnapshot> {
  const checkedAt = Date.now()
  const base: Pick<
    QuotaSnapshot,
    'providerID' | 'adapterID' | 'label' | 'shortLabel' | 'sortOrder'
  > = {
    providerID: ctx.providerID,
    adapterID: 'github-copilot',
    label: 'GitHub Copilot',
    shortLabel: 'Copilot',
    sortOrder: 20,
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
      note: 'oauth token required',
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

  const response = await fetchWithTimeout(
    'https://api.github.com/copilot_internal/user',
    {
      headers: {
        Accept: 'application/json',
        Authorization: `token ${ctx.auth.access}`,
        'User-Agent': 'GitHubCopilotChat/0.35.0',
        'Editor-Version': 'vscode/1.107.0',
        'Editor-Plugin-Version': 'copilot-chat/0.35.0',
        'Copilot-Integration-Id': 'vscode-chat',
      },
    },
    ctx.config.quota.requestTimeoutMs,
  ).catch(swallow('fetchCopilotQuota'))

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

  const payload = await response.json().catch(swallow('fetchCopilotQuota:json'))
  if (!isRecord(payload)) {
    return {
      ...base,
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
      ) {
        return undefined
      }
      return normalizePercent(remaining / entitlement)
    })()

  const resetAt =
    toIso(payload.quota_reset_date) ?? toIso(premium.quota_reset_date_utc)
  const windows =
    remainingPercent === undefined
      ? undefined
      : [
          {
            label: 'Monthly',
            remainingPercent,
            resetAt,
          },
        ]

  return {
    ...base,
    status: remainingPercent === undefined ? 'error' : 'ok',
    checkedAt,
    remainingPercent,
    resetAt,
    note: remainingPercent === undefined ? 'missing quota fields' : undefined,
    windows,
  }
}

export const copilotAdapter: QuotaProviderAdapter = {
  id: 'github-copilot',
  label: 'GitHub Copilot',
  shortLabel: 'Copilot',
  sortOrder: 20,
  normalizeID: (providerID) =>
    providerID.startsWith('github-copilot') ? 'github-copilot' : undefined,
  matchScore: ({ providerID }) =>
    providerID.startsWith('github-copilot') ? 80 : 0,
  isEnabled: (config) =>
    configuredProviderEnabled(
      config.quota,
      'github-copilot',
      config.quota.includeCopilot,
    ),
  fetch: fetchCopilotQuota,
}
