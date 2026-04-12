import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  filterHistoryProvidersForDisplay,
  filterUsageProvidersForDisplay,
} from '../provider_catalog.js'

describe('provider catalog display filters', () => {
  it('filters provider rows without changing usage totals', () => {
    const usage = {
      input: 100,
      output: 200,
      reasoning: 0,
      cacheRead: 50,
      cacheWrite: 0,
      total: 350,
      cost: 0,
      apiCost: 1.23,
      assistantMessages: 3,
      sessionCount: 1,
      providers: {
        openai: {
          providerID: 'openai',
          input: 100,
          output: 200,
          reasoning: 0,
          cacheRead: 50,
          cacheWrite: 0,
          total: 350,
          cost: 0,
          apiCost: 1.23,
          assistantMessages: 3,
        },
        legacy: {
          providerID: 'legacy',
          input: 10,
          output: 20,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 30,
          cost: 0,
          apiCost: 0.1,
          assistantMessages: 1,
        },
      },
    }

    const filtered = filterUsageProvidersForDisplay(
      usage as never,
      new Set(['openai']),
    )
    assert.deepEqual(Object.keys(filtered.providers), ['openai'])
    assert.equal(filtered.total, 350)
    assert.equal(filtered.apiCost, 1.23)
  })

  it('filters history provider maps without changing period totals', () => {
    const result = {
      period: 'day',
      since: { raw: '2026-04-10', precision: 'day', startAt: 0 },
      rows: [
        {
          range: {
            period: 'day',
            startAt: 0,
            endAt: 1,
            label: '2026-04-10',
            shortLabel: '04-10',
            isCurrent: true,
            isPartial: true,
            index: 0,
          },
          usage,
        },
      ],
      total: usage,
    }
    const filtered = filterHistoryProvidersForDisplay(
      result as never,
      new Set(['openai']),
    )
    assert.deepEqual(Object.keys(filtered.total.providers), ['openai'])
    assert.deepEqual(Object.keys(filtered.rows[0].usage.providers), ['openai'])
    assert.equal(filtered.total.total, 350)
  })
})

const usage = {
  input: 100,
  output: 200,
  reasoning: 0,
  cacheRead: 50,
  cacheWrite: 0,
  total: 350,
  cost: 0,
  apiCost: 1.23,
  assistantMessages: 3,
  sessionCount: 1,
  providers: {
    openai: {
      providerID: 'openai',
      input: 100,
      output: 200,
      reasoning: 0,
      cacheRead: 50,
      cacheWrite: 0,
      total: 350,
      cost: 0,
      apiCost: 1.23,
      assistantMessages: 3,
    },
    legacy: {
      providerID: 'legacy',
      input: 10,
      output: 20,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 30,
      cost: 0,
      apiCost: 0.1,
      assistantMessages: 1,
    },
  },
}
