import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  fallbackQuotaGroupsFromTitle,
  mergeLiveAndPersistedPanelUsage,
  quotaGroupsAreCollapsible,
  quotaGroupsSummary,
  quotaGroupsUseBullets,
  renderSidebarQuotaGroups,
  sidebarPanelQuotaSnapshots,
} from '../tui_helpers.js'
import type { QuotaSidebarConfig, QuotaSnapshot } from '../types.js'

function makeConfig(width = 36): QuotaSidebarConfig {
  return {
    sidebar: {
      enabled: true,
      width,
      titleMode: 'multiline',
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

describe('tui quota helpers', () => {
  it('groups sidebar quota lines by provider', () => {
    const config = makeConfig(38)
    const rightCodeReset = new Date(
      Date.now() + 6 * 24 * 60 * 60_000,
    ).toISOString()
    const quotas: QuotaSnapshot[] = [
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
        shortLabel: 'RC',
        status: 'ok',
        checkedAt: Date.now(),
        windows: [
          {
            label: 'Daily $88.9/$60',
            showPercent: false,
            resetLabel: 'Exp',
            resetAt: rightCodeReset,
          },
        ],
        balance: { amount: 260, currency: '$' },
      },
    ]

    const groups = renderSidebarQuotaGroups(quotas, config)

    assert.equal(groups.length, 2)
    assert.equal(groups[0]?.providerID, 'openai')
    assert.equal(groups[0]?.shortLabel, 'OAI')
    assert.equal(groups[0]?.detail, '5h80 W70')
    assert.equal(groups[0]?.tone, 'success')
    assert.equal(groups[1]?.providerID, 'rightcode-openai')
    assert.equal(groups[1]?.shortLabel, 'RC')
    assert.match(groups[1]?.detail || '', /^D\$88\.9\/\$60 E\d+D\d{2}h B260$/)
  })

  it('extracts only quota tokens from compact titles', () => {
    const groups = fallbackQuotaGroupsFromTitle(
      'Session | OAI 5h80 W70 | Ant 5h100 W77 O7d60 | RC D$88.9/$60 B260 | Cd63% | API$2.34',
      36,
    )

    assert.deepEqual(
      groups.map((group) => `${group.shortLabel} ${group.detail}`.trim()),
      ['OAI 5h80 W70', 'Ant 5h100 W77 O7d60', 'RC D$88.9/$60 B260'],
    )
    assert.equal(groups[0]?.tone, 'success')
    assert.equal(groups[1]?.tone, 'success')
    assert.equal(groups[2]?.tone, 'muted')
  })

  it('ignores unsupported quota tokens in compact title fallback', () => {
    const groups = fallbackQuotaGroupsFromTitle(
      'Session | LEGACYAI D$70.2/$90 | OAI 5h80 W70 | Cd63% | API$2.34',
      36,
    )

    assert.deepEqual(
      groups.map((group) => `${group.shortLabel} ${group.detail}`.trim()),
      ['OAI 5h80 W70'],
    )
  })

  it('marks low quota groups with warning tone', () => {
    const config = makeConfig(38)
    const groups = renderSidebarQuotaGroups(
      [
        {
          providerID: 'openai',
          adapterID: 'openai',
          label: 'OpenAI',
          shortLabel: 'OpenAI',
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: 12 }],
        },
      ],
      config,
    )

    assert.equal(groups[0]?.tone, 'warning')
  })

  it('marks exhausted quota groups with error tone', () => {
    const config = makeConfig(38)
    const groups = renderSidebarQuotaGroups(
      [
        {
          providerID: 'openai',
          adapterID: 'openai',
          label: 'OpenAI',
          shortLabel: 'OpenAI',
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: 4 }],
        },
      ],
      config,
    )

    assert.equal(groups[0]?.tone, 'error')
  })

  it('uses bullets for any visible provider and only collapses after two', () => {
    const oneGroup = fallbackQuotaGroupsFromTitle(
      'Session | OAI 5h80 | Cd63% | API$2.34',
      36,
    )
    const twoGroups = fallbackQuotaGroupsFromTitle(
      'Session | OAI 5h80 | Cop M60 | Cd63% | API$2.34',
      36,
    )
    const threeGroups = fallbackQuotaGroupsFromTitle(
      'Session | OAI 5h80 | Cop M60 | Ant W55 | Cd63% | API$2.34',
      36,
    )

    assert.equal(quotaGroupsUseBullets(oneGroup), true)
    assert.equal(quotaGroupsUseBullets(twoGroups), true)
    assert.equal(quotaGroupsAreCollapsible(twoGroups), false)
    assert.equal(quotaGroupsAreCollapsible(threeGroups), true)
    assert.equal(quotaGroupsSummary(threeGroups), '(3)')
  })

  it('reflows multi-provider groups for bullet width budget', () => {
    const config = makeConfig(16)
    const resetAt = new Date(Date.now() + (4 * 60 + 34) * 60_000).toISOString()

    const singleProvider = renderSidebarQuotaGroups(
      [
        {
          providerID: 'openai',
          adapterID: 'openai',
          label: 'OpenAI',
          shortLabel: 'OpenAI',
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: 80, resetAt }],
        },
      ],
      config,
    )
    const multiProvider = renderSidebarQuotaGroups(
      [
        {
          providerID: 'openai',
          adapterID: 'openai',
          label: 'OpenAI',
          shortLabel: 'OpenAI',
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: 80, resetAt }],
        },
        {
          providerID: 'github-copilot',
          adapterID: 'github-copilot',
          label: 'Copilot',
          shortLabel: 'Copilot',
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: 'Monthly', remainingPercent: 60 }],
        },
      ],
      config,
    )

    assert.equal(singleProvider[0]?.detail, '5h80')
    assert.match(
      singleProvider[0]?.continuationLines[0] || '',
      /^    R4h3[34]m$/,
    )
    assert.equal(multiProvider[0]?.detail, '5h80')
    assert.match(
      multiProvider[0]?.continuationLines[0] || '',
      /^    R4h3[34]m$/,
    )
  })

  it('uses muted tone for balance-only live quota groups', () => {
    const config = makeConfig(38)
    const groups = renderSidebarQuotaGroups(
      [
        {
          providerID: 'rightcode',
          adapterID: 'rightcode',
          label: 'RightCode',
          shortLabel: 'RC',
          status: 'ok',
          checkedAt: Date.now(),
          balance: { amount: 10.2, currency: '$' },
        },
      ],
      config,
    )

    assert.equal(groups[0]?.tone, 'muted')
  })

  it('uses error tone for negative balance fallback groups', () => {
    const groups = fallbackQuotaGroupsFromTitle(
      'Session | RC B-$3.2 | Cd63% | API$2.34',
      36,
    )

    assert.equal(groups[0]?.tone, 'error')
  })

  it('keeps persisted api cost when live usage matches the same aggregate surface', () => {
    const merged = mergeLiveAndPersistedPanelUsage(
      {
        input: 100,
        output: 20,
        reasoning: 0,
        cacheRead: 10,
        cacheWrite: 0,
        total: 130,
        cost: 0,
        apiCost: 0,
        assistantMessages: 2,
        sessionCount: 1,
        providers: {},
      },
      {
        input: 100,
        output: 20,
        reasoning: 0,
        cacheRead: 10,
        cacheWrite: 0,
        total: 130,
        cost: 0,
        apiCost: 1.25,
        assistantMessages: 2,
        sessionCount: 1,
        providers: {},
      },
    )

    assert.equal(merged?.apiCost, 1.25)
  })

  it('does not reuse persisted api cost when live usage has newer totals', () => {
    const merged = mergeLiveAndPersistedPanelUsage(
      {
        input: 150,
        output: 30,
        reasoning: 0,
        cacheRead: 10,
        cacheWrite: 0,
        total: 190,
        cost: 0,
        apiCost: 0,
        assistantMessages: 3,
        sessionCount: 1,
        providers: {},
      },
      {
        input: 100,
        output: 20,
        reasoning: 0,
        cacheRead: 10,
        cacheWrite: 0,
        total: 130,
        cost: 0,
        apiCost: 1.25,
        assistantMessages: 2,
        sessionCount: 1,
        providers: {},
      },
    )

    assert.equal(merged?.apiCost, 0)
  })

  it('prefers panelQuotas over legacy sidebarPanel quotas', () => {
    const quotas = sidebarPanelQuotaSnapshots({
      version: 1,
      updatedAt: Date.now(),
      quotas: [
        {
          providerID: 'openai',
          label: 'OpenAI',
          status: 'ok',
          checkedAt: Date.now(),
        },
      ],
      panelQuotas: [
        {
          providerID: 'anthropic',
          label: 'Anthropic',
          status: 'ok',
          checkedAt: Date.now(),
        },
      ],
    })

    assert.deepEqual(
      quotas.map((quota) => quota.providerID),
      ['anthropic'],
    )
  })

  it('falls back to legacy sidebarPanel quotas when panelQuotas are missing', () => {
    const quotas = sidebarPanelQuotaSnapshots({
      version: 1,
      updatedAt: Date.now(),
      quotas: [
        {
          providerID: 'openai',
          label: 'OpenAI',
          status: 'ok',
          checkedAt: Date.now(),
        },
      ],
    })

    assert.deepEqual(
      quotas.map((quota) => quota.providerID),
      ['openai'],
    )
  })
})
