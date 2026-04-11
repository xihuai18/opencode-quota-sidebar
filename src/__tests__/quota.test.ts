import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { createQuotaRuntime } from '../quota.js'
import { toIso } from '../providers/common.js'
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
      wrapQuotaLines: true,
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

function jwtToken(payload: unknown) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`
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

  it('derives ChatGPT account id from OpenAI oauth jwt when auth metadata is missing', async () => {
    const token = jwtToken({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-123',
      },
    })

    setFetch(async (input, init) => {
      assert.equal(String(input), 'https://chatgpt.com/backend-api/wham/usage')
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('ChatGPT-Account-Id'), 'acct-123')
      return jsonResponse({
        rate_limit: {
          primary_window: {
            remaining_percent: 60,
            limit_window_seconds: 18_000,
            reset_at: Math.floor(Date.now() / 1000) + 3600,
          },
        },
      })
    })

    const snapshot = await quota.fetchQuotaSnapshot(
      'openai',
      {
        openai: { type: 'oauth', access: token },
      },
      makeConfig(),
    )

    assert.ok(snapshot)
    assert.equal(snapshot!.status, 'ok')
    assert.equal(snapshot!.remainingPercent, 60)
  })

  it('treats OpenAI used_percent=1 as 1 percent used instead of zero remaining', async () => {
    setFetch(async (input) => {
      assert.equal(String(input), 'https://chatgpt.com/backend-api/wham/usage')
      return jsonResponse({
        rate_limit: {
          primary_window: {
            used_percent: 1,
            limit_window_seconds: 18_000,
            reset_after_seconds: 3600,
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
    assert.equal(snapshot!.remainingPercent, 99)
    assert.equal(snapshot!.windows?.[0]?.remainingPercent, 99)
    assert.ok(snapshot!.resetAt)
    assert.ok(snapshot!.windows?.[0]?.resetAt)
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

  it('uses built-in kimi-for-coding adapter and parses 5h + weekly windows', async () => {
    setFetch(async (input, init) => {
      assert.equal(String(input), 'https://api.kimi.com/coding/v1/usages')
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('authorization'), 'Bearer kimi-key')
      return jsonResponse({
        usage: {
          limit: '100',
          remaining: '74',
          resetTime: '2026-03-26T00:00:00Z',
        },
        limits: [
          {
            window: {
              duration: 300,
              timeUnit: 'TIME_UNIT_MINUTE',
            },
            detail: {
              limit: '100',
              remaining: '85',
              resetTime: '2026-03-20T16:20:00Z',
            },
          },
        ],
      })
    })

    const snapshot = await quota.fetchQuotaSnapshot(
      'kimi-for-coding',
      {
        'kimi-for-coding': { type: 'api', key: 'kimi-key' },
      },
      makeConfig(),
      undefined,
      { apiKey: 'kimi-key' },
    )

    assert.ok(snapshot)
    assert.equal(snapshot!.adapterID, 'kimi-for-coding')
    assert.equal(snapshot!.status, 'ok')
    assert.equal(snapshot!.label, 'Kimi For Coding')
    assert.equal(snapshot!.shortLabel, 'Kimi')
    assert.equal(snapshot!.remainingPercent, 85)
    assert.equal(snapshot!.resetAt, '2026-03-20T16:20:00.000Z')
    assert.ok(snapshot!.windows)
    assert.equal(snapshot!.windows!.length, 2)
    assert.equal(snapshot!.windows![0].label, '5h')
    assert.equal(snapshot!.windows![0].remainingPercent, 85)
    assert.equal(snapshot!.windows![1].label, 'Weekly')
    assert.equal(snapshot!.windows![1].remainingPercent, 74)
  })

  it('returns unavailable for kimi-for-coding when api key is missing', async () => {
    const snapshot = await quota.fetchQuotaSnapshot(
      'kimi-for-coding',
      {},
      makeConfig(),
      undefined,
      {},
    )

    assert.ok(snapshot)
    assert.equal(snapshot!.adapterID, 'kimi-for-coding')
    assert.equal(snapshot!.status, 'unavailable')
    assert.equal(snapshot!.note, 'missing api key')
  })

  it('uses built-in zhipu coding plan adapter and ignores mcp limits', async () => {
    setFetch(async (input, init) => {
      assert.equal(
        String(input),
        'https://bigmodel.cn/api/monitor/usage/quota/limit',
      )
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('authorization'), 'zhipu-key')
      return jsonResponse({
        code: 200,
        msg: 'ok',
        success: true,
        data: {
          level: 'max',
          limits: [
            {
              type: 'TIME_LIMIT',
              unit: 5,
              number: 1,
              usage: 4000,
              remaining: 3937,
              percentage: 1,
              nextResetTime: 1776607898998,
            },
            {
              type: 'TOKENS_LIMIT',
              unit: 3,
              number: 5,
              percentage: 1,
              nextResetTime: 1774720317673,
            },
          ],
        },
      })
    })

    const snapshot = await quota.fetchQuotaSnapshot(
      'zhipuai-coding-plan',
      {
        'zhipuai-coding-plan': { type: 'api', key: 'zhipu-key' },
      },
      makeConfig(),
      undefined,
      { apiKey: 'zhipu-key' },
    )

    assert.ok(snapshot)
    assert.equal(snapshot!.adapterID, 'zhipuai-coding-plan')
    assert.equal(snapshot!.status, 'ok')
    assert.equal(snapshot!.label, 'Zhipu Coding Plan')
    assert.equal(snapshot!.shortLabel, 'Zhipu')
    assert.equal(snapshot!.remainingPercent, 99)
    assert.equal(snapshot!.note, 'MAX plan')
    assert.equal(snapshot!.resetAt, '2026-03-28T17:51:57.673Z')
    assert.ok(snapshot!.windows)
    assert.equal(snapshot!.windows!.length, 1)
    assert.equal(snapshot!.windows![0].label, '5h')
    assert.equal(snapshot!.windows![0].remainingPercent, 99)
  })

  it('uses z.ai quota endpoint when zhipu coding plan baseURL is international', async () => {
    setFetch(async (input) => {
      assert.equal(
        String(input),
        'https://api.z.ai/api/monitor/usage/quota/limit',
      )
      return jsonResponse({
        code: 200,
        msg: 'ok',
        success: true,
        data: {
          limits: [
            {
              type: 'TOKENS_LIMIT',
              unit: 3,
              number: 5,
              percentage: 10,
              nextResetTime: '2026-03-29T01:51:57+08:00',
            },
          ],
        },
      })
    })

    const snapshot = await quota.fetchQuotaSnapshot(
      'openai',
      { openai: { type: 'api', key: 'zhipu-key' } },
      makeConfig(),
      undefined,
      {
        apiKey: 'zhipu-key',
        baseURL: 'https://api.z.ai/api/anthropic',
      },
    )

    assert.ok(snapshot)
    assert.equal(snapshot!.adapterID, 'zhipuai-coding-plan')
    assert.equal(snapshot!.remainingPercent, 90)
  })

  it('uses built-in minimax coding plan adapter and parses 5h + weekly windows', async () => {
    setFetch(async (input, init) => {
      assert.equal(
        String(input),
        'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains',
      )
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('authorization'), 'Bearer minimax-key')
      return jsonResponse({
        base_resp: { status_code: 0, status_msg: 'ok' },
        data: {
          current_subscribe_title: 'Max-极速版',
          model_remains: [
            {
              current_interval_total_count: 100,
              current_interval_usage_count: 84,
              start_time: '2026-03-20T11:20:00Z',
              end_time: '2026-03-20T16:20:00Z',
              current_weekly_total_count: 500,
              current_weekly_usage_count: 320,
              weekly_start_time: '2026-03-17T00:00:00Z',
              weekly_end_time: '2026-03-24T00:00:00Z',
            },
          ],
        },
      })
    })

    const snapshot = await quota.fetchQuotaSnapshot(
      'minimax-cn-coding-plan',
      {
        'minimax-cn-coding-plan': { type: 'api', key: 'minimax-key' },
      },
      makeConfig(),
      undefined,
      { apiKey: 'minimax-key' },
    )

    assert.ok(snapshot)
    assert.equal(snapshot!.adapterID, 'minimax-cn-coding-plan')
    assert.equal(snapshot!.status, 'ok')
    assert.equal(snapshot!.label, 'MiniMax Coding Plan')
    assert.equal(snapshot!.shortLabel, 'MiniMax')
    assert.equal(snapshot!.remainingPercent, 84)
    assert.equal(snapshot!.note, 'Max-极速版')
    assert.equal(snapshot!.resetAt, '2026-03-20T16:20:00.000Z')
    assert.ok(snapshot!.windows)
    assert.equal(snapshot!.windows!.length, 2)
    assert.equal(snapshot!.windows![0].label, '5h')
    assert.equal(snapshot!.windows![0].remainingPercent, 84)
    assert.equal(snapshot!.windows![1].label, 'Weekly')
    assert.equal(snapshot!.windows![1].remainingPercent, 64)
  })

  it('uses minimax international quota endpoint when baseURL is global', async () => {
    setFetch(async (input) => {
      assert.equal(
        String(input),
        'https://www.minimax.io/v1/api/openplatform/coding_plan/remains',
      )
      return jsonResponse({
        data: {
          model_remains: [
            {
              current_interval_total_count: 100,
              current_interval_usage_count: 75,
              start_time: '2026-03-20T11:20:00Z',
              end_time: '2026-03-20T16:20:00Z',
            },
          ],
        },
      })
    })

    const snapshot = await quota.fetchQuotaSnapshot(
      'openai',
      { openai: { type: 'api', key: 'minimax-key' } },
      makeConfig(),
      undefined,
      {
        apiKey: 'minimax-key',
        baseURL: 'https://api.minimax.io/v1',
      },
    )

    assert.ok(snapshot)
    assert.equal(snapshot!.adapterID, 'minimax-cn-coding-plan')
    assert.equal(snapshot!.remainingPercent, 75)
  })

  it('preserves Copilot enterprise provider identity in snapshots', async () => {
    setFetch(async (input) => {
      assert.equal(
        String(input),
        'https://api.github.com/copilot_internal/user',
      )
      return jsonResponse({
        quota_snapshots: {
          premium_interactions: {
            percent_remaining: 66,
            quota_reset_date_utc: '2026-03-01T00:00:00Z',
          },
        },
      })
    })

    const snapshot = await quota.fetchQuotaSnapshot(
      'github-copilot-enterprise',
      {
        'github-copilot-enterprise': { type: 'oauth', access: 'copilot-token' },
      },
      makeConfig(),
    )

    assert.ok(snapshot)
    assert.equal(snapshot!.status, 'ok')
    assert.equal(snapshot!.providerID, 'github-copilot-enterprise')
    assert.equal(snapshot!.label, 'GitHub Copilot Enterprise')
    assert.equal(snapshot!.shortLabel, 'Copilot Ent')
  })

  it('parses Anthropic oauth quota windows correctly', async () => {
    setFetch(async (input, init) => {
      assert.equal(String(input), 'https://api.anthropic.com/api/oauth/usage')
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('authorization'), 'Bearer token')
      assert.equal(headers.get('anthropic-beta'), 'oauth-2025-04-20')
      return jsonResponse({
        five_hour: {
          utilization: 20,
          resets_at: '2026-03-09T16:20:00Z',
        },
        seven_day: {
          utilization: 35,
          resets_at: '2026-03-15T00:00:00Z',
        },
        seven_day_sonnet: {
          utilization: 55,
          resets_at: '2026-03-16T00:00:00Z',
        },
        seven_day_opus: {
          utilization: 40,
          resets_at: '2026-03-17T00:00:00Z',
        },
        seven_day_oauth_apps: {
          utilization: 30,
          resets_at: '2026-03-18T00:00:00Z',
        },
        seven_day_cowork: {
          utilization: 15,
          resets_at: '2026-03-19T00:00:00Z',
        },
      })
    })

    const snapshot = await quota.fetchQuotaSnapshot(
      'anthropic',
      {
        anthropic: { type: 'oauth', access: 'token' },
      },
      makeConfig(),
    )

    assert.ok(snapshot)
    assert.equal(snapshot!.providerID, 'anthropic')
    assert.equal(snapshot!.status, 'ok')
    assert.equal(snapshot!.remainingPercent, 80)
    assert.equal(snapshot!.resetAt, '2026-03-09T16:20:00.000Z')
    assert.ok(snapshot!.windows)
    assert.equal(snapshot!.windows!.length, 6)
    assert.equal(snapshot!.windows![0].label, '5h')
    assert.equal(snapshot!.windows![0].remainingPercent, 80)
    assert.equal(snapshot!.windows![1].label, 'Weekly')
    assert.equal(snapshot!.windows![1].remainingPercent, 65)
    assert.equal(snapshot!.windows![2].label, 'Sonnet 7d')
    assert.equal(snapshot!.windows![2].remainingPercent, 45)
    assert.equal(snapshot!.windows![3].label, 'Opus 7d')
    assert.equal(snapshot!.windows![3].remainingPercent, 60)
    assert.equal(snapshot!.windows![4].label, 'OAuth Apps 7d')
    assert.equal(snapshot!.windows![4].remainingPercent, 70)
    assert.equal(snapshot!.windows![5].label, 'Cowork 7d')
    assert.equal(snapshot!.windows![5].remainingPercent, 85)
  })

  it('ignores null Anthropic model-specific windows when the account does not have them', async () => {
    setFetch(async () =>
      jsonResponse({
        five_hour: {
          utilization: 0,
          resets_at: null,
        },
        seven_day: {
          utilization: 23,
          resets_at: '2026-04-05T12:00:00.465121+00:00',
        },
        seven_day_oauth_apps: null,
        seven_day_opus: null,
        seven_day_sonnet: null,
        seven_day_cowork: null,
      }),
    )

    const snapshot = await quota.fetchQuotaSnapshot(
      'anthropic',
      {
        anthropic: { type: 'oauth', access: 'token' },
      },
      makeConfig(),
    )

    assert.ok(snapshot)
    assert.equal(snapshot!.status, 'ok')
    assert.ok(snapshot!.windows)
    assert.deepEqual(
      snapshot!.windows!.map((window) => window.label),
      ['5h', 'Weekly'],
    )
    assert.equal(snapshot!.windows![0].remainingPercent, 100)
    assert.equal(snapshot!.windows![0].resetAt, undefined)
    assert.equal(snapshot!.windows![1].remainingPercent, 77)
  })

  it('retries Anthropic quota once after a timeout and succeeds', async () => {
    let calls = 0
    setFetch(async () => {
      calls++
      if (calls === 1) {
        const error = new Error('timed out')
        error.name = 'AbortError'
        throw error
      }
      return jsonResponse({
        five_hour: {
          utilization: 20,
          resets_at: '2026-03-09T16:20:00Z',
        },
      })
    })

    const snapshot = await quota.fetchQuotaSnapshot(
      'anthropic',
      {
        anthropic: { type: 'oauth', access: 'token' },
      },
      makeConfig(),
    )

    assert.ok(snapshot)
    assert.equal(calls, 2)
    assert.equal(snapshot!.status, 'ok')
    assert.equal(snapshot!.remainingPercent, 80)
  })

  it('returns timeout when Anthropic retry also fails', async () => {
    let calls = 0
    setFetch(async () => {
      calls++
      const error = new Error('timed out')
      error.name = 'AbortError'
      throw error
    })

    const snapshot = await quota.fetchQuotaSnapshot(
      'anthropic',
      {
        anthropic: { type: 'oauth', access: 'token' },
      },
      makeConfig(),
    )

    assert.ok(snapshot)
    assert.equal(calls, 2)
    assert.equal(snapshot!.status, 'error')
    assert.equal(snapshot!.note, 'timeout')
  })

  it('returns unsupported for anthropic api-key auth', async () => {
    const snapshot = await quota.fetchQuotaSnapshot(
      'anthropic',
      {
        anthropic: { type: 'api', key: 'token' },
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

    assert.equal(quota.quotaCacheKey('kimi-for-coding'), 'kimi-for-coding')

    assert.equal(
      quota.quotaCacheKey('github-copilot-enterprise'),
      'github-copilot:github-copilot-enterprise',
    )

    assert.equal(
      quota.quotaCacheKey('openai', {
        baseURL: 'https://api.example.com/v1',
      }),
      'openai@https://api.example.com/v1',
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
    assert.equal(snapshot!.windows![0].resetLabel, undefined)
    assert.equal(snapshot!.windows![0].resetAt, undefined)
    assert.equal(snapshot!.windows![0].remainingPercent, 175)
    assert.equal(snapshot!.balance?.amount, 258.31)
    assert.equal(snapshot!.expiresAt, '2026-02-27T02:50:08.000Z')
  })

  it('stores earliest expiry separately when multiple RightCode subscriptions differ', async () => {
    setFetch(async () =>
      jsonResponse({
        balance: 10,
        subscriptions: [
          {
            name: 'Codex Plan A',
            total_quota: 60,
            remaining_quota: 45,
            reset_today: false,
            expired_at: '2026-02-27T02:50:08Z',
            available_prefixes: ['/codex'],
          },
          {
            name: 'Codex Plan B',
            total_quota: 60,
            remaining_quota: 45,
            reset_today: false,
            expired_at: '2026-03-01T00:00:00Z',
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
    assert.equal(snapshot!.adapterID, 'rightcode')
    assert.equal(snapshot!.status, 'ok')
    assert.ok(snapshot!.windows)
    assert.equal(snapshot!.windows!.length, 1)
    assert.equal(snapshot!.windows![0].resetLabel, undefined)
    assert.equal(snapshot!.windows![0].resetAt, undefined)
    assert.equal(snapshot!.expiresAt, '2026-02-27T02:50:08.000Z')
    assert.match(snapshot!.note || '', /exp 02-27\+/)
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
