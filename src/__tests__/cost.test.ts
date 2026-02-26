import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  calcEquivalentApiCostForMessage,
  canonicalApiCostProviderID,
  parseModelCostRates,
} from '../cost.js'

describe('cost', () => {
  it('parses model cost rates from mixed shapes', () => {
    assert.deepEqual(parseModelCostRates({}), undefined)

    assert.deepEqual(
      parseModelCostRates({ input: 1, output: 2, cache_read: 0.5 }),
      {
        input: 1,
        output: 2,
        cacheRead: 0.5,
        cacheWrite: 0,
      },
    )

    assert.deepEqual(
      parseModelCostRates({
        prompt: '3',
        completion: { per_1m: 4 },
        cache: { read: { usd: 0.5 }, write: { value: 0 } },
      }),
      {
        input: 3,
        output: 4,
        cacheRead: 0.5,
        cacheWrite: 0,
      },
    )
  })

  it('normalizes equivalent API cost for per-1m pricing', () => {
    const message = {
      tokens: {
        input: 1_000_000,
        output: 500_000,
        reasoning: 999_999,
        cache: { read: 0, write: 0 },
      },
    }
    const cost = calcEquivalentApiCostForMessage(message as never, {
      input: 2,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
    })

    // (1,000,000 * 2 + (500,000 + 999,999) * 4) / 1,000,000 = 7.999996
    // Reasoning is billed as output.
    assert.equal(cost, 7.999996)
  })

  it('keeps equivalent API cost for per-token pricing', () => {
    const message = {
      tokens: {
        input: 1000,
        output: 500,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }
    const cost = calcEquivalentApiCostForMessage(message as never, {
      input: 0.000002,
      output: 0.000004,
      cacheRead: 0,
      cacheWrite: 0,
    })
    assert.equal(cost, 0.004)
  })

  it('canonicalizes provider IDs for billing attribution', () => {
    assert.equal(canonicalApiCostProviderID('openai'), 'openai')
    assert.equal(canonicalApiCostProviderID('OpenAI-Codex'), 'openai')
    assert.equal(
      canonicalApiCostProviderID('github-copilot-enterprise'),
      'github-copilot',
    )
    assert.equal(canonicalApiCostProviderID('claude'), 'anthropic')
  })
})
