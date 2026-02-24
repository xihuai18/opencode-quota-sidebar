import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { createQuotaRuntime } from '../quota.js'
import type { QuotaSidebarConfig } from '../types.js'

const quota = createQuotaRuntime()

function makeConfig(
  overrides: Partial<QuotaSidebarConfig['quota']> = {},
): QuotaSidebarConfig {
  return {
    sidebar: {
      enabled: true,
      width: 36,
      showCost: true,
      showQuota: true,
      includeChildren: true,
      childrenMaxDepth: 6,
      childrenMaxSessions: 128,
      childrenConcurrency: 5,
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
      quota.normalizeProviderID('github-copilot-enterprise'),
      'github-copilot',
    )
    assert.equal(quota.normalizeProviderID('github-copilot'), 'github-copilot')
    assert.equal(quota.normalizeProviderID('openai'), 'openai')
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

    const snapshot = await quota.fetchQuotaSnapshot(
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

    const snapshot = await quota.fetchQuotaSnapshot(
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

    const snapshot = await quota.fetchQuotaSnapshot(
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
    const snapshot = await quota.fetchQuotaSnapshot(
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
    const snapshot = await quota.fetchQuotaSnapshot(
      'openai',
      { openai: { type: 'oauth', access: 'token' } },
      makeConfig({ includeOpenAI: false }),
    )
    assert.equal(snapshot, undefined)
  })

  it('returns error on OpenAI non-2xx response', async () => {
    setFetch(async () => jsonResponse({ message: 'forbidden' }, 403))
    const snapshot = await quota.fetchQuotaSnapshot(
      'openai',
      { openai: { type: 'oauth', access: 'token' } },
      makeConfig(),
    )
    assert.ok(snapshot)
    assert.equal(snapshot!.status, 'error')
    assert.equal(snapshot!.note, 'http 403')
  })

  it('returns undefined for unknown provider', async () => {
    const snapshot = await quota.fetchQuotaSnapshot(
      'unknown-provider',
      {},
      makeConfig(),
    )
    assert.equal(snapshot, undefined)
  })

  it('builds stable quota cache keys', () => {
    assert.equal(quota.quotaCacheKey('openai'), 'openai')
    assert.equal(
      quota.quotaCacheKey('openai', { baseURL: 'https://api.openai.com/v1/' }),
      'openai@https://api.openai.com/v1',
    )
    assert.equal(
      quota.quotaCacheKey('openai', {
        baseURL: 'https://www.right.codes/codex/v1',
      }),
      'rightcode@https://www.right.codes/codex/v1',
    )

    assert.equal(
      quota.quotaCacheKey('rightcode-openai', {
        baseURL: 'https://www.right.codes/codex/v1',
      }),
      'rightcode-openai@https://www.right.codes/codex/v1',
    )

    assert.equal(
      quota.quotaCacheKey('github-copilot-enterprise'),
      'github-copilot:github-copilot-enterprise',
    )
  })

  it('uses RightCode adapter when baseURL points to right.codes and matches subscription prefixes', async () => {
    setFetch(async (input) => {
      assert.equal(String(input), 'https://www.right.codes/account/summary')
      return jsonResponse({
        balance: 258.31,
        subscriptions: [
          {
            name: 'Tiny Badge',
            total_quota: 0.01,
            remaining_quota: 0.01,
            reset_today: false,
            available_prefixes: ['/codex'],
          },
          {
            name: 'Codex Plan',
            total_quota: 60,
            remaining_quota: 45,
            reset_today: false,
            expired_at: '2026-02-27T02:50:08Z',
            available_prefixes: ['/codex'],
          },
        ],
      })
    })

    const snapshot = await quota.fetchQuotaSnapshot(
      'openai',
      {
        openai: { type: 'api', key: 'rc-key' },
      },
      makeConfig({ includeOpenAI: false }),
      undefined,
      { baseURL: 'https://www.right.codes/codex/v1', apiKey: 'rc-key' },
    )

    assert.ok(snapshot)
    assert.equal(snapshot!.adapterID, 'rightcode')
    assert.equal(snapshot!.status, 'ok')
    assert.equal(snapshot!.shortLabel, 'RC')
    assert.ok(snapshot!.windows)
    assert.equal(snapshot!.windows!.length, 1)
    assert.equal(snapshot!.windows![0].label, 'Daily $105/$60')
    assert.equal(snapshot!.windows![0].showPercent, false)
    assert.equal(snapshot!.windows![0].resetLabel, 'Exp')
    assert.equal(snapshot!.windows![0].resetAt, '2026-02-27T02:50:08.000Z')
    assert.equal(snapshot!.windows![0].remainingPercent, 175)
    assert.equal(snapshot!.balance?.amount, 258.31)
  })

  it('falls back to balance for RightCode when subscription prefix does not match', async () => {
    setFetch(async () =>
      jsonResponse({
        balance: 111.25,
        subscriptions: [
          {
            name: 'Other Plan',
            total_quota: 100,
            remaining_quota: 50,
            duration_hours: 720,
            available_prefixes: ['/chat'],
          },
        ],
      }),
    )

    const snapshot = await quota.fetchQuotaSnapshot(
      'openai',
      {
        openai: { type: 'api', key: 'rc-key' },
      },
      makeConfig(),
      undefined,
      { baseURL: 'https://www.right.codes/codex/v1' },
    )

    assert.ok(snapshot)
    assert.equal(snapshot!.adapterID, 'rightcode')
    assert.equal(snapshot!.status, 'ok')
    assert.equal(snapshot!.balance?.amount, 111.25)
    assert.equal(snapshot!.windows, undefined)
  })

  it('uses normal same-day ratio when reset_today is true', async () => {
    setFetch(async () =>
      jsonResponse({
        balance: 999,
        subscriptions: [
          {
            name: 'Codex Plan',
            total_quota: 60,
            remaining_quota: 30,
            reset_today: true,
            available_prefixes: ['/codex'],
          },
        ],
      }),
    )

    const snapshot = await quota.fetchQuotaSnapshot(
      'openai',
      {
        openai: { type: 'api', key: 'rc-key' },
      },
      makeConfig(),
      undefined,
      { baseURL: 'https://www.right.codes/codex/v1' },
    )

    assert.ok(snapshot)
    assert.equal(snapshot!.status, 'ok')
    assert.equal(snapshot!.remainingPercent, 50)
    assert.ok(snapshot!.windows)
    assert.equal(snapshot!.windows![0].label, 'Daily $30/$60')
    assert.equal(snapshot!.windows![0].remainingPercent, 50)
  })

  it('preserves rightcode provider ID for display labeling', async () => {
    setFetch(async () =>
      jsonResponse({
        balance: 1,
        subscriptions: [
          {
            name: 'Codex Plan',
            total_quota: 60,
            remaining_quota: 45,
            reset_today: false,
            expired_at: '2026-02-27T02:50:08Z',
            available_prefixes: ['/codex'],
          },
        ],
      }),
    )

    const snapshot = await quota.fetchQuotaSnapshot(
      'rightcode-openai',
      {
        'rightcode-openai': { type: 'api', key: 'rc-key' },
      },
      makeConfig(),
      undefined,
      { baseURL: 'https://www.right.codes/codex/v1' },
    )

    assert.ok(snapshot)
    assert.equal(snapshot!.adapterID, 'rightcode')
    assert.equal(snapshot!.providerID, 'rightcode-openai')
    assert.equal(snapshot!.shortLabel, 'RC-openai')
  })
})
