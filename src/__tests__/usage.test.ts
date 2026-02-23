import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  emptyUsageSummary,
  mergeUsage,
  toCachedSessionUsage,
  fromCachedSessionUsage,
} from '../usage.js'
import type { UsageSummary } from '../usage.js'

function makeSummary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return { ...emptyUsageSummary(), ...overrides }
}

describe('mergeUsage', () => {
  it('merges two summaries', () => {
    const a = makeSummary({
      input: 100,
      output: 50,
      total: 150,
      cost: 0.01,
      apiCost: 0.5,
    })
    const b = makeSummary({
      input: 200,
      output: 100,
      total: 300,
      cost: 0.02,
      apiCost: 0.8,
    })
    const result = mergeUsage(a, b)
    assert.equal(result.input, 300)
    assert.equal(result.output, 150)
    assert.equal(result.total, 450)
    assert.equal(result.cost, 0.03)
    assert.equal(result.apiCost, 1.3)
  })

  it('does not double-count reasoning when output is already merged', () => {
    const a = makeSummary({ input: 100, output: 80, reasoning: 0, total: 180 })
    const b = makeSummary({ input: 200, output: 150, reasoning: 0, total: 350 })
    const result = mergeUsage(a, b)
    assert.equal(result.output, 230)
  })

  it('merges provider usage', () => {
    const a = makeSummary({
      providers: {
        openai: {
          providerID: 'openai',
          input: 100,
          output: 50,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 150,
          cost: 0.01,
          apiCost: 0.3,
          assistantMessages: 1,
        },
      },
    })
    const b = makeSummary({
      providers: {
        openai: {
          providerID: 'openai',
          input: 200,
          output: 100,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 300,
          cost: 0.02,
          apiCost: 0.7,
          assistantMessages: 2,
        },
      },
    })
    mergeUsage(a, b)
    assert.equal(a.providers.openai.input, 300)
    assert.equal(a.providers.openai.apiCost, 1)
    assert.equal(a.providers.openai.assistantMessages, 3)
  })
})

describe('toCachedSessionUsage / fromCachedSessionUsage', () => {
  it('restores with reasoning merged into output', () => {
    const summary = makeSummary({
      input: 100,
      output: 50,
      reasoning: 10,
      cacheRead: 5,
      cacheWrite: 3,
      total: 168,
      cost: 0.01,
      apiCost: 0.45,
      assistantMessages: 2,
      sessionCount: 1,
      providers: {
        openai: {
          providerID: 'openai',
          input: 100,
          output: 50,
          reasoning: 10,
          cacheRead: 5,
          cacheWrite: 3,
          total: 168,
          cost: 0.01,
          apiCost: 0.45,
          assistantMessages: 2,
        },
      },
    })

    const cached = toCachedSessionUsage(summary)
    const restored = fromCachedSessionUsage(cached, 1)

    assert.equal(restored.input, summary.input)
    assert.equal(restored.output, summary.output + summary.reasoning)
    assert.equal(restored.reasoning, 0)
    assert.equal(restored.total, summary.total)
    assert.equal(restored.cost, summary.cost)
    assert.equal(restored.apiCost, summary.apiCost)
    assert.equal(restored.sessionCount, 1)
    assert.equal(restored.providers.openai.input, 100)
    assert.equal(restored.providers.openai.output, 60)
    assert.equal(restored.providers.openai.reasoning, 0)
    assert.equal(restored.providers.openai.apiCost, 0.45)
  })
})
