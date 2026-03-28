import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  renderMarkdownReport,
  renderSidebarTitle,
  renderToastMessage,
  resolveTitleView,
  TUI_ACTIVE_MS,
} from '../format.js'
import type { QuotaSidebarConfig, QuotaSnapshot } from '../types.js'
import type { UsageSummary } from '../usage.js'

const ORIGINAL_OPENCODE_CLIENT = process.env.OPENCODE_CLIENT

beforeEach(() => {
  process.env.OPENCODE_CLIENT = 'cli'
})

afterEach(() => {
  process.env.OPENCODE_CLIENT = ORIGINAL_OPENCODE_CLIENT
})

function makeConfig(width = 36): QuotaSidebarConfig {
  return {
    sidebar: {
      enabled: true,
      width,
      titleMode: 'multiline',
      multilineTitle: true,
      showCost: true,
      showQuota: true,
      wrapQuotaLines: true,
      includeChildren: true,
      childrenMaxDepth: 6,
      childrenMaxSessions: 128,
      childrenConcurrency: 5,
      desktopCompact: {
        recentRequests: 50,
        recentMinutes: 60,
      },
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
  it('renders a compact single-line title on desktop', () => {
    process.env.OPENCODE_CLIENT = 'desktop'
    const config = makeConfig(80)
    config.sidebar.titleMode = 'auto'
    const title = renderSidebarTitle(
      'Greeting and quick check-in',
      makeUsage(),
      [],
      config,
    )
    assert.equal(title.includes('\n'), false)
    assert.match(title, /Est\$2\.34/)
    assert.doesNotMatch(title, /R3 I1\.5k O1\.2m/)
  })

  it('renders compact desktop titles with all recent provider windows and balances', () => {
    const previousClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = 'desktop'
    try {
      const config = makeConfig(200)
      config.sidebar.titleMode = 'auto'
      const title = renderSidebarTitle(
        'Greeting and quick check-in',
        makeUsage({
          recentProviders: [
            { providerID: 'openai', completedAt: Date.now() - 1_000 },
            { providerID: 'rightcode-openai', completedAt: Date.now() - 2_000 },
            { providerID: 'buzz-openai', completedAt: Date.now() - 3_000 },
          ],
        }),
        [
          {
            providerID: 'openai',
            adapterID: 'openai',
            label: 'OpenAI',
            shortLabel: 'OpenAI',
            status: 'ok',
            checkedAt: Date.now(),
            windows: [
              { label: '5h', remainingPercent: 80 },
              { label: 'Weekly', remainingPercent: 70 },
            ],
          },
          {
            providerID: 'rightcode-openai',
            adapterID: 'rightcode',
            label: 'RightCode',
            shortLabel: 'RC-openai',
            status: 'ok',
            checkedAt: Date.now(),
            windows: [{ label: 'Daily $88.9/$60', showPercent: false }],
            balance: { amount: 260, currency: '$' },
          },
          {
            providerID: 'buzz-openai',
            adapterID: 'buzz',
            label: 'Buzz',
            shortLabel: 'Buzz',
            status: 'ok',
            checkedAt: Date.now(),
            balance: { amount: 10.2, currency: '￥' },
          },
        ],
        config,
      )

      assert.equal(title.includes('\n'), false)
      assert.match(
        title,
        /Greeting and quick check-in \| OAI 5h80 W70 \| RC D\$88\.9\/\$60 B260 \| Buzz B￥10\.2 \| Cd63% \| Est\$2\.34/,
      )
    } finally {
      process.env.OPENCODE_CLIENT = previousClient
    }
  })

  it('filters desktop compact providers by recent requests and time window', () => {
    const previousClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = 'desktop'
    try {
      const now = Date.now()
      const config = makeConfig(200)
      config.sidebar.titleMode = 'auto'
      config.sidebar.desktopCompact = { recentRequests: 2, recentMinutes: 60 }

      const title = renderSidebarTitle(
        'Greeting and quick check-in',
        makeUsage({
          recentProviders: [
            { providerID: 'openai', completedAt: now - 1_000 },
            { providerID: 'github-copilot', completedAt: now - 2_000 },
            { providerID: 'anthropic', completedAt: now - 3_700_000 },
          ],
        }),
        [
          {
            providerID: 'openai',
            adapterID: 'openai',
            label: 'OpenAI',
            status: 'ok',
            checkedAt: now,
            windows: [{ label: '5h', remainingPercent: 80 }],
          },
          {
            providerID: 'github-copilot',
            adapterID: 'github-copilot',
            label: 'Copilot',
            status: 'ok',
            checkedAt: now,
            windows: [{ label: 'Monthly', remainingPercent: 60 }],
          },
          {
            providerID: 'anthropic',
            adapterID: 'anthropic',
            label: 'Anthropic',
            status: 'ok',
            checkedAt: now,
            windows: [{ label: 'Weekly', remainingPercent: 55 }],
          },
        ],
        config,
      )

      assert.match(title, /OAI 5h80/)
      assert.match(title, /Cop M60/)
      assert.doesNotMatch(title, /Ant W55/)
    } finally {
      process.env.OPENCODE_CLIENT = previousClient
    }
  })

  it('renders Buzz balance consistently in desktop compact titles', () => {
    process.env.OPENCODE_CLIENT = 'desktop'
    const config = makeConfig(160)
    config.sidebar.titleMode = 'auto'
    const title = renderSidebarTitle(
      'Greeting and quick check-in',
      makeUsage({
        recentProviders: [
          { providerID: 'openai', completedAt: Date.now() - 1_000 },
        ],
      }),
      [
        {
          providerID: 'openai',
          adapterID: 'buzz',
          label: 'Buzz',
          shortLabel: 'Buzz',
          status: 'ok',
          checkedAt: Date.now(),
          balance: {
            amount: 10.17436,
            currency: '￥',
          },
        },
      ],
      config,
    )
    assert.match(title, /Buzz B￥10\.2/)
  })

  it('shows non-ok quota status in desktop compact titles', () => {
    process.env.OPENCODE_CLIENT = 'desktop'
    const config = makeConfig(160)
    config.sidebar.titleMode = 'auto'
    const title = renderSidebarTitle(
      'Greeting and quick check-in',
      makeUsage({
        recentProviders: [
          { providerID: 'openai', completedAt: Date.now() - 1_000 },
        ],
      }),
      [
        {
          providerID: 'openai',
          adapterID: 'openai',
          label: 'OpenAI',
          shortLabel: 'OpenAI',
          status: 'unavailable',
          checkedAt: Date.now(),
        },
      ],
      config,
    )

    assert.match(title, /OAI unavailable/)
  })

  it('sanitizes invalid quota percentages in desktop compact titles', () => {
    process.env.OPENCODE_CLIENT = 'desktop'
    const config = makeConfig(160)
    config.sidebar.titleMode = 'auto'
    const title = renderSidebarTitle(
      'Greeting and quick check-in',
      makeUsage({
        recentProviders: [
          { providerID: 'openai', completedAt: Date.now() - 1_000 },
        ],
      }),
      [
        {
          providerID: 'openai',
          adapterID: 'openai',
          label: 'OpenAI',
          shortLabel: 'OpenAI',
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: -5, resetAt: undefined }],
        },
      ],
      config,
    )

    assert.match(title, /OAI 5h/)
    assert.doesNotMatch(title, /-5%|NaN%|Infinity%/)
  })

  it('renders the desktop-style compact line when compact view is forced', () => {
    const config = makeConfig(120)
    const title = renderSidebarTitle(
      'Greeting and quick check-in',
      makeUsage({
        recentProviders: [
          { providerID: 'openai', completedAt: Date.now() - 1_000 },
        ],
      }),
      [
        {
          providerID: 'openai',
          adapterID: 'openai',
          label: 'OpenAI',
          shortLabel: 'OpenAI',
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: 80 }],
        },
      ],
      config,
      'compact',
    )

    assert.equal(title.includes('\n'), false)
    assert.match(title, /Greeting and quick check-in \| OAI 5h80 \| Cd63% \| Est\$2\.34/)
  })

  it('uses adaptive k/m units for sidebar token lines', () => {
    const title = renderSidebarTitle(
      'Greeting and quick check-in',
      makeUsage(),
      [],
      makeConfig(60),
    )
    const lines = title.split('\n')
    assert.equal(lines[2], 'R3 I1.5k O1.2m')
    assert.equal(lines[3], 'CR2.5k Cd63%')
    assert.equal(lines[4], 'Est$2.34')
    assert.match(title, /R3 I1\.5k O1\.2m/)
    assert.match(title, /CR2\.5k Cd63%/)
    assert.match(title, /Est\$2\.34/)
  })

  it('keeps auto mode compact unless a TUI session is positively identified', () => {
    const config = makeConfig(60)
    config.sidebar.titleMode = 'auto'

    assert.equal(resolveTitleView({ config, sessionID: 's1' }), 'compact')
    assert.equal(
      resolveTitleView({
        config,
        sessionID: 's1',
        tuiSessionID: 's1',
        tuiActiveAt: 1000,
        now: 1000,
      }),
      'multiline',
    )
    assert.equal(
      resolveTitleView({
        config,
        sessionID: 's1',
        tuiSessionID: 's1',
        tuiActiveAt: 1000,
        now: 1000 + TUI_ACTIVE_MS + 1,
      }),
      'compact',
    )

    config.sidebar.titleMode = 'multiline'
    assert.equal(resolveTitleView({ config, sessionID: 's1' }), 'multiline')

    config.sidebar.titleMode = 'compact'
    assert.equal(
      resolveTitleView({ config, sessionID: 's1', tuiSessionID: 's1' }),
      'compact',
    )
  })

  it('renders API cost as the last token detail line', () => {
    const title = renderSidebarTitle(
      'Session',
      makeUsage({
        cacheRead: 2500,
        cacheWrite: 300,
        cacheBuckets: {
          readOnly: {
            input: 1500,
            cacheRead: 2500,
            cacheWrite: 0,
            assistantMessages: 2,
          },
          readWrite: {
            input: 600,
            cacheRead: 200,
            cacheWrite: 300,
            assistantMessages: 1,
          },
        },
      }),
      [],
      makeConfig(60),
    )
    const lines = title.split('\n')
    assert.equal(lines[2], 'R3 I1.5k O1.2m')
    assert.equal(lines[3], 'CW300 CR2.5k Cd63%')
    assert.equal(lines[4], 'Est$2.34')
  })

  it('renders cached ratio line for mixed cache model types', () => {
    const title = renderSidebarTitle(
      'Session',
      makeUsage({
        cacheRead: 1200,
        cacheWrite: 300,
        cacheBuckets: {
          readOnly: {
            input: 300,
            cacheRead: 900,
            cacheWrite: 0,
            assistantMessages: 2,
          },
          readWrite: {
            input: 400,
            cacheRead: 300,
            cacheWrite: 300,
            assistantMessages: 2,
          },
        },
      }),
      [],
      makeConfig(60),
    )

    assert.match(title, /Cd44%/)
  })

  it('uses shorter token detail labels instead of truncating on narrow widths', () => {
    const title = renderSidebarTitle(
      'Weekly quota summary with toast',
      makeUsage({
        input: 16_300,
        output: 916,
        cacheRead: 31_400,
        cacheWrite: 0,
        apiCost: 0.12,
        cacheBuckets: {
          readOnly: {
            input: 16_300,
            cacheRead: 31_400,
            cacheWrite: 0,
            assistantMessages: 3,
          },
          readWrite: {
            input: 0,
            cacheRead: 0,
            cacheWrite: 0,
            assistantMessages: 0,
          },
        },
      }),
      [
        {
          providerID: 'xyai-vibe',
          adapterID: 'xyai-vibe',
          label: 'XYAI Vibe',
          shortLabel: 'XYAI',
          status: 'ok',
          checkedAt: Date.now(),
          windows: [
            {
              label: 'Daily $31.3/$90',
              showPercent: false,
              resetAt: '2026-03-27T14:39:00.000Z',
            },
          ],
        },
      ],
      makeConfig(16),
    )
    const lines = title.split('\n')

    assert.ok(lines.includes('R3 I16.3k O916'))
    assert.ok(lines.includes('CR31.4k Cd66%'))
    assert.ok(lines.includes('Est$0.12'))
    assert.ok(lines.includes('XYAI D$31.3/$90'))
    assert.ok(lines.some((line) => /^\s+R/.test(line)))
    assert.equal(
      lines.some((line) => /Cd.*~|Est\$.*~/.test(line)),
      false,
    )
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
    assert.ok(lines.includes('OAI 5h80 W70'))
    assert.ok(lines.includes('Cop M60'))
  })

  it('renders Anthropic multi-window quota lines', () => {
    const quotas: QuotaSnapshot[] = [
      {
        providerID: 'anthropic',
        label: 'Anthropic',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [
          { label: '5h', remainingPercent: 80 },
          { label: 'Weekly', remainingPercent: 70 },
          { label: 'Sonnet 7d', remainingPercent: 65 },
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
    assert.ok(lines.includes('Ant 5h80 W70 S7d65'))
  })

  it('renders Kimi multi-window quota lines like other subscription providers', () => {
    const crossDayShortReset = '2026-03-21T03:44:15.855Z'
    const weeklyReset = '2026-03-27T14:44:15.855Z'
    const quotas: QuotaSnapshot[] = [
      {
        providerID: 'kimi-for-coding',
        adapterID: 'kimi-for-coding',
        label: 'Kimi For Coding',
        shortLabel: 'Kimi',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [
          { label: '5h', remainingPercent: 84, resetAt: crossDayShortReset },
          { label: 'Weekly', remainingPercent: 72, resetAt: weeklyReset },
        ],
      },
    ]

    const title = renderSidebarTitle(
      'Session',
      makeUsage(),
      quotas,
      makeConfig(60),
    )
    assert.match(
      title,
      /Kimi 5h84 R(?:\d{2}:\d{2}|\d{2}-\d{2} \d{2}:\d{2}) W72 R\d{2}-\d{2}/,
    )
  })

  it('applies short-window time formatting consistently across providers', () => {
    const now = new Date()
    const crossDayShortReset = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      1,
      0,
      0,
      0,
    ).toISOString()
    const futureLongReset = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 7,
      19,
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
          { label: '5h', remainingPercent: 80, resetAt: crossDayShortReset },
        ],
      },
      {
        providerID: 'anthropic',
        label: 'Anthropic',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [
          { label: '1d', remainingPercent: 46, resetAt: crossDayShortReset },
        ],
      },
      {
        providerID: 'github-copilot',
        label: 'GitHub Copilot',
        shortLabel: 'Copilot',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [
          { label: 'Monthly', remainingPercent: 70, resetAt: futureLongReset },
        ],
      },
      {
        providerID: 'rightcode-openai',
        adapterID: 'rightcode',
        label: 'RightCode',
        shortLabel: 'RC-openai',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [
          {
            label: 'Daily $88.9/$60',
            showPercent: false,
            resetAt: futureLongReset,
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

    assert.match(title, /OAI 5h80 R\d{2}-\d{2} \d{2}:\d{2}/)
    assert.match(title, /Ant D46 R\d{2}-\d{2} \d{2}:\d{2}/)
    assert.match(title, /Cop M70 R\d{2}-\d{2}/)
    assert.doesNotMatch(title, /M70 R\d{2}-\d{2} \d{2}:\d{2}/)
    assert.match(title, /RC D\$88\.9\/\$60 E\d{2}-\d{2}/)
    assert.doesNotMatch(title, /D\$88\.9\/\$60 E\d{2}-\d{2} \d{2}:\d{2}/)
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

    const firstQuotaIndex = lines.findIndex((line) => line.startsWith('OAI'))
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

  it('keeps multi-detail providers in wrapped layout when wrapQuotaLines=false', () => {
    const config = makeConfig(60)
    config.sidebar.wrapQuotaLines = false
    const quotas: QuotaSnapshot[] = [
      {
        providerID: 'openai',
        label: 'OpenAI Codex',
        shortLabel: 'OpenAI',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [
          { label: '5h', remainingPercent: 80 },
          { label: 'Weekly', remainingPercent: 70 },
        ],
      },
    ]

    const title = renderSidebarTitle('Session', makeUsage(), quotas, config)
    const lines = title.split('\n')
    assert.ok(lines.includes('OAI 5h80 W70'))
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
    assert.match(title, /RC B258\.3/)
  })

  it('renders XYAI reset time without compact expiry noise in sidebar', () => {
    const now = new Date()
    const sameDayReset = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      22,
      18,
      0,
      0,
    ).toISOString()
    const quotas: QuotaSnapshot[] = [
      {
        providerID: 'xyai-vibe',
        adapterID: 'xyai-vibe',
        label: 'XYAI Vibe',
        shortLabel: 'XYAI',
        status: 'ok',
        checkedAt: Date.now(),
        note: 'exp 04-15',
        windows: [
          {
            label: 'Daily $70.2/$90',
            showPercent: false,
            resetAt: sameDayReset,
            resetLabel: 'Rst',
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

    assert.match(title, /XYAI D\$70\.2\/\$90 R\d{2}:\d{2}/)
    assert.doesNotMatch(title, /exp 04-15/i)
  })

  it('renders Buzz balance neatly in multiline sidebar', () => {
    const quotas: QuotaSnapshot[] = [
      {
        providerID: 'openai',
        adapterID: 'buzz',
        label: 'Buzz',
        shortLabel: 'Buzz',
        status: 'ok',
        checkedAt: Date.now(),
        balance: {
          amount: 10.17436,
          currency: '￥',
        },
      },
    ]
    const title = renderSidebarTitle(
      'Session',
      makeUsage(),
      quotas,
      makeConfig(60),
    )
    assert.match(title, /Buzz B￥10\.2/)
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
    const dailyReset = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      1,
      30,
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
          { label: '1d', remainingPercent: 65, resetAt: dailyReset },
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
    assert.match(title, /OAI 5h80 R\d{2}:\d{2}/)
    assert.match(title, /D65 R\d{2}-\d{2} \d{2}:\d{2}/)
    assert.match(title, /W70 R\d{2}-\d{2}/)
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
            label: 'Daily $88.9/$60',
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
    assert.match(title, /RC D\$88\.9\/\$60 E02-27 B260/)
    assert.doesNotMatch(title, /RC\s+D\$88\.9\/\$60\s+148/)
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
            label: 'Daily $88.9/$60',
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
    assert.match(title, /RC D\$88\.9\/\$60 E\+02-27/)
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
    assert.match(title, /OAI 5h80/)
    assert.match(title, /Cop M60/)
    assert.match(title, /RC D\$88\/\$60/)
  })

  it('renders Buzz cleanly alongside OpenAI and Copilot in sidebar', () => {
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
        adapterID: 'buzz',
        label: 'Buzz',
        shortLabel: 'Buzz',
        status: 'ok',
        checkedAt: Date.now(),
        balance: { amount: 10.17436, currency: '￥' },
      },
    ]

    const title = renderSidebarTitle('Session', makeUsage(), quotas, config)
    assert.match(title, /OAI 5h80/)
    assert.match(title, /Cop M60/)
    assert.match(title, /Buzz B￥10\.2/)
  })
})

describe('renderMarkdownReport', () => {
  it('renders cached summary line when cache buckets are available', () => {
    const report = renderMarkdownReport(
      'session',
      makeUsage({
        cacheRead: 1200,
        cacheWrite: 300,
        cacheBuckets: {
          readOnly: {
            input: 300,
            cacheRead: 900,
            cacheWrite: 0,
            assistantMessages: 2,
          },
          readWrite: {
            input: 400,
            cacheRead: 300,
            cacheWrite: 300,
            assistantMessages: 2,
          },
        },
      }),
      [],
      { showCost: true },
    )

    assert.match(report, /Cached: 44\.4%/)
  })

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
    assert.match(report, /Requests: 3/)
    assert.match(
      report,
      /\| Provider \| Requests \| Input \| Output \| Cache \| Total \| Cached \| Measured Cost \| API Cost \|/,
    )
    assert.match(
      report,
      /\| openai \| 1 \| 100 \| 200 \| 0 \| 300 \| - \| - \| \$0\.35 \|/,
    )
    assert.match(
      report,
      /\| github-copilot \| 1 \| 10 \| 20 \| 0 \| 30 \| - \| - \| - \|/,
    )
    assert.match(report, /### Usage by Provider\n\n\| Provider \|/)
    assert.match(
      report,
      /\| --- \| ---: \| ---: \| ---: \| ---: \| ---: \| ---: \| ---: \| ---: \|/,
    )
    assert.match(report, /### Subscription Quota\n\n-/)
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
          windows: [{ label: 'Daily $55.6/$60', showPercent: false }],
        },
      ],
      { showCost: true },
    )

    assert.match(
      report,
      /\| rightcode-openai \| 1 \| 100 \| 200 \| 0 \| 300 \| - \| - \| \$4\.57 \|/,
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
      /\| rightcode-openai \| 1 \| 100 \| 200 \| 0 \| 300 \| - \| \$9\.88 \| \$4\.57 \|/,
    )
  })

  it('renders provider-level cached column and highlight in markdown', () => {
    const report = renderMarkdownReport(
      'week',
      makeUsage({
        input: 700,
        output: 880,
        cacheRead: 1200,
        cacheWrite: 300,
        cost: 3.17,
        apiCost: 14.82,
        cacheBuckets: {
          readOnly: {
            input: 300,
            cacheRead: 900,
            cacheWrite: 0,
            assistantMessages: 2,
          },
          readWrite: {
            input: 400,
            cacheRead: 300,
            cacheWrite: 300,
            assistantMessages: 2,
          },
        },
        providers: {
          openai: {
            providerID: 'openai',
            input: 300,
            output: 400,
            reasoning: 0,
            cacheRead: 900,
            cacheWrite: 0,
            total: 1600,
            cost: 0,
            apiCost: 8.3,
            assistantMessages: 2,
            cacheBuckets: {
              readOnly: {
                input: 300,
                cacheRead: 900,
                cacheWrite: 0,
                assistantMessages: 2,
              },
              readWrite: {
                input: 0,
                cacheRead: 0,
                cacheWrite: 0,
                assistantMessages: 0,
              },
            },
          },
          anthropic: {
            providerID: 'anthropic',
            input: 400,
            output: 480,
            reasoning: 0,
            cacheRead: 300,
            cacheWrite: 300,
            total: 1480,
            cost: 0,
            apiCost: 6.52,
            assistantMessages: 2,
            cacheBuckets: {
              readOnly: {
                input: 0,
                cacheRead: 0,
                cacheWrite: 0,
                assistantMessages: 0,
              },
              readWrite: {
                input: 400,
                cacheRead: 300,
                cacheWrite: 300,
                assistantMessages: 2,
              },
            },
          },
        },
      }),
      [],
      { showCost: true },
    )

    assert.match(report, /### Highlights/)
    assert.match(report, /Top API cost: OpenAI \(\$8\.30\)/)
    assert.match(report, /Best Cached Ratio: OpenAI \(75%\)/)
    assert.match(
      report,
      /\| Provider \| Requests \| Input \| Output \| Cache \| Total \| Cached \| Measured Cost \| API Cost \|/,
    )
    assert.match(
      report,
      /\| openai \| 2 \| 300 \| 400 \| 900 \| 1\.6k \| 75% \| - \| \$8\.30 \|/,
    )
    assert.match(
      report,
      /\| anthropic \| 2 \| 400 \| 480 \| 600 \| 1\.5k \| 42\.9% \| - \| \$6\.52 \|/,
    )
  })

  it('uses compact reset formatting in markdown report for short windows', () => {
    const now = new Date()
    const shortReset = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      1,
      0,
      0,
      0,
    ).toISOString()
    const monthlyReset = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 10,
      19,
      0,
      0,
      0,
    ).toISOString()

    const report = renderMarkdownReport(
      'session',
      makeUsage(),
      [
        {
          providerID: 'anthropic',
          label: 'Anthropic',
          status: 'ok',
          checkedAt: Date.now(),
          windows: [
            { label: '5h', remainingPercent: 0, resetAt: shortReset },
            { label: 'Weekly', remainingPercent: 46, resetAt: monthlyReset },
          ],
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
              label: 'Daily $88.9/$60',
              showPercent: false,
              resetAt: monthlyReset,
              resetLabel: 'Exp',
            },
          ],
        },
      ],
      { showCost: true },
    )

    const lines = report.split('\n')
    const anthro5h = lines.find((line) => line.startsWith('- Anthropic (5h):'))
    const anthroWeekly = lines.find((line) =>
      line.startsWith('- Anthropic (Weekly):'),
    )
    const rightCodeDaily = lines.find((line) =>
      line.startsWith('- RC (Daily $88.9/$60):'),
    )

    assert.match(anthro5h || '', /reset \d{2}-\d{2} \d{2}:\d{2}$/)
    assert.match(anthroWeekly || '', /reset \d{2}-\d{2}$/)
    assert.doesNotMatch(anthroWeekly || '', /reset \d{2}-\d{2} \d{2}:\d{2}$/)
    assert.match(rightCodeDaily || '', /reset \d{2}-\d{2}$/)
    assert.doesNotMatch(rightCodeDaily || '', /reset \d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('renders Buzz balance clearly in markdown reports', () => {
    const report = renderMarkdownReport(
      'session',
      makeUsage(),
      [
        {
          providerID: 'openai',
          adapterID: 'buzz',
          label: 'Buzz',
          shortLabel: 'Buzz',
          status: 'ok',
          checkedAt: Date.now(),
          balance: { amount: 10.17436, currency: '￥' },
        },
      ],
      { showCost: true },
    )

    assert.match(report, /- Buzz: ok \\\| balance ￥10\.2/)
  })

  it('renders Kimi markdown report like other subscription providers', () => {
    const crossDayShortReset = '2026-03-21T03:44:15.855Z'
    const weeklyReset = '2026-03-27T14:44:15.855Z'
    const report = renderMarkdownReport(
      'session',
      makeUsage(),
      [
        {
          providerID: 'kimi-for-coding',
          adapterID: 'kimi-for-coding',
          label: 'Kimi For Coding',
          shortLabel: 'Kimi',
          status: 'ok',
          checkedAt: Date.now(),
          windows: [
            { label: '5h', remainingPercent: 84, resetAt: crossDayShortReset },
            { label: 'Weekly', remainingPercent: 72, resetAt: weeklyReset },
          ],
        },
      ],
      { showCost: true },
    )

    assert.match(
      report,
      /- Kimi \(5h\): ok \\\| remaining 84\.0% \\\| reset (?:\d{2}:\d{2}|\d{2}-\d{2} \d{2}:\d{2})/,
    )
    assert.match(
      report,
      /- Kimi \(Weekly\): ok \\\| remaining 72\.0% \\\| reset \d{2}-\d{2}/,
    )
  })

  it('renders Kimi API cost in markdown provider table', () => {
    const report = renderMarkdownReport(
      'session',
      makeUsage({
        apiCost: 0.14,
        providers: {
          'kimi-for-coding': {
            providerID: 'kimi-for-coding',
            input: 100_000,
            output: 25_000,
            reasoning: 0,
            cacheRead: 50_000,
            cacheWrite: 0,
            total: 175_000,
            cost: 0,
            apiCost: 0.14,
            assistantMessages: 1,
          },
        },
      }),
      [],
      { showCost: true },
    )

    assert.match(
      report,
      /\| kimi-for-coding \| 1 \| 100\.0k \| 25\.0k \| 50\.0k \| 175\.0k \| 33\.3% \| \$0\.00 \| \$0\.14 \|/,
    )
    assert.match(report, /- API cost: \$0\.14/)
  })

  it('includes XYAI expiry as secondary note in markdown report', () => {
    const now = new Date()
    const sameDayReset = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      22,
      18,
      0,
      0,
    ).toISOString()
    const report = renderMarkdownReport(
      'session',
      makeUsage(),
      [
        {
          providerID: 'xyai-vibe',
          adapterID: 'xyai-vibe',
          label: 'XYAI Vibe',
          shortLabel: 'XYAI',
          status: 'ok',
          checkedAt: Date.now(),
          note: 'exp 04-15',
          windows: [
            {
              label: 'Daily $70.2/$90',
              showPercent: false,
              resetAt: sameDayReset,
              resetLabel: 'Rst',
            },
          ],
        },
      ],
      { showCost: true },
    )

    assert.match(
      report,
      /- XYAI \(Daily \$70\.2\/\$90\): ok \\\| reset \d{2}:\d{2} \\\| exp 04-15/,
    )
  })

  it('renders non-ok quota snapshots as plain status lines in markdown', () => {
    const report = renderMarkdownReport(
      'session',
      makeUsage(),
      [
        {
          providerID: 'anthropic',
          adapterID: 'anthropic',
          label: 'Anthropic',
          shortLabel: 'Anthropic',
          status: 'unsupported',
          checkedAt: Date.now(),
          note: 'oauth quota endpoint is not publicly documented',
        },
      ],
      { showCost: true },
    )

    assert.match(
      report,
      /- Anthropic: unsupported \\| oauth quota endpoint is not publicly documented/,
    )
    assert.doesNotMatch(report, /remaining - \\| reset -/)
  })

  it('uses display labels for markdown quota lines', () => {
    const report = renderMarkdownReport(
      'session',
      makeUsage(),
      [
        {
          providerID: 'rightcode-openai',
          adapterID: 'rightcode',
          label: 'RightCode',
          shortLabel: 'RC-openai',
          status: 'ok',
          checkedAt: Date.now(),
          balance: { amount: 8.5, currency: '$' },
        },
      ],
      { showCost: true },
    )

    assert.match(report, /- RC-openai: ok \\| balance \$8\.50/)
  })

  it('preserves negative balances in markdown reports', () => {
    const report = renderMarkdownReport(
      'session',
      makeUsage(),
      [
        {
          providerID: 'openai',
          adapterID: 'buzz',
          label: 'Buzz',
          shortLabel: 'Buzz',
          status: 'ok',
          checkedAt: Date.now(),
          balance: { amount: -2.5, currency: '$' },
        },
      ],
      { showCost: true },
    )

    assert.match(report, /- Buzz: ok \\| balance -\$2\.50/)
  })
})

describe('renderToastMessage', () => {
  it('shows cached row in the token usage section', () => {
    const toast = renderToastMessage(
      'session',
      makeUsage({
        cacheRead: 1200,
        cacheWrite: 300,
        cacheBuckets: {
          readOnly: {
            input: 300,
            cacheRead: 900,
            cacheWrite: 0,
            assistantMessages: 2,
          },
          readWrite: {
            input: 400,
            cacheRead: 300,
            cacheWrite: 300,
            assistantMessages: 2,
          },
        },
      }),
      [],
    )

    assert.match(toast, /Cached\s+44\.4%/)
  })

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
    assert.ok(lines.some((line) => /Requests\s+3$/.test(line)))
    assert.ok(!lines.some((line) => /API Cost\s+\$2\.34$/.test(line)))
    const quotaHeaderIndex = lines.findIndex((line) => line === 'Quota')
    assert.ok(quotaHeaderIndex > 0)
    assert.equal(lines[quotaHeaderIndex - 1], '')
    assert.ok(lines.some((line) => /OpenAI\s+5h 80\.0% Rst/.test(line)))
  })

  it('shows date and time for cross-day short quota windows in toast', () => {
    const now = new Date()
    const tomorrowReset = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      1,
      0,
      0,
      0,
    ).toISOString()
    const toast = renderToastMessage('week', makeUsage(), [
      {
        providerID: 'anthropic',
        label: 'Anthropic',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [
          { label: '1d', remainingPercent: 46, resetAt: tomorrowReset },
        ],
      },
    ])

    assert.match(toast, /Anthropic\s+1d 46\.0% Rst \d{2}-\d{2} \d{2}:\d{2}/)
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
            label: 'Daily $83.4/$60',
            showPercent: false,
            remainingPercent: 138.95,
          },
        ],
      },
    ])

    assert.match(toast, /RC\s+Daily \$83\.4\/\$60/)
    assert.match(toast, /\s+Balance \$248\.4/)
    assert.doesNotMatch(toast, /Daily \$83\.4\/\$60\s+138\.9%/)
    assert.doesNotMatch(toast, /Exp 02-27/)
  })

  it('renders Buzz balance clearly in toast', () => {
    const toast = renderToastMessage('session', makeUsage(), [
      {
        providerID: 'openai',
        adapterID: 'buzz',
        label: 'Buzz',
        shortLabel: 'Buzz',
        status: 'ok',
        checkedAt: Date.now(),
        balance: {
          amount: 10.17436,
          currency: '￥',
        },
      },
    ])

    assert.match(toast, /Buzz\s+Balance ￥10\.2/)
  })

  it('shows unified expiry reminders in toast for applicable providers within 3 days', () => {
    const now = new Date()
    const soon = new Date(
      now.getTime() + 2 * 24 * 60 * 60 * 1000 + 90 * 60 * 1000,
    )
    const soonIso = soon.toISOString()
    const toast = renderToastMessage('session', makeUsage(), [
      {
        providerID: 'rightcode-openai',
        adapterID: 'rightcode',
        label: 'RightCode',
        shortLabel: 'RC-openai',
        status: 'ok',
        checkedAt: Date.now(),
        expiresAt: soonIso,
        windows: [
          {
            label: 'Daily $55.6/$60',
            showPercent: false,
          },
        ],
      },
      {
        providerID: 'xyai-vibe',
        adapterID: 'xyai-vibe',
        label: 'XYAI Vibe',
        shortLabel: 'XYAI',
        status: 'ok',
        checkedAt: Date.now(),
        expiresAt: soonIso,
        note: 'exp 04-15',
        windows: [
          {
            label: 'Daily $70.2/$90',
            showPercent: false,
            resetAt: soonIso,
            resetLabel: 'Rst',
          },
        ],
      },
    ])

    assert.match(toast, /Expiry Soon/)
    assert.match(toast, /RC-openai\s+Exp \d{2}-\d{2} \d{2}:\d{2}/)
    assert.match(toast, /XYAI\s+Exp \d{2}-\d{2} \d{2}:\d{2}/)
    assert.doesNotMatch(toast, /Buzz\s+Exp \d{2}-\d{2} \d{2}:\d{2}/)
  })

  it('does not show expiry reminders in toast when expiry is beyond 3 days', () => {
    const laterIso = new Date(
      Date.now() + 5 * 24 * 60 * 60 * 1000,
    ).toISOString()
    const toast = renderToastMessage('session', makeUsage(), [
      {
        providerID: 'xyai-vibe',
        adapterID: 'xyai-vibe',
        label: 'XYAI Vibe',
        shortLabel: 'XYAI',
        status: 'ok',
        checkedAt: Date.now(),
        expiresAt: laterIso,
        windows: [
          {
            label: 'Daily $70.2/$90',
            showPercent: false,
            resetAt: laterIso,
            resetLabel: 'Rst',
          },
        ],
      },
    ])

    assert.doesNotMatch(toast, /Expiry Soon/)
  })

  it('does not duplicate API cost inside token usage section', () => {
    const toast = renderToastMessage(
      'session',
      makeUsage({ apiCost: 2.34 }),
      [],
    )

    const apiCostMatches = toast.match(/API Cost/g) || []
    assert.equal(apiCostMatches.length, 0)
    assert.match(toast, /Cost as API/)
  })

  it('renders provider cache section in toast', () => {
    const toast = renderToastMessage(
      'week',
      makeUsage({
        providers: {
          openai: {
            providerID: 'openai',
            input: 300,
            output: 400,
            reasoning: 0,
            cacheRead: 900,
            cacheWrite: 0,
            total: 1600,
            cost: 0,
            apiCost: 8.3,
            assistantMessages: 2,
            cacheBuckets: {
              readOnly: {
                input: 300,
                cacheRead: 900,
                cacheWrite: 0,
                assistantMessages: 2,
              },
              readWrite: {
                input: 0,
                cacheRead: 0,
                cacheWrite: 0,
                assistantMessages: 0,
              },
            },
          },
          anthropic: {
            providerID: 'anthropic',
            input: 400,
            output: 480,
            reasoning: 0,
            cacheRead: 300,
            cacheWrite: 300,
            total: 1480,
            cost: 0,
            apiCost: 6.52,
            assistantMessages: 2,
            cacheBuckets: {
              readOnly: {
                input: 0,
                cacheRead: 0,
                cacheWrite: 0,
                assistantMessages: 0,
              },
              readWrite: {
                input: 400,
                cacheRead: 300,
                cacheWrite: 300,
                assistantMessages: 2,
              },
            },
          },
          mixed: {
            providerID: 'mixed',
            input: 150,
            output: 0,
            reasoning: 0,
            cacheRead: 125,
            cacheWrite: 25,
            total: 150,
            cost: 0,
            apiCost: 0,
            assistantMessages: 2,
            cacheBuckets: {
              readOnly: {
                input: 100,
                cacheRead: 100,
                cacheWrite: 0,
                assistantMessages: 1,
              },
              readWrite: {
                input: 50,
                cacheRead: 25,
                cacheWrite: 25,
                assistantMessages: 1,
              },
            },
          },
        },
      }),
      [],
    )

    assert.match(toast, /Provider Cache/)
    assert.match(toast, /OpenAI\s+Cached 75%/)
    assert.match(toast, /Anthropic\s+Cached 42\.9%/)
    assert.match(toast, /mixed\s+Cached 45\.5%/i)
  })

  it('does not render RightCode expiry labels inline in toast when multiple expiries exist', () => {
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
            label: 'Daily $83.4/$60',
            showPercent: false,
          },
        ],
      },
    ])

    assert.match(toast, /RC\s+Daily \$83\.4\/\$60/)
    assert.doesNotMatch(toast, /Exp\+/)
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

  it('renders generic N/A for Cost as API when non-copilot usage has zero api cost', () => {
    const toast = renderToastMessage(
      'week',
      makeUsage({
        apiCost: 0,
        providers: {
          'zhipuai-coding-plan': {
            providerID: 'zhipuai-coding-plan',
            input: 28629,
            output: 3852,
            reasoning: 0,
            cacheRead: 30976,
            cacheWrite: 0,
            total: 63457,
            cost: 0,
            apiCost: 0,
            assistantMessages: 3,
          },
        },
      }),
      [],
    )

    assert.match(toast, /Cost as API/)
    assert.match(toast, /\n  N\/A\n/)
    assert.doesNotMatch(toast, /N\/A \(Copilot\)/)
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
            label: 'Daily $55.6/$60',
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
    assert.match(toast, /RC\s+Daily \$55\.6\/\$60 Exp 02-27/)
    assert.match(toast, /\s+Balance \$245\.8/)
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
            label: 'Daily $41.3/$60',
            showPercent: false,
            resetLabel: 'Exp',
            resetAt: '2026-02-27T02:50:08Z',
          },
        ],
      },
    ])

    // Variant should not show balance when base RC exists.
    assert.match(toast, /RC-openai\s+Daily \$41\.3\/\$60 Exp 02-27/)
    assert.doesNotMatch(toast, /RC-openai[\s\S]*Balance/)
    assert.match(toast, /RC\s+Balance \$200/)
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
            label: 'Daily $41.3/$60',
            showPercent: false,
            resetLabel: 'Exp',
            resetAt: '2026-02-27T02:50:08Z',
          },
        ],
      },
    ])

    assert.match(toast, /RC\s+Balance \$243\.5/)
    assert.match(toast, /RC-openai\s+Daily \$41\.3\/\$60 Exp 02-27/)
    assert.doesNotMatch(toast, /RC-openai[\s\S]*Balance \$243\.5/)
  })

  it('renders Buzz cleanly alongside OpenAI and Copilot in toast', () => {
    const toast = renderToastMessage('week', makeUsage(), [
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
        adapterID: 'buzz',
        label: 'Buzz',
        shortLabel: 'Buzz',
        status: 'ok',
        checkedAt: Date.now(),
        balance: { amount: 10.17436, currency: '￥' },
      },
    ])

    assert.match(toast, /OpenAI\s+5h 80\.0%/)
    assert.match(toast, /Copilot\s+Monthly 60\.0%/)
    assert.match(toast, /Buzz\s+Balance ￥10\.2/)
  })

  it('renders Kimi toast like other subscription providers', () => {
    const crossDayShortReset = '2026-03-21T03:44:15.855Z'
    const weeklyReset = '2026-03-27T14:44:15.855Z'
    const toast = renderToastMessage('week', makeUsage(), [
      {
        providerID: 'kimi-for-coding',
        adapterID: 'kimi-for-coding',
        label: 'Kimi For Coding',
        shortLabel: 'Kimi',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [
          { label: '5h', remainingPercent: 84, resetAt: crossDayShortReset },
          { label: 'Weekly', remainingPercent: 72, resetAt: weeklyReset },
        ],
      },
    ])

    assert.match(
      toast,
      /Kimi\s+5h 84\.0% Rst (?:\d{2}:\d{2}|\d{2}-\d{2} \d{2}:\d{2})/,
    )
    assert.match(toast, /Weekly 72\.0% Rst \d{2}-\d{2}/)
  })

  it('renders Kimi in the Cost as API toast section when apiCost is available', () => {
    const toast = renderToastMessage(
      'week',
      makeUsage({
        apiCost: 0.14,
        providers: {
          'kimi-for-coding': {
            providerID: 'kimi-for-coding',
            input: 100_000,
            output: 25_000,
            reasoning: 0,
            cacheRead: 50_000,
            cacheWrite: 0,
            total: 175_000,
            cost: 0,
            apiCost: 0.14,
            assistantMessages: 1,
          },
        },
      }),
      [],
    )

    assert.match(toast, /Cost as API/)
    assert.match(toast, /Kimi\s+\$0\.14/)
    assert.doesNotMatch(toast, /N\/A \(Copilot\)/)
  })

  it('renders Zhipu token quota without mcp usage in toast', () => {
    const toast = renderToastMessage('week', makeUsage(), [
      {
        providerID: 'zhipuai-coding-plan',
        adapterID: 'zhipuai-coding-plan',
        label: 'Zhipu Coding Plan',
        shortLabel: 'Zhipu',
        status: 'ok',
        checkedAt: Date.now(),
        note: 'MAX plan',
        windows: [
          {
            label: '5h',
            remainingPercent: 99,
            resetAt: '2026-03-29T01:51:57+08:00',
          },
        ],
      },
    ])

    assert.match(toast, /Zhipu\s+5h 99\.0% Rst/)
    assert.doesNotMatch(toast, /MCP/)
  })
})
