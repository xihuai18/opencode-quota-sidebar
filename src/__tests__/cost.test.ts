import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  API_COST_ENABLED_PROVIDERS,
  cacheCoverageModeFromRates,
  calcEquivalentApiCostForMessage,
  canonicalApiCostProviderID,
  canonicalPricingProviderID,
  getBundledModelCostMap,
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
    assert.equal(canonicalApiCostProviderID('rightcode-openai'), 'openai')
    assert.equal(canonicalApiCostProviderID('xyai-openai'), 'openai')
    assert.equal(
      canonicalApiCostProviderID('github-copilot-enterprise'),
      'github-copilot',
    )
    assert.equal(canonicalApiCostProviderID('claude'), 'anthropic')
    assert.equal(canonicalApiCostProviderID('relay-anthropic'), 'anthropic')
    assert.equal(
      canonicalApiCostProviderID('kimi-for-coding'),
      'kimi-for-coding',
    )
    assert.equal(canonicalApiCostProviderID('zhipuai-coding-plan'), 'zhipu')
    assert.equal(
      canonicalApiCostProviderID('minimax-cn-coding-plan'),
      'minimax-cn-coding-plan',
    )
    assert.equal(canonicalApiCostProviderID('z-ai'), 'zhipu')
  })

  it('maps kimi-for-coding k2p5 to moonshot pricing keys', () => {
    assert.deepEqual(modelCostLookupKeys('kimi-for-coding', 'k2p5'), [
      'kimi-for-coding:k2p5',
      'kimi-for-coding:kimi-k2.5',
      'moonshotai:kimi-k2.5',
    ])
    assert.deepEqual(
      modelCostLookupKeys('kimi-for-coding', 'kimi-k2-thinking'),
      ['kimi-for-coding:kimi-k2-thinking', 'moonshotai:kimi-k2-thinking'],
    )
    assert.ok(
      !modelCostLookupKeys('kimi-for-coding', 'k2p5').includes(
        'moonshotai:k2p5',
      ),
    )
  })

  it('maps zhipu coding plan models to zhipu pricing keys', () => {
    const direct = modelCostLookupKeys('zhipuai-coding-plan', 'glm-5')
    assert.ok(direct.includes('zhipuai-coding-plan:glm-5'))
    assert.ok(direct.includes('zhipu:glm-5'))
    assert.ok(modelCostLookupKeys('z-ai', 'glm-5.1').includes('zhipu:glm-5'))
    assert.ok(
      modelCostLookupKeys('zhipuai-coding-plan', 'glm-5-thinking').includes(
        'zhipu:glm-5',
      ),
    )
    assert.ok(
      modelCostLookupKeys('zhipuai-coding-plan', 'zhipu/glm-4.5-air').includes(
        'zhipu:glm-4.5-air',
      ),
    )
  })

  it('maps minimax coding plan models to minimax pricing keys', () => {
    const direct = modelCostLookupKeys(
      'minimax-cn-coding-plan',
      'MiniMax-M2.5-highspeed',
    )
    assert.ok(direct.includes('minimax-cn-coding-plan:MiniMax-M2.5-highspeed'))
    assert.ok(direct.includes('minimax:MiniMax-M2.5-highspeed'))
    assert.equal(
      canonicalPricingProviderID('minimax-cn-coding-plan'),
      'minimax',
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

    const vertexStyle = modelCostLookupKeys(
      'anthropic',
      'claude-sonnet-4-5@20250929',
    )
    assert.ok(vertexStyle.includes('anthropic:claude-sonnet-4-5@20250929'))
    assert.ok(vertexStyle.includes('anthropic:claude-sonnet-4-5-20250929'))
    assert.ok(vertexStyle.includes('anthropic:claude-sonnet-4-5'))

    const bedrockStyle = modelCostLookupKeys(
      'anthropic',
      'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
    )
    assert.ok(
      bedrockStyle.includes(
        'anthropic:global.anthropic.claude-sonnet-4-5-20250929-v1:0',
      ),
    )
    assert.ok(
      bedrockStyle.includes('anthropic:anthropic/claude-sonnet-4-5-20250929'),
    )
    assert.ok(bedrockStyle.includes('anthropic:claude-sonnet-4-5'))

    const thirdParty = modelCostLookupKeys(
      'relay-anthropic',
      'claude-sonnet-4-5',
    )
    assert.ok(thirdParty.includes('relay-anthropic:claude-sonnet-4-5'))
    assert.ok(thirdParty.includes('anthropic:claude-sonnet-4-5'))
    assert.ok(thirdParty.includes('relay-anthropic:claude-sonnet-4.5'))
    assert.ok(thirdParty.includes('anthropic:claude-sonnet-4.5'))
  })

  it('ships bundled Anthropic fallback pricing for current Claude models', () => {
    const map = getBundledModelCostMap()
    const longContext = map['anthropic:claude-sonnet-4-5']?.contextOver200k

    assert.deepEqual(map['anthropic:claude-opus-4-6'], {
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
      contextOver200k: undefined,
    })
    assert.equal(map['anthropic:claude-opus-4.6']?.output, 25)
    assert.equal(map['anthropic:claude-haiku-4-5']?.input, 1)
    assert.equal(longContext?.input, 6)
    assert.equal(longContext?.output, 22.5)
    assert.ok(Math.abs((longContext?.cacheRead || 0) - 0.6) < 1e-12)
    assert.equal(longContext?.cacheWrite, 7.5)
  })

  it('ships bundled OpenAI fallback pricing for GPT-5 family models', () => {
    const map = getBundledModelCostMap()

    assert.equal(map['openai:gpt-5']?.input, 2.5)
    assert.equal(map['openai:gpt-5']?.output, 15)
    assert.equal(map['openai:gpt-5']?.cacheRead, 0.25)
    assert.equal(map['openai:gpt-5']?.cacheWrite, 0)
    assert.equal(map['openai:gpt-5.3']?.input, 1.75)
    assert.equal(map['openai:gpt-5.3-chat-latest']?.cacheRead, 0.175)
    assert.equal(map['openai:gpt-5.3-codex']?.output, 14)
    assert.equal(map['openai:gpt-5.2']?.input, 1.75)
    assert.equal(map['openai:gpt-5.2-chat-latest']?.cacheRead, 0.175)
    assert.equal(map['openai:gpt-5.2-pro']?.output, 168)
    assert.equal(map['openai:gpt-5.4']?.output, 15)
    assert.equal(map['openai:gpt-5-mini']?.input, 0.75)
    assert.equal(map['openai:gpt-5.4-mini']?.cacheRead, 0.075)
    assert.equal(map['openai:gpt-5-nano']?.output, 1.25)
    assert.equal(map['openai:gpt-5.4-nano']?.cacheRead, 0.02)
  })

  it('ships bundled Zhipu fallback pricing for current coding-plan models', () => {
    const map = getBundledModelCostMap()

    assert.equal(map['zhipu:glm-5']?.input, 1)
    assert.equal(map['zhipu:glm-5']?.output, 3.2)
    assert.ok(Math.abs((map['zhipu:glm-5']?.cacheRead || 0) - 0.2) < 1e-12)
    assert.equal(map['zhipu:glm-5']?.cacheWrite, 0)
    assert.equal(map['zhipu:glm-4.7']?.input, 0.6)
    assert.equal(map['zhipu:glm-4.6']?.output, 2.2)
    assert.equal(map['zhipu:glm-4.5-air']?.input, 0.2)
    assert.equal(map['zhipu:glm-4.5v']?.output, 1.8)
  })

  it('ships bundled Moonshot international pricing for Kimi models', () => {
    const map = getBundledModelCostMap()

    assert.equal(map['moonshotai:kimi-k2.5']?.input, 0.6)
    assert.equal(map['moonshotai:kimi-k2.5']?.output, 3)
    assert.ok(
      Math.abs((map['moonshotai:kimi-k2.5']?.cacheRead || 0) - 0.1) < 1e-12,
    )
    assert.equal(map['moonshotai:kimi-k2-thinking']?.output, 2.5)
    assert.equal(map['moonshotai:kimi-k2-turbo-preview']?.output, 10)
    assert.equal(map['moonshotai:kimi-k2-thinking-turbo']?.input, 1.15)
  })

  it('ships bundled MiniMax fallback pricing for coding-plan models', () => {
    const map = getBundledModelCostMap()

    assert.equal(map['minimax:MiniMax-M2.7']?.input, 0.3)
    assert.equal(map['minimax:MiniMax-M2.7']?.cacheRead, 0.06)
    assert.equal(map['minimax:MiniMax-M2.5']?.output, 1.2)
    assert.equal(map['minimax:MiniMax-M2.5']?.cacheRead, 0.03)
    assert.equal(map['minimax:MiniMax-M2.5-highspeed']?.output, 2.4)
    assert.equal(map['minimax:MiniMax-M2.1']?.cacheWrite, 0.375)
    assert.equal(map['minimax:MiniMax-M2']?.cacheWrite, 0)
  })

  it('treats kimi-for-coding as API-cost-enabled', () => {
    assert.equal(API_COST_ENABLED_PROVIDERS.has('kimi-for-coding'), true)
  })

  it('treats zhipu as API-cost-enabled', () => {
    assert.equal(API_COST_ENABLED_PROVIDERS.has('zhipu'), true)
  })

  it('treats minimax coding plan as API-cost-enabled', () => {
    assert.equal(API_COST_ENABLED_PROVIDERS.has('minimax-cn-coding-plan'), true)
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
