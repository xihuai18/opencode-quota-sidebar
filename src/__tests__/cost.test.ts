import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  API_COST_ENABLED_PROVIDERS,
  cacheCoverageModeFromRates,
  calcEquivalentApiCostForMessage,
  canonicalApiCostProviderID,
  modelCostLookupKeys,
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
        contextOver200k: undefined,
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
        contextOver200k: undefined,
      },
    )

    assert.deepEqual(
      parseModelCostRates({
        input: 1,
        output: 2,
        context_over_200k: {
          input: 10,
          output: 20,
          cache_read: 3,
          cache_write: 4,
        },
      }),
      {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        contextOver200k: {
          input: 10,
          output: 20,
          cacheRead: 3,
          cacheWrite: 4,
        },
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

  it('uses context_over_200k rates for the full request once threshold is exceeded', () => {
    const message = {
      tokens: {
        input: 250_000,
        output: 10_000,
        reasoning: 5_000,
        cache: { read: 20_000, write: 5_000 },
      },
    }
    const cost = calcEquivalentApiCostForMessage(message as never, {
      input: 1,
      output: 2,
      cacheRead: 0.5,
      cacheWrite: 0.25,
      contextOver200k: {
        input: 3,
        output: 6,
        cacheRead: 1.5,
        cacheWrite: 0.75,
      },
    })

    // All tokens use the premium tier when input exceeds 200k.
    // (250k*3 + 15k*6 + 20k*1.5 + 5k*0.75) / 1,000,000 = 0.87375
    assert.equal(cost, 0.87375)
  })

  it('keeps base rates when input stays at or below the 200k threshold', () => {
    const message = {
      tokens: {
        input: 200_000,
        output: 10_000,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }
    const cost = calcEquivalentApiCostForMessage(message as never, {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      contextOver200k: {
        input: 3,
        output: 6,
        cacheRead: 0,
        cacheWrite: 0,
      },
    })

    assert.equal(cost, 0.22)
  })

  it('canonicalizes provider IDs for billing attribution', () => {
    assert.equal(canonicalApiCostProviderID('openai'), 'openai')
    assert.equal(canonicalApiCostProviderID('OpenAI-Codex'), 'openai')
    assert.equal(
      canonicalApiCostProviderID('github-copilot-enterprise'),
      'github-copilot',
    )
    assert.equal(canonicalApiCostProviderID('claude'), 'anthropic')
    assert.equal(
      canonicalApiCostProviderID('kimi-for-coding'),
      'kimi-for-coding',
    )
  })

  it('maps kimi-for-coding k2p5 to moonshot pricing keys', () => {
    assert.deepEqual(modelCostLookupKeys('kimi-for-coding', 'k2p5'), [
      'kimi-for-coding:k2p5',
      'moonshotai-cn:kimi-k2.5',
    ])
    assert.deepEqual(
      modelCostLookupKeys('kimi-for-coding', 'kimi-k2-thinking'),
      ['kimi-for-coding:kimi-k2-thinking', 'moonshotai-cn:kimi-k2-thinking'],
    )
  })

  it('adds anthropic model aliases for dated and dotted claude IDs', () => {
    const dated = modelCostLookupKeys('anthropic', 'claude-3.7-sonnet-20250219')
    assert.ok(dated.includes('anthropic:claude-3.7-sonnet-20250219'))
    assert.ok(dated.includes('anthropic:claude-3.7-sonnet'))
    assert.ok(dated.includes('anthropic:claude-3-7-sonnet'))

    const opencodeCurrent = modelCostLookupKeys(
      'anthropic',
      'anthropic/claude-sonnet-4-5-20250929-thinking',
    )
    assert.ok(
      opencodeCurrent.includes(
        'anthropic:anthropic/claude-sonnet-4-5-20250929-thinking',
      ),
    )
    assert.ok(opencodeCurrent.includes('anthropic:claude-sonnet-4-5-20250929'))
    assert.ok(opencodeCurrent.includes('anthropic:claude-sonnet-4-5'))
    assert.ok(opencodeCurrent.includes('anthropic:anthropic/claude-sonnet-4-5'))

    const thirdParty = modelCostLookupKeys(
      'buzz-anthropic',
      'claude-sonnet-4-5',
    )
    assert.ok(thirdParty.includes('buzz-anthropic:claude-sonnet-4-5'))
    assert.ok(thirdParty.includes('anthropic:claude-sonnet-4-5'))
    assert.ok(thirdParty.includes('buzz-anthropic:claude-sonnet-4.5'))
    assert.ok(thirdParty.includes('anthropic:claude-sonnet-4.5'))
  })

  it('treats kimi-for-coding as API-cost-enabled', () => {
    assert.equal(API_COST_ENABLED_PROVIDERS.has('kimi-for-coding'), true)
  })

  it('classifies cache coverage mode from pricing rates', () => {
    assert.equal(cacheCoverageModeFromRates(undefined), 'none')

    assert.equal(
      cacheCoverageModeFromRates({
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
      }),
      'none',
    )

    assert.equal(
      cacheCoverageModeFromRates({
        input: 1,
        output: 2,
        cacheRead: 0.5,
        cacheWrite: 0,
      }),
      'read-only',
    )

    assert.equal(
      cacheCoverageModeFromRates({
        input: 1,
        output: 2,
        cacheRead: 0.5,
        cacheWrite: 1.25,
      }),
      'read-write',
    )

    // write-only (unusual but valid)
    assert.equal(
      cacheCoverageModeFromRates({
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 1.25,
      }),
      'read-write',
    )
  })
})
