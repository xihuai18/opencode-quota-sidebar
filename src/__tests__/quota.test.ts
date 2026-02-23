import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { fetchQuotaSnapshot, normalizeProviderID } from '../quota.js'
import type { QuotaSidebarConfig } from '../types.js'

function makeConfig(
  overrides: Partial<QuotaSidebarConfig['quota']> = {},
): QuotaSidebarConfig {
  return {
    sidebar: {
      enabled: true,
      width: 36,
      showCost: true,
      showQuota: true,
      maxQuotaProviders: 2,
    },
    quota: {
      refreshMs: 300_000,
      includeOpenAI: true,
      includeCopilot: true,
      includeAnthropic: true,
      refreshAccessToken: false,
      requestTimeoutMs: 8_000,
      ...overrides,
    },
    toast: { durationMs: 12_000 },
    retentionDays: 730,
  }
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const originalFetch = globalThis.fetch
const setFetch = (next: typeof fetch) => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = next
}

afterEach(() => {
  setFetch(originalFetch)
})

describe('normalizeProviderID', () => {
  it('normalizes copilot variants', () => {
    assert.equal(
      normalizeProviderID('github-copilot-enterprise'),
      'github-copilot',
    )
    assert.equal(normalizeProviderID('github-copilot'), 'github-copilot')
    assert.equal(normalizeProviderID('openai'), 'openai')
  })
})

describe('fetchQuotaSnapshot', () => {
  it('parses OpenAI multi-window quota correctly', async () => {
    setFetch(async (input) => {
      assert.equal(String(input), 'https://chatgpt.com/backend-api/wham/usage')
      return jsonResponse({
        rate_limit: {
          primary_window: {
            used_percent: 20,
            limit_window_seconds: 18_000,
            reset_at: Math.floor(Date.now() / 1000) + 3600,
          },
          secondary_window: {
            remaining_percent: 70,
            limit_window_seconds: 604_800,
            reset_at: Math.floor(Date.now() / 1000) + 86_400,
          },
        },
      })
    })

    const snapshot = await fetchQuotaSnapshot(
      'openai',
      {
        openai: { type: 'oauth', access: 'access-token' },
      },
      makeConfig(),
    )

    assert.ok(snapshot)
    assert.equal(snapshot!.status, 'ok')
    assert.equal(snapshot!.providerID, 'openai')
    assert.equal(snapshot!.remainingPercent, 80)
    assert.ok(snapshot!.windows)
    assert.equal(snapshot!.windows!.length, 2)
    assert.equal(snapshot!.windows![0].label, '5h')
    assert.equal(snapshot!.windows![0].remainingPercent, 80)
    assert.equal(snapshot!.windows![1].label, 'Weekly')
    assert.equal(snapshot!.windows![1].remainingPercent, 70)
  })

  it('keeps OpenAI quota fetch working when token refresh persistence fails', async () => {
    let calls = 0
    setFetch(async (input) => {
      calls += 1
      const url = String(input)
      if (url === 'https://auth.openai.com/oauth/token') {
        return jsonResponse({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        })
      }
      if (url === 'https://chatgpt.com/backend-api/wham/usage') {
        return jsonResponse({
          rate_limit: {
            primary_window: {
              remaining_percent: 60,
              limit_window_seconds: 18_000,
              reset_at: Math.floor(Date.now() / 1000) + 1800,
            },
          },
        })
      }
      throw new Error(`unexpected url: ${url}`)
    })

    const snapshot = await fetchQuotaSnapshot(
      'openai',
      {
        openai: {
          type: 'oauth',
          access: 'expired-access',
          refresh: 'refresh-token',
          expires: Date.now() - 1,
        },
      },
      makeConfig({ refreshAccessToken: true }),
      async () => {
        throw new Error('persist failed')
      },
    )

    assert.equal(calls, 2)
    assert.ok(snapshot)
    assert.equal(snapshot!.status, 'ok')
    assert.equal(snapshot!.remainingPercent, 60)
    assert.match(snapshot!.note || '', /using in-memory token/)
  })

  it('derives Copilot percent from entitlement/remaining when percent is missing', async () => {
    setFetch(async (input) => {
      assert.equal(
        String(input),
        'https://api.github.com/copilot_internal/user',
      )
      return jsonResponse({
        quota_snapshots: {
          premium_interactions: {
            entitlement: 300,
            remaining: 150,
            quota_reset_date_utc: '2026-03-01T00:00:00Z',
          },
        },
      })
    })

    const snapshot = await fetchQuotaSnapshot(
      'github-copilot',
      {
        'github-copilot': { type: 'oauth', access: 'copilot-token' },
      },
      makeConfig(),
    )

    assert.ok(snapshot)
    assert.equal(snapshot!.status, 'ok')
    assert.equal(snapshot!.remainingPercent, 50)
    assert.ok(snapshot!.windows)
    assert.equal(snapshot!.windows![0].label, 'Monthly')
    assert.equal(snapshot!.windows![0].remainingPercent, 50)
  })

  it('returns unsupported for anthropic when auth exists', async () => {
    const snapshot = await fetchQuotaSnapshot(
      'anthropic',
      {
        anthropic: { type: 'oauth', access: 'token' },
      },
      makeConfig(),
    )
    assert.ok(snapshot)
    assert.equal(snapshot!.providerID, 'anthropic')
    assert.equal(snapshot!.status, 'unsupported')
  })

  it('honors includeOpenAI=false', async () => {
    const snapshot = await fetchQuotaSnapshot(
      'openai',
      { openai: { type: 'oauth', access: 'token' } },
      makeConfig({ includeOpenAI: false }),
    )
    assert.equal(snapshot, undefined)
  })

  it('returns error on OpenAI non-2xx response', async () => {
    setFetch(async () => jsonResponse({ message: 'forbidden' }, 403))
    const snapshot = await fetchQuotaSnapshot(
      'openai',
      { openai: { type: 'oauth', access: 'token' } },
      makeConfig(),
    )
    assert.ok(snapshot)
    assert.equal(snapshot!.status, 'error')
    assert.equal(snapshot!.note, 'http 403')
  })
})
