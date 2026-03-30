import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  fallbackQuotaGroupsFromTitle,
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

describe('tui quota helpers', () => {
  it('groups sidebar quota lines by provider', () => {
    const config = makeConfig(38)
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
            resetAt: '2026-02-27T00:00:00.000Z',
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
    assert.equal(groups[1]?.detail, 'D$88.9/$60 E02-27 B260')
  })

  it('extracts only quota tokens from compact titles', () => {
    const groups = fallbackQuotaGroupsFromTitle(
      'Session | OAI 5h80 W70 | Ant 5h100 W77 O7d60 | RC D$88.9/$60 B260 | Cd63% | Est$2.34',
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

  it('uses bullets for multiple providers and only collapses after two', () => {
    const oneGroup = fallbackQuotaGroupsFromTitle(
      'Session | OAI 5h80 | Cd63% | Est$2.34',
      36,
    )
    const twoGroups = fallbackQuotaGroupsFromTitle(
      'Session | OAI 5h80 | Cop M60 | Cd63% | Est$2.34',
      36,
    )
    const threeGroups = fallbackQuotaGroupsFromTitle(
      'Session | OAI 5h80 | Cop M60 | Ant W55 | Cd63% | Est$2.34',
      36,
    )

    assert.equal(quotaGroupsUseBullets(oneGroup), false)
    assert.equal(quotaGroupsUseBullets(twoGroups), true)
    assert.equal(quotaGroupsAreCollapsible(twoGroups), false)
    assert.equal(quotaGroupsAreCollapsible(threeGroups), true)
    assert.equal(quotaGroupsSummary(threeGroups), '(3)')
  })

  it('reflows multi-provider groups for bullet width budget', () => {
    const config = makeConfig(16)
    const now = new Date()
    const resetAt = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      12,
      34,
      0,
      0,
    ).toISOString()

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

    assert.equal(singleProvider[0]?.detail, '5h80 R12:34')
    assert.equal(singleProvider[0]?.continuationLines.length, 0)
    assert.equal(multiProvider[0]?.detail, '5h80')
    assert.deepEqual(multiProvider[0]?.continuationLines, ['    R12:34'])
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
      'Session | RC B-$3.2 | Cd63% | Est$2.34',
      36,
    )

    assert.equal(groups[0]?.tone, 'error')
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
