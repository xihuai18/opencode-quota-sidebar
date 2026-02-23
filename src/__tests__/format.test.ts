import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderMarkdownReport, renderSidebarTitle } from '../format.js'
import type { QuotaSidebarConfig, QuotaSnapshot } from '../types.js'
import type { UsageSummary } from '../usage.js'

function makeConfig(width = 36): QuotaSidebarConfig {
  return {
    sidebar: {
      enabled: true,
      width,
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
    },
    toast: { durationMs: 12_000 },
    retentionDays: 730,
  }
}

function makeUsage(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    input: 1500,
    output: 1_200_000,
    reasoning: 0,
    cacheRead: 2500,
    cacheWrite: 0,
    total: 1_204_000,
    cost: 0.123,
    assistantMessages: 3,
    sessionCount: 1,
    providers: {},
    ...overrides,
  }
}

describe('renderSidebarTitle', () => {
  it('uses adaptive k/m units for sidebar token lines', () => {
    const title = renderSidebarTitle(
      'Greeting and quick check-in',
      makeUsage(),
      [],
      makeConfig(60),
    )
    assert.match(title, /Input 1\.5k  Output 1\.2m/)
    assert.match(title, /Cache Read 2\.5k/)
  })

  it('renders quota providers on separate lines', () => {
    const quotas: QuotaSnapshot[] = [
      {
        providerID: 'openai',
        label: 'OpenAI Codex',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [
          { label: '5h', remainingPercent: 80 },
          { label: 'Weekly', remainingPercent: 70 },
        ],
      },
      {
        providerID: 'github-copilot',
        label: 'GitHub Copilot',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [{ label: 'Monthly', remainingPercent: 60 }],
      },
    ]

    const title = renderSidebarTitle(
      'Session',
      makeUsage(),
      quotas,
      makeConfig(60),
    )
    const lines = title.split('\n')
    const quotaLines = lines.filter(
      (line) => line.startsWith('OpenAI') || line.startsWith('Copilot'),
    )
    assert.equal(quotaLines.length, 2)
    assert.match(quotaLines[0], /OpenAI 5h 80% - Weekly 70%/)
    assert.match(quotaLines[1], /Copilot Remaining Monthly 60%/)
  })

  it('never emits ANSI escapes and respects width truncation', () => {
    const title = renderSidebarTitle(
      'A very very very long session title',
      makeUsage({ reasoning: 1234, cacheWrite: 999 }),
      [],
      makeConfig(20),
    )
    assert.doesNotMatch(title, /\u001b\[[0-9;]*m/)
    for (const line of title.split('\n')) {
      assert.ok(line.length <= 20)
    }
  })

  it('omits reasoning/cache write lines when value is zero', () => {
    const title = renderSidebarTitle(
      'Session',
      makeUsage({ reasoning: 0, cacheWrite: 0, cacheRead: 0 }),
      [],
      makeConfig(60),
    )
    assert.doesNotMatch(title, /Reasoning/)
    assert.doesNotMatch(title, /Cache Write/)
    assert.doesNotMatch(title, /Cache Read/)
  })

  it('respects sidebar.showQuota=false', () => {
    const config = makeConfig(60)
    config.sidebar.showQuota = false
    const quotas: QuotaSnapshot[] = [
      {
        providerID: 'openai',
        label: 'OpenAI Codex',
        status: 'ok',
        checkedAt: Date.now(),
        remainingPercent: 90,
      },
    ]
    const title = renderSidebarTitle('Session', makeUsage(), quotas, config)
    assert.doesNotMatch(title, /OpenAI/)
  })
})

describe('renderMarkdownReport', () => {
  it('hides cost columns when showCost=false', () => {
    const report = renderMarkdownReport(
      'session',
      makeUsage({
        providers: {
          openai: {
            providerID: 'openai',
            input: 100,
            output: 200,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 300,
            cost: 0.12,
            assistantMessages: 1,
          },
        },
      }),
      [],
      { showCost: false },
    )
    assert.doesNotMatch(report, /\| Cost \|/)
    assert.doesNotMatch(report, /- Cost:/)
  })
})
