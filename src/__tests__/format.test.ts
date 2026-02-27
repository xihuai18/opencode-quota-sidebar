import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  renderMarkdownReport,
  renderSidebarTitle,
  renderToastMessage,
} from '../format.js'
import type { QuotaSidebarConfig, QuotaSnapshot } from '../types.js'
import type { UsageSummary } from '../usage.js'

function makeConfig(width = 36): QuotaSidebarConfig {
  return {
    sidebar: {
      enabled: true,
      width,
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
    apiCost: overrides.apiCost ?? 2.34,
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
    assert.match(title, /\$2\.34 as API cost/)
    assert.match(title, /Cache Read 2\.5k/)
  })

  it('renders API cost as the last token detail line', () => {
    const title = renderSidebarTitle(
      'Session',
      makeUsage({ cacheRead: 2500, cacheWrite: 300 }),
      [],
      makeConfig(60),
    )
    const lines = title.split('\n')
    const cacheReadIndex = lines.findIndex((line) =>
      line.startsWith('Cache Read'),
    )
    const cacheWriteIndex = lines.findIndex((line) =>
      line.startsWith('Cache Write'),
    )
    const costIndex = lines.findIndex((line) => /as API cost$/.test(line))

    assert.ok(cacheReadIndex >= 0)
    assert.ok(cacheWriteIndex >= 0)
    assert.ok(costIndex > cacheReadIndex)
    assert.ok(costIndex > cacheWriteIndex)
  })

  it('hides API cost line when sidebar.showCost=false', () => {
    const config = makeConfig(60)
    config.sidebar.showCost = false
    const title = renderSidebarTitle('Session', makeUsage(), [], config)
    assert.doesNotMatch(title, /as API cost/)
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
    const openAIIndex = lines.findIndex((line) => line.startsWith('OpenAI'))
    assert.ok(openAIIndex >= 0)
    assert.match(lines[openAIIndex], /^OpenAI\s+5h 80%$/)
    assert.match(lines[openAIIndex + 1], /^\s+Weekly 70%$/)
    assert.ok(lines.some((line) => /^Copilot\s+Monthly 60%$/.test(line)))
  })

  it('adds blank line between title/tokens and tokens/quota', () => {
    const quotas: QuotaSnapshot[] = [
      {
        providerID: 'openai',
        label: 'OpenAI Codex',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [{ label: '5h', remainingPercent: 80 }],
      },
    ]

    const title = renderSidebarTitle(
      'Session',
      makeUsage(),
      quotas,
      makeConfig(60),
    )
    const lines = title.split('\n')

    assert.equal(lines[1], '')

    const firstQuotaIndex = lines.findIndex((line) => line.startsWith('OpenAI'))
    assert.ok(firstQuotaIndex > 0)
    assert.equal(lines[firstQuotaIndex - 1], '')
  })

  it('never emits ANSI escapes and respects width truncation', () => {
    const title = renderSidebarTitle(
      'A very very very long session title',
      makeUsage({ reasoning: 1234, cacheWrite: 999 }),
      [],
      makeConfig(20),
    )
    assert.doesNotMatch(title, /\u001b/)
    for (const line of title.split('\n')) {
      assert.ok(line.length <= 20)
    }
  })

  it('strips ANSI from base title', () => {
    const title = renderSidebarTitle(
      '\u001b[2mSession\u001b[0m',
      makeUsage(),
      [],
      makeConfig(60),
    )
    assert.doesNotMatch(title, /\u001b/)
    assert.equal(title.split('\n')[0], 'Session')
  })

  it('truncates base title by terminal cell width (CJK safe)', () => {
    const title = renderSidebarTitle(
      '你好你好你好',
      makeUsage(),
      [],
      // Sidebar width is clamped to a safe minimum (8).
      makeConfig(8),
    )
    assert.equal(title.split('\n')[0], '你好你~')
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

  it('never renders a separate reasoning line', () => {
    const title = renderSidebarTitle(
      'Session',
      makeUsage({ reasoning: 1234 }),
      [],
      makeConfig(60),
    )
    assert.doesNotMatch(title, /Reasoning/)
  })

  it('respects sidebar.showQuota=false', () => {
    const config = makeConfig(60)
    config.sidebar.showQuota = false
    config.sidebar.wrapQuotaLines = false
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

  it('renders balance-style quota lines', () => {
    const quotas: QuotaSnapshot[] = [
      {
        providerID: 'openai',
        adapterID: 'rightcode',
        label: 'RightCode',
        shortLabel: 'RC',
        status: 'ok',
        checkedAt: Date.now(),
        balance: {
          amount: 258.31,
          currency: '$',
        },
      },
    ]
    const title = renderSidebarTitle(
      'Session',
      makeUsage(),
      quotas,
      makeConfig(60),
    )
    assert.match(title, /RC Balance \$258\.31/)
  })

  it('renders reset time and indented multi-window lines', () => {
    const now = new Date()
    const sameDayReset = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      16,
      20,
      0,
      0,
    ).toISOString()
    const weeklyReset = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 7,
      12,
      0,
      0,
      0,
    ).toISOString()
    const quotas: QuotaSnapshot[] = [
      {
        providerID: 'openai',
        label: 'OpenAI Codex',
        shortLabel: 'OpenAI',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [
          { label: '5h', remainingPercent: 80, resetAt: sameDayReset },
          { label: 'Weekly', remainingPercent: 70, resetAt: weeklyReset },
        ],
      },
    ]

    const title = renderSidebarTitle(
      'Session',
      makeUsage(),
      quotas,
      makeConfig(60),
    )
    const lines = title.split('\n')
    const first = lines.find((line) => line.startsWith('OpenAI 5h 80% Rst '))
    assert.ok(first)
    assert.match(first!, /^OpenAI\s+5h 80% Rst \d{2}:\d{2}$/)
    const second = lines.find((line) =>
      /^\s+Weekly 70% Rst \d{2}-\d{2}$/.test(line),
    )
    assert.ok(second)
  })

  it('renders RightCode daily quota without trailing percent and shows balance', () => {
    const quotas: QuotaSnapshot[] = [
      {
        providerID: 'openai',
        adapterID: 'rightcode',
        label: 'RightCode',
        shortLabel: 'RC',
        status: 'ok',
        checkedAt: Date.now(),
        balance: {
          amount: 259.97,
          currency: '$',
        },
        windows: [
          {
            label: 'Daily $88.88/$60',
            showPercent: false,
            remainingPercent: 148,
            resetAt: '2026-02-27T02:50:08Z',
            resetLabel: 'Exp',
          },
        ],
      },
    ]

    const title = renderSidebarTitle(
      'Session',
      makeUsage(),
      quotas,
      makeConfig(60),
    )
    assert.match(title, /RC\s+Daily \$88\.88\/\$60 Exp 02-27/)
    assert.match(title, /\s+Balance \$259\.97/)
    assert.doesNotMatch(title, /RC\s+Daily \$88\.88\/\$60\s+148%/)
  })

  it('renders Exp+ for RightCode when multiple expiries exist', () => {
    const quotas: QuotaSnapshot[] = [
      {
        providerID: 'openai',
        adapterID: 'rightcode',
        label: 'RightCode',
        shortLabel: 'RC',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [
          {
            label: 'Daily $88.88/$60',
            showPercent: false,
            resetAt: '2026-02-27T02:50:08Z',
            resetLabel: 'Exp+',
          },
        ],
      },
    ]

    const title = renderSidebarTitle(
      'Session',
      makeUsage(),
      quotas,
      makeConfig(60),
    )
    assert.match(title, /RC\s+Daily \$88\.88\/\$60 Exp\+ 02-27/)
  })

  it('shows all used providers in sidebar', () => {
    const config = makeConfig(60)
    const quotas: QuotaSnapshot[] = [
      {
        providerID: 'openai',
        label: 'OpenAI Codex',
        shortLabel: 'OpenAI',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [{ label: '5h', remainingPercent: 80 }],
      },
      {
        providerID: 'github-copilot',
        label: 'GitHub Copilot',
        shortLabel: 'Copilot',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [{ label: 'Monthly', remainingPercent: 60 }],
      },
      {
        providerID: 'openai',
        adapterID: 'rightcode',
        label: 'RightCode',
        shortLabel: 'RC',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [{ label: 'Daily $88/$60', showPercent: false }],
      },
    ]
    const title = renderSidebarTitle('Session', makeUsage(), quotas, config)
    assert.match(title, /OpenAI\s+5h 80%/)
    assert.match(title, /Copilot\s+Monthly 60%/)
    assert.match(title, /RC\s+Daily \$88\/\$60/)
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
            apiCost: 0.34,
            assistantMessages: 1,
          },
        },
      }),
      [],
      { showCost: false },
    )
    assert.doesNotMatch(report, /\| Cost \|/)
    assert.doesNotMatch(report, /Measured cost/)
  })

  it('renders API cost with two decimals when showCost=true', () => {
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
            apiCost: 0.3456,
            assistantMessages: 1,
          },
          'github-copilot': {
            providerID: 'github-copilot',
            input: 10,
            output: 20,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 30,
            cost: 0.01,
            apiCost: 0.02,
            assistantMessages: 1,
          },
        },
      }),
      [],
      { showCost: true },
    )
    assert.match(report, /API cost: \$2\.34/)
    assert.match(report, /Measured cost: -/)
    assert.match(
      report,
      /\| Provider \| Input \| Output \| Cache \| Total \| Measured Cost \| API Cost \|/,
    )
    assert.match(
      report,
      /\| openai \| 100 \| 200 \| 0 \| 300 \| - \| \$0\.35 \|/,
    )
    assert.match(
      report,
      /\| github-copilot \| 10 \| 20 \| 0 \| 30 \| - \| - \|/,
    )
  })

  it('uses N/A values when only Copilot usage exists', () => {
    const report = renderMarkdownReport(
      'session',
      makeUsage({
        cost: 0,
        apiCost: 0,
        providers: {
          'github-copilot': {
            providerID: 'github-copilot',
            input: 10,
            output: 20,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 30,
            cost: 0,
            apiCost: 0,
            assistantMessages: 1,
          },
        },
      }),
      [],
      { showCost: true },
    )
    assert.match(report, /Measured cost: -/)
    assert.match(report, /API cost: -/)
  })

  it('treats RightCode daily window providers as subscription for measured cost', () => {
    const report = renderMarkdownReport(
      'session',
      makeUsage({
        cost: 1.2345,
        apiCost: 2.34,
        providers: {
          'rightcode-openai': {
            providerID: 'rightcode-openai',
            input: 100,
            output: 200,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 300,
            cost: 9.876,
            apiCost: 4.567,
            assistantMessages: 1,
          },
        },
      }),
      [
        {
          providerID: 'rightcode-openai',
          adapterID: 'rightcode',
          label: 'RightCode',
          shortLabel: 'RC-openai',
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: 'Daily $55.55/$60', showPercent: false }],
        },
      ],
      { showCost: true },
    )

    assert.match(
      report,
      /\| rightcode-openai \| 100 \| 200 \| 0 \| 300 \| - \| \$4\.57 \|/,
    )
  })

  it('does not treat RightCode balance-only providers as subscription for measured cost', () => {
    const report = renderMarkdownReport(
      'session',
      makeUsage({
        cost: 1.2345,
        apiCost: 2.34,
        providers: {
          'rightcode-openai': {
            providerID: 'rightcode-openai',
            input: 100,
            output: 200,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 300,
            cost: 9.876,
            apiCost: 4.567,
            assistantMessages: 1,
          },
        },
      }),
      [
        {
          providerID: 'rightcode-openai',
          adapterID: 'rightcode',
          label: 'RightCode',
          shortLabel: 'RC-openai',
          status: 'ok',
          checkedAt: Date.now(),
          balance: { amount: 123.45, currency: '$' },
        },
      ],
      { showCost: true },
    )

    assert.match(
      report,
      /\| rightcode-openai \| 100 \| 200 \| 0 \| 300 \| \$9\.876 \| \$4\.57 \|/,
    )
  })
})

describe('renderToastMessage', () => {
  it('uses aligned token and quota sections with blank line separation', () => {
    const now = new Date()
    const sameDayReset = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      16,
      20,
      0,
      0,
    ).toISOString()
    const toast = renderToastMessage('week', makeUsage(), [
      {
        providerID: 'openai',
        label: 'OpenAI',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [{ label: '5h', remainingPercent: 80, resetAt: sameDayReset }],
      },
    ])

    const lines = toast.split('\n')
    assert.equal(lines[1], '')
    assert.equal(lines[2], 'Token Usage')
    assert.ok(lines.some((line) => /API Cost\s+\$2\.34$/.test(line)))
    const quotaHeaderIndex = lines.findIndex((line) => line === 'Quota')
    assert.ok(quotaHeaderIndex > 0)
    assert.equal(lines[quotaHeaderIndex - 1], '')
    assert.ok(lines.some((line) => /OpenAI\s+5h 80\.0% Rst/.test(line)))
  })

  it('renders RightCode daily quota rules in toast', () => {
    const toast = renderToastMessage('session', makeUsage(), [
      {
        providerID: 'openai',
        adapterID: 'rightcode',
        label: 'RightCode',
        shortLabel: 'RC',
        status: 'ok',
        checkedAt: Date.now(),
        balance: {
          amount: 248.4,
          currency: '$',
        },
        windows: [
          {
            label: 'Daily $83.37/$60',
            showPercent: false,
            remainingPercent: 138.95,
            resetAt: '2026-02-27T02:50:08Z',
            resetLabel: 'Exp',
          },
        ],
      },
    ])

    assert.match(toast, /RC\s+Daily \$83\.37\/\$60 Exp 02-27/)
    assert.match(toast, /\s+Balance \$248\.40/)
    assert.doesNotMatch(toast, /Daily \$83\.37\/\$60\s+138\.9%/)
  })

  it('renders Exp+ for RightCode in toast when multiple expiries exist', () => {
    const toast = renderToastMessage('session', makeUsage(), [
      {
        providerID: 'openai',
        adapterID: 'rightcode',
        label: 'RightCode',
        shortLabel: 'RC',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [
          {
            label: 'Daily $83.37/$60',
            showPercent: false,
            resetAt: '2026-02-27T02:50:08Z',
            resetLabel: 'Exp+',
          },
        ],
      },
    ])

    assert.match(toast, /RC\s+Daily \$83\.37\/\$60 Exp\+ 02-27/)
  })

  it('renders per-provider Cost as API section in toast', () => {
    const toast = renderToastMessage(
      'week',
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
            apiCost: 1.23,
            assistantMessages: 1,
          },
          'github-copilot': {
            providerID: 'github-copilot',
            input: 50,
            output: 80,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 130,
            cost: 0.05,
            apiCost: 0.45,
            assistantMessages: 1,
          },
          anthropic: {
            providerID: 'anthropic',
            input: 20,
            output: 40,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 60,
            cost: 0.01,
            apiCost: 0.2,
            assistantMessages: 1,
          },
        },
      }),
      [],
    )

    assert.match(toast, /Cost as API/)
    assert.match(toast, /OpenAI\s+\$1\.23/)
    assert.match(toast, /Anthropic\s+\$0\.20/)
    assert.doesNotMatch(toast, /Copilot\s+/)
  })

  it('renders N/A for Cost as API when only Copilot usage exists', () => {
    const toast = renderToastMessage(
      'week',
      makeUsage({
        providers: {
          'github-copilot': {
            providerID: 'github-copilot',
            input: 50,
            output: 80,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 130,
            cost: 0.05,
            apiCost: 0.45,
            assistantMessages: 1,
          },
        },
      }),
      [],
    )
    assert.match(toast, /Cost as API/)
    assert.match(toast, /N\/A \(Copilot\)/)
  })

  it('collapses duplicate RightCode quota snapshots in toast', () => {
    const toast = renderToastMessage('week', makeUsage(), [
      {
        providerID: 'openai',
        adapterID: 'rightcode',
        label: 'RightCode',
        shortLabel: 'RC',
        status: 'ok',
        checkedAt: Date.now(),
        balance: {
          amount: 245.84,
          currency: '$',
        },
      },
      {
        providerID: 'openai',
        adapterID: 'rightcode',
        label: 'RightCode',
        shortLabel: 'RC',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [
          {
            label: 'Daily $55.55/$60',
            showPercent: false,
            resetLabel: 'Exp',
            resetAt: '2026-02-27T02:50:08Z',
          },
        ],
      },
    ])

    const rightCodeLabelCount = toast
      .split('\n')
      .filter((line) => /^\s*RC\s+/.test(line)).length
    assert.equal(rightCodeLabelCount, 1)
    assert.match(toast, /RC\s+Daily \$55\.55\/\$60 Exp 02-27/)
    assert.match(toast, /\s+Balance \$245\.84/)
  })

  it('splits RightCode balance into RC when both RC and RC-variant exist', () => {
    const toast = renderToastMessage('week', makeUsage(), [
      {
        providerID: 'rightcode',
        adapterID: 'rightcode',
        label: 'RightCode',
        shortLabel: 'RC',
        status: 'ok',
        checkedAt: Date.now(),
        balance: { amount: 200, currency: '$' },
      },
      {
        providerID: 'rightcode-openai',
        adapterID: 'rightcode',
        label: 'RightCode',
        shortLabel: 'RC-openai',
        status: 'ok',
        checkedAt: Date.now(),
        balance: { amount: 999, currency: '$' },
        windows: [
          {
            label: 'Daily $41.34/$60',
            showPercent: false,
            resetLabel: 'Exp',
            resetAt: '2026-02-27T02:50:08Z',
          },
        ],
      },
    ])

    // Variant should not show balance when base RC exists.
    assert.match(toast, /RC-openai\s+Daily \$41\.34\/\$60 Exp 02-27/)
    assert.doesNotMatch(toast, /RC-openai[\s\S]*Balance/)
    assert.match(toast, /RC\s+Balance \$200\.00/)
  })

  it('clears RC-variant balance even if RC base is not providerID=rightcode', () => {
    const toast = renderToastMessage('week', makeUsage(), [
      {
        providerID: 'openai',
        adapterID: 'rightcode',
        label: 'RightCode',
        shortLabel: 'RC',
        status: 'ok',
        checkedAt: Date.now(),
        balance: { amount: 243.5, currency: '$' },
      },
      {
        providerID: 'rightcode-openai',
        adapterID: 'rightcode',
        label: 'RightCode',
        shortLabel: 'RC-openai',
        status: 'ok',
        checkedAt: Date.now(),
        balance: { amount: 243.5, currency: '$' },
        windows: [
          {
            label: 'Daily $41.34/$60',
            showPercent: false,
            resetLabel: 'Exp',
            resetAt: '2026-02-27T02:50:08Z',
          },
        ],
      },
    ])

    assert.match(toast, /RC\s+Balance \$243\.50/)
    assert.match(toast, /RC-openai\s+Daily \$41\.34\/\$60 Exp 02-27/)
    assert.doesNotMatch(toast, /RC-openai[\s\S]*Balance \$243\.50/)
  })
})
