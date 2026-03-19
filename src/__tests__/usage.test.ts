import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  emptyUsageSummary,
  getCacheCoverageMetrics,
  getProviderCacheCoverageMetrics,
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

  it('does not create cacheBuckets when neither side has them', () => {
    const a = makeSummary({ input: 100 })
    const b = makeSummary({ input: 200 })
    // Ensure neither starts with buckets
    a.cacheBuckets = undefined
    b.cacheBuckets = undefined
    mergeUsage(a, b)
    assert.equal(a.cacheBuckets, undefined)
  })

  it('merges cacheBuckets from source into target', () => {
    const a = makeSummary({ input: 100 })
    a.cacheBuckets = undefined
    const b = makeSummary({
      input: 200,
      cacheBuckets: {
        readOnly: {
          input: 50,
          cacheRead: 30,
          cacheWrite: 0,
          assistantMessages: 1,
        },
        readWrite: {
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          assistantMessages: 0,
        },
      },
    })
    mergeUsage(a, b)
    assert.ok(a.cacheBuckets)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buckets = a.cacheBuckets as any
    assert.equal(buckets.readOnly.input, 50)
    assert.equal(buckets.readOnly.cacheRead, 30)
  })

  it('can merge child usage without adding measured cost', () => {
    const a = makeSummary({
      cost: 0.5,
      apiCost: 0.1,
      providers: {
        openai: {
          providerID: 'openai',
          input: 10,
          output: 5,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 15,
          cost: 0.5,
          apiCost: 0.1,
          assistantMessages: 1,
        },
      },
    })
    const b = makeSummary({
      input: 20,
      output: 10,
      total: 30,
      cost: 3,
      apiCost: 0.2,
      providers: {
        openai: {
          providerID: 'openai',
          input: 20,
          output: 10,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 30,
          cost: 3,
          apiCost: 0.2,
          assistantMessages: 1,
        },
      },
    })

    mergeUsage(a, b, { includeCost: false })

    assert.equal(a.cost, 0.5)
    assert.ok(Math.abs(a.apiCost - 0.3) < 1e-9)
    assert.equal(a.providers.openai.cost, 0.5)
    assert.ok(Math.abs(a.providers.openai.apiCost - 0.3) < 1e-9)
    assert.equal(a.providers.openai.input, 30)
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

describe('getCacheCoverageMetrics', () => {
  it('derives both cache metrics from explicit cache buckets', () => {
    const summary = makeSummary({
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
    })

    const metrics = getCacheCoverageMetrics(summary)
    assert.equal(metrics.cacheCoverage, 0.6)
    assert.equal(metrics.cacheReadCoverage, 0.75)
  })

  it('falls back to top-level cache totals for read-only legacy summaries', () => {
    const metrics = getCacheCoverageMetrics(
      makeSummary({
        input: 1500,
        cacheRead: 2500,
        cacheWrite: 0,
        assistantMessages: 3,
        cacheBuckets: undefined,
      }),
    )

    assert.equal(metrics.cacheCoverage, undefined)
    assert.equal(metrics.cacheReadCoverage, 0.625)
  })

  it('reports 0% when bucket has input but zero cache tokens', () => {
    const metrics = getCacheCoverageMetrics(
      makeSummary({
        cacheBuckets: {
          readOnly: {
            input: 500,
            cacheRead: 0,
            cacheWrite: 0,
            assistantMessages: 2,
          },
          readWrite: {
            input: 300,
            cacheRead: 0,
            cacheWrite: 0,
            assistantMessages: 1,
          },
        },
      }),
    )

    // input > 0 means the bucket has traffic, so coverage should be 0, not undefined
    assert.equal(metrics.cacheCoverage, 0)
    assert.equal(metrics.cacheReadCoverage, 0)
  })

  it('returns undefined for both metrics when all buckets are zero', () => {
    const metrics = getCacheCoverageMetrics(
      makeSummary({
        input: 500,
        output: 200,
        cacheRead: 0,
        cacheWrite: 0,
        assistantMessages: 2,
        cacheBuckets: {
          readOnly: { input: 0, cacheRead: 0, cacheWrite: 0, assistantMessages: 0 },
          readWrite: { input: 0, cacheRead: 0, cacheWrite: 0, assistantMessages: 0 },
        },
      }),
    )

    assert.equal(metrics.cacheCoverage, undefined)
    assert.equal(metrics.cacheReadCoverage, undefined)
  })

  it('returns undefined for both metrics when no cache data at all', () => {
    const metrics = getCacheCoverageMetrics(
      makeSummary({
        input: 1000,
        cacheRead: 0,
        cacheWrite: 0,
        assistantMessages: 5,
        cacheBuckets: undefined,
      }),
    )

    assert.equal(metrics.cacheCoverage, undefined)
    assert.equal(metrics.cacheReadCoverage, undefined)
  })

  it('falls back to read-write bucket for legacy summaries with cacheWrite > 0', () => {
    const metrics = getCacheCoverageMetrics(
      makeSummary({
        input: 400,
        cacheRead: 300,
        cacheWrite: 300,
        assistantMessages: 2,
        cacheBuckets: undefined,
      }),
    )

    assert.equal(metrics.cacheCoverage, 0.6)
    assert.equal(metrics.cacheReadCoverage, undefined)
  })

  it('merges explicit buckets with residual fallback totals', () => {
    const metrics = getCacheCoverageMetrics(
      makeSummary({
        input: 250,
        cacheRead: 120,
        cacheWrite: 30,
        assistantMessages: 2,
        cacheBuckets: {
          readOnly: {
            input: 100,
            cacheRead: 50,
            cacheWrite: 0,
            assistantMessages: 1,
          },
          readWrite: {
            input: 0,
            cacheRead: 0,
            cacheWrite: 0,
            assistantMessages: 0,
          },
        },
      }),
    )

    // Residual totals are interpreted as read-write because cacheWrite > 0:
    // read-only coverage = 50 / (100 + 50)
    // read-write coverage = (70 + 30) / (150 + 70 + 30)
    assert.equal(metrics.cacheReadCoverage, 50 / 150)
    assert.equal(metrics.cacheCoverage, 100 / 250)
  })
})

describe('getProviderCacheCoverageMetrics', () => {
  it('derives provider-level cache metrics from provider cache buckets', () => {
    const metrics = getProviderCacheCoverageMetrics({
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      assistantMessages: 0,
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
    })

    assert.equal(metrics.cacheCoverage, 0.6)
    assert.equal(metrics.cacheReadCoverage, 0.75)
  })
})

describe('toCachedSessionUsage / fromCachedSessionUsage round-trip with cacheBuckets', () => {
  it('preserves cacheBuckets through serialization round-trip', () => {
    const original = makeSummary({
      input: 700,
      output: 200,
      cacheRead: 1200,
      cacheWrite: 300,
      total: 2400,
      assistantMessages: 4,
      cacheBuckets: {
        readOnly: { input: 300, cacheRead: 900, cacheWrite: 0, assistantMessages: 2 },
        readWrite: { input: 400, cacheRead: 300, cacheWrite: 300, assistantMessages: 2 },
      },
    })

    const cached = toCachedSessionUsage(original)
    const restored = fromCachedSessionUsage(cached, 1)

    assert.deepEqual(restored.cacheBuckets, original.cacheBuckets)

    const metrics = getCacheCoverageMetrics(restored)
    assert.equal(metrics.cacheCoverage, 0.6)
    assert.equal(metrics.cacheReadCoverage, 0.75)
  })

  it('round-trips undefined cacheBuckets as undefined', () => {
    const original = makeSummary({
      input: 100,
      cacheRead: 0,
      cacheWrite: 0,
      cacheBuckets: undefined,
    })

    const cached = toCachedSessionUsage(original)
    const restored = fromCachedSessionUsage(cached, 1)

    assert.equal(restored.cacheBuckets, undefined)
  })

  it('handles partial cacheBuckets where only readOnly is present', () => {
    const original = makeSummary({
      input: 300,
      cacheRead: 900,
      cacheWrite: 0,
      cacheBuckets: {
        readOnly: {
          input: 300,
          cacheRead: 900,
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
    })

    const cached = toCachedSessionUsage(original)
    const restored = fromCachedSessionUsage(cached, 1)

    const metrics = getCacheCoverageMetrics(restored)
    assert.equal(metrics.cacheReadCoverage, 0.75)
    assert.equal(metrics.cacheCoverage, undefined)
  })
})
