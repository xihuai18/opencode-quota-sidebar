import type { AssistantMessage } from '@opencode-ai/sdk'

import { asNumber, isRecord } from './helpers.js'
import type { CacheCoverageMode } from './types.js'

export const API_COST_ENABLED_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'kimi-for-coding',
  'zhipu',
])

export type CanonicalPriceSource = 'official-doc' | 'runtime'

const MODEL_COST_RATE_ALIASES: Record<string, string[]> = {
  'zhipuai-coding-plan:glm-5.1': ['zhipu:glm-5'],
  'zhipuai-coding-plan:glm-5.1-thinking': ['zhipu:glm-5'],
  'zhipu:glm-5.1': ['zhipu:glm-5'],
  'zhipu:glm-5.1-thinking': ['zhipu:glm-5'],
}

function moonshotCanonicalModelID(modelID: string) {
  const stripped = modelID.replace(/^moonshotai[/:]/i, '')
  switch (stripped) {
    case 'k2p5':
    case 'kimi-k2-5':
      return 'kimi-k2.5'
    default:
      return stripped
  }
}

function moonshotModelAliases(
  modelID: string,
  options?: { canonicalProviderKeys?: boolean },
) {
  const aliases: string[] = []

  const push = (value: string) => {
    if (!value) return
    if (!aliases.includes(value)) aliases.push(value)
  }

  const stripped = modelID.replace(/^moonshotai[/:]/i, '')
  const canonical = moonshotCanonicalModelID(modelID)

  if (!options?.canonicalProviderKeys) push(modelID)
  if (stripped !== modelID) push(stripped)
  push(canonical)

  return aliases
}

function zhipuModelAliases(modelID: string) {
  const aliases: string[] = []
  const queue: string[] = []

  const push = (value: string) => {
    if (!value) return
    if (!aliases.includes(value)) {
      aliases.push(value)
      queue.push(value)
    }
  }

  push(modelID)

  for (let index = 0; index < queue.length; index++) {
    const stem = queue[index]
    const withoutProviderPrefix = stem.replace(
      /^(?:zhipu|z-ai|bigmodel|zhipuai-coding-plan)[/:]/,
      '',
    )
    push(withoutProviderPrefix)
    push(`zhipu/${withoutProviderPrefix}`)

    const withoutBillingSuffix = withoutProviderPrefix.replace(/-billing$/, '')
    push(withoutBillingSuffix)
    push(`zhipu/${withoutBillingSuffix}`)

    const withoutThinkingSuffix = withoutBillingSuffix.replace(/-thinking$/, '')
    push(withoutThinkingSuffix)
    push(`zhipu/${withoutThinkingSuffix}`)

    const dotted = withoutThinkingSuffix.replace(/(\d)-(\d)(?=-|$)/g, '$1.$2')
    push(dotted)
    push(`zhipu/${dotted}`)

    const hyphenated = withoutThinkingSuffix.replace(
      /(\d)\.(\d)(?=-|$)/g,
      '$1-$2',
    )
    push(hyphenated)
    push(`zhipu/${hyphenated}`)
  }

  return aliases
}

function anthropicModelAliases(modelID: string) {
  const aliases: string[] = []
  const queue: string[] = []

  const push = (value: string) => {
    if (!value) return
    if (!aliases.includes(value)) {
      aliases.push(value)
      queue.push(value)
    }
  }

  push(modelID)

  for (let index = 0; index < queue.length; index++) {
    const stem = queue[index]

    const withoutProviderPrefix = stem
      .replace(/^(?:[a-z]+\.)*anthropic\./, '')
      .replace(/^anthropic[/.]/, '')
    push(withoutProviderPrefix)
    push(`anthropic/${withoutProviderPrefix}`)

    const withoutVersionSuffix = withoutProviderPrefix.replace(
      /-v\d+(?::\d+)?$/,
      '',
    )
    push(withoutVersionSuffix)
    push(`anthropic/${withoutVersionSuffix}`)

    const atDate = withoutVersionSuffix.replace(/@(\d{8})$/, '-$1')
    push(atDate)
    push(`anthropic/${atDate}`)

    const withAtDate = withoutVersionSuffix.replace(/-(\d{8})$/, '@$1')
    push(withAtDate)
    push(`anthropic/${withAtDate}`)

    const withoutThinkingSuffix = withoutVersionSuffix.replace(/-thinking$/, '')
    push(withoutThinkingSuffix)
    push(`anthropic/${withoutThinkingSuffix}`)

    const withoutLatestSuffix = withoutThinkingSuffix.replace(/-latest$/, '')
    push(withoutLatestSuffix)
    push(`anthropic/${withoutLatestSuffix}`)

    const withoutDateSuffix = withoutLatestSuffix
      .replace(/-\d{8}$/, '')
      .replace(/@\d{8}$/, '')
    push(withoutDateSuffix)
    push(`anthropic/${withoutDateSuffix}`)

    const dotted = withoutDateSuffix.replace(/(\d)-(\d)(?=-|$)/g, '$1.$2')
    push(dotted)
    push(`anthropic/${dotted}`)

    const hyphenated = withoutDateSuffix.replace(/(\d)\.(\d)(?=-|$)/g, '$1-$2')
    push(hyphenated)
    push(`anthropic/${hyphenated}`)
  }

  return aliases
}

function normalizeKnownProviderID(providerID: string) {
  if (providerID.startsWith('github-copilot')) return 'github-copilot'
  return providerID
}

function isCanonicalZhipuProviderID(providerID: string) {
  return (
    providerID === 'zhipu' ||
    providerID === 'bigmodel' ||
    providerID === 'z-ai' ||
    providerID === 'zhipuai-coding-plan'
  )
}

export function canonicalPricingProviderID(providerID: string) {
  const normalized = normalizeKnownProviderID(providerID)
  const lowered = normalized.toLowerCase()

  if (isCanonicalZhipuProviderID(lowered)) {
    return 'zhipu'
  }
  if (lowered === 'kimi-for-coding') return 'moonshotai'
  if (lowered.includes('anthropic') || lowered.includes('claude')) {
    return 'anthropic'
  }
  if (lowered.includes('openai') || lowered.endsWith('-oai')) return 'openai'
  if (lowered.includes('copilot')) return 'github-copilot'
  return normalized
}

export function canonicalApiCostProviderID(providerID: string) {
  const normalized = normalizeKnownProviderID(providerID)
  if (API_COST_ENABLED_PROVIDERS.has(normalized)) return normalized

  const lowered = providerID.toLowerCase()
  if (lowered.includes('copilot')) return 'github-copilot'
  if (lowered.includes('openai') || lowered.endsWith('-oai')) return 'openai'
  if (lowered.includes('anthropic') || lowered.includes('claude')) {
    return 'anthropic'
  }
  if (isCanonicalZhipuProviderID(lowered)) {
    return 'zhipu'
  }
  return normalized
}

export type ModelCostRates = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  contextOver200k?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
}

export type CanonicalPriceEntry = {
  provider: string
  model: string
  rates: ModelCostRates
  source: CanonicalPriceSource
  sourceURL?: string
  updatedAt?: string
}

function anthropicPricing(
  input: number,
  output: number,
  options?: {
    longContextInput?: number
    longContextOutput?: number
  },
): ModelCostRates {
  // OpenCode currently reports zero Anthropic model prices in runtime metadata,
  // so keep a bundled fallback sourced from Anthropic's pricing docs.
  return {
    input,
    output,
    cacheRead: input * 0.1,
    // OpenCode only exposes aggregate cache.write tokens, so use Anthropic's
    // default 5-minute prompt-caching write rate.
    cacheWrite: input * 1.25,
    contextOver200k:
      options?.longContextInput !== undefined &&
      options?.longContextOutput !== undefined
        ? {
            input: options.longContextInput,
            output: options.longContextOutput,
            cacheRead: options.longContextInput * 0.1,
            cacheWrite: options.longContextInput * 1.25,
          }
        : undefined,
  }
}

function zhipuPricing(
  input: number,
  output: number,
  cacheRead: number,
): ModelCostRates {
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
  }
}

function moonshotPricing(
  input: number,
  output: number,
  cacheRead: number,
): ModelCostRates {
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
  }
}

const BUNDLED_CANONICAL_PRICE_ENTRIES: CanonicalPriceEntry[] = [
  {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    rates: anthropicPricing(5, 25),
    source: 'official-doc',
    sourceURL: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-4-5',
    rates: anthropicPricing(5, 25),
    source: 'official-doc',
    sourceURL: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-4-1',
    rates: anthropicPricing(15, 75),
    source: 'official-doc',
    sourceURL: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-4',
    rates: anthropicPricing(15, 75),
    source: 'official-doc',
    sourceURL: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    rates: anthropicPricing(3, 15),
    source: 'official-doc',
    sourceURL: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    rates: anthropicPricing(3, 15, {
      longContextInput: 6,
      longContextOutput: 22.5,
    }),
    source: 'official-doc',
    sourceURL: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    rates: anthropicPricing(3, 15, {
      longContextInput: 6,
      longContextOutput: 22.5,
    }),
    source: 'official-doc',
    sourceURL: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  },
  {
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    rates: anthropicPricing(3, 15),
    source: 'official-doc',
    sourceURL: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  },
  {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    rates: anthropicPricing(3, 15),
    source: 'official-doc',
    sourceURL: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  },
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    rates: anthropicPricing(1, 5),
    source: 'official-doc',
    sourceURL: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  },
  {
    provider: 'anthropic',
    model: 'claude-3-5-haiku',
    rates: anthropicPricing(0.8, 4),
    source: 'official-doc',
    sourceURL: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  },
  {
    provider: 'anthropic',
    model: 'claude-3-opus',
    rates: anthropicPricing(15, 75),
    source: 'official-doc',
    sourceURL: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  },
  {
    provider: 'anthropic',
    model: 'claude-3-haiku',
    rates: anthropicPricing(0.25, 1.25),
    source: 'official-doc',
    sourceURL: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  },
  {
    provider: 'zhipu',
    model: 'glm-5',
    rates: zhipuPricing(1, 3.2, 0.2),
    source: 'official-doc',
    sourceURL: 'https://docs.z.ai/guides/overview/pricing',
  },
  {
    provider: 'zhipu',
    model: 'glm-4.7',
    rates: zhipuPricing(0.6, 2.2, 0.11),
    source: 'official-doc',
    sourceURL: 'https://docs.z.ai/guides/overview/pricing',
  },
  {
    provider: 'zhipu',
    model: 'glm-4.6',
    rates: zhipuPricing(0.6, 2.2, 0.11),
    source: 'official-doc',
    sourceURL: 'https://docs.z.ai/guides/overview/pricing',
  },
  {
    provider: 'zhipu',
    model: 'glm-4.6v',
    rates: zhipuPricing(0.3, 0.9, 0.05),
    source: 'official-doc',
    sourceURL: 'https://docs.z.ai/guides/overview/pricing',
  },
  {
    provider: 'zhipu',
    model: 'glm-4.5',
    rates: zhipuPricing(0.6, 2.2, 0.11),
    source: 'official-doc',
    sourceURL: 'https://docs.z.ai/guides/overview/pricing',
  },
  {
    provider: 'zhipu',
    model: 'glm-4.5-air',
    rates: zhipuPricing(0.2, 1.1, 0.03),
    source: 'official-doc',
    sourceURL: 'https://docs.z.ai/guides/overview/pricing',
  },
  {
    provider: 'zhipu',
    model: 'glm-4.5v',
    rates: zhipuPricing(0.6, 1.8, 0.11),
    source: 'official-doc',
    sourceURL: 'https://docs.z.ai/guides/overview/pricing',
  },
  {
    provider: 'moonshotai',
    model: 'kimi-k2.5',
    rates: moonshotPricing(0.6, 3, 0.1),
    source: 'official-doc',
    sourceURL: 'https://platform.moonshot.ai/docs/pricing/chat',
  },
  {
    provider: 'moonshotai',
    model: 'kimi-k2-thinking',
    rates: moonshotPricing(0.6, 2.5, 0.15),
    source: 'official-doc',
    sourceURL: 'https://platform.moonshot.ai/docs/pricing/chat',
  },
  {
    provider: 'moonshotai',
    model: 'kimi-k2-0711-preview',
    rates: moonshotPricing(0.6, 2.5, 0.15),
    source: 'official-doc',
    sourceURL: 'https://platform.moonshot.ai/docs/pricing/chat',
  },
  {
    provider: 'moonshotai',
    model: 'kimi-k2-0905-preview',
    rates: moonshotPricing(0.6, 2.5, 0.15),
    source: 'official-doc',
    sourceURL: 'https://platform.moonshot.ai/docs/pricing/chat',
  },
  {
    provider: 'moonshotai',
    model: 'kimi-k2-turbo-preview',
    rates: moonshotPricing(2.4, 10, 0.6),
    source: 'official-doc',
    sourceURL: 'https://platform.moonshot.ai/docs/pricing/chat',
  },
  {
    provider: 'moonshotai',
    model: 'kimi-k2-thinking-turbo',
    rates: moonshotPricing(1.15, 8, 0.15),
    source: 'official-doc',
    sourceURL: 'https://platform.moonshot.ai/docs/pricing/chat',
  },
]

export function modelCostKey(providerID: string, modelID: string) {
  return `${providerID}:${modelID}`
}

export function modelCostLookupKeys(providerID: string, modelID: string) {
  const keys: string[] = []
  const canonicalProviderID = canonicalPricingProviderID(providerID)

  const push = (key: string) => {
    if (!keys.includes(key)) keys.push(key)
  }

  const modelIDsFor = (options?: { canonicalProviderKeys?: boolean }) =>
    canonicalProviderID === 'anthropic'
      ? anthropicModelAliases(modelID)
      : canonicalProviderID === 'zhipu'
        ? zhipuModelAliases(modelID)
        : canonicalProviderID === 'moonshotai'
          ? moonshotModelAliases(modelID, options)
          : [modelID]

  for (const candidateModelID of modelIDsFor()) {
    push(modelCostKey(providerID, candidateModelID))
  }

  if (canonicalProviderID !== providerID) {
    for (const candidateModelID of modelIDsFor({
      canonicalProviderKeys: true,
    })) {
      push(modelCostKey(canonicalProviderID, candidateModelID))
    }
  }

  for (const key of [...keys]) {
    for (const alias of MODEL_COST_RATE_ALIASES[key] || []) {
      push(alias)
    }
  }

  return keys
}

function createBundledModelCostMap() {
  const map: Record<string, ModelCostRates> = {}

  for (const entry of BUNDLED_CANONICAL_PRICE_ENTRIES) {
    for (const key of modelCostLookupKeys(entry.provider, entry.model)) {
      map[key] = entry.rates
    }
  }

  return map
}

const BUNDLED_MODEL_COST_MAP = createBundledModelCostMap()

export function getBundledModelCostMap() {
  return { ...BUNDLED_MODEL_COST_MAP }
}

export function getBundledCanonicalPriceEntries() {
  return BUNDLED_CANONICAL_PRICE_ENTRIES.map((entry) => ({
    ...entry,
    rates: {
      ...entry.rates,
      contextOver200k: entry.rates.contextOver200k
        ? { ...entry.rates.contextOver200k }
        : undefined,
    },
  }))
}

export function parseModelCostRates(
  value: unknown,
): ModelCostRates | undefined {
  if (!isRecord(value)) return undefined

  const readRate = (input: unknown) => {
    if (typeof input === 'number') return input
    if (typeof input === 'string') {
      const parsed = Number(input)
      return Number.isFinite(parsed) ? parsed : 0
    }
    if (isRecord(input)) {
      return asNumber(
        input.usd,
        asNumber(
          input.value,
          asNumber(
            input.per_1m,
            asNumber(
              input.per1m,
              asNumber(input.per_token, asNumber(input.perToken, 0)),
            ),
          ),
        ),
      )
    }
    return 0
  }

  const cache = isRecord(value.cache) ? value.cache : undefined
  const input = readRate(value.input ?? value.prompt)
  const output = readRate(value.output ?? value.completion)
  const cacheRead = readRate(value.cache_read ?? cache?.read)
  const cacheWrite = readRate(value.cache_write ?? cache?.write)
  const contextOver200k = isRecord(value.context_over_200k)
    ? {
        input: readRate(value.context_over_200k.input),
        output: readRate(value.context_over_200k.output),
        cacheRead: readRate(value.context_over_200k.cache_read),
        cacheWrite: readRate(value.context_over_200k.cache_write),
      }
    : undefined

  if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0) {
    return undefined
  }

  const hasContextTier =
    !!contextOver200k &&
    (contextOver200k.input > 0 ||
      contextOver200k.output > 0 ||
      contextOver200k.cacheRead > 0 ||
      contextOver200k.cacheWrite > 0)

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    contextOver200k: hasContextTier ? contextOver200k : undefined,
  }
}

const MODEL_COST_DIVISOR_PER_TOKEN = 1
const MODEL_COST_DIVISOR_PER_MILLION = 1_000_000

export function guessModelCostDivisor(rates: ModelCostRates) {
  // OpenCode provider pricing units can differ:
  // - some providers expose USD per token (e.g. 0.0000025)
  // - others expose USD per 1M tokens (e.g. 2.5)
  // Heuristic: treat values > 0.001 as "per 1M".
  const maxRate = Math.max(
    rates.input,
    rates.output,
    rates.cacheRead,
    rates.cacheWrite,
  )
  return maxRate > 0.001
    ? MODEL_COST_DIVISOR_PER_MILLION
    : MODEL_COST_DIVISOR_PER_TOKEN
}

export function cacheCoverageModeFromRates(
  rates: ModelCostRates | undefined,
): CacheCoverageMode {
  if (!rates) return 'none'

  if (rates.cacheWrite > 0) return 'read-write'
  if (rates.cacheRead > 0) return 'read-only'
  return 'none'
}

export function calcEquivalentApiCostForMessage(
  message: AssistantMessage,
  rates: ModelCostRates,
) {
  const effectiveRates =
    message.tokens.input + message.tokens.cache.read > 200_000 &&
    rates.contextOver200k
      ? rates.contextOver200k
      : rates

  // For providers that expose reasoning tokens separately, they are still
  // billed as output/completion tokens (same unit price). Our UI also merges
  // reasoning into the single Output statistic, so API cost should match that.
  const billedOutput = message.tokens.output + message.tokens.reasoning
  const rawCost =
    message.tokens.input * effectiveRates.input +
    billedOutput * effectiveRates.output +
    message.tokens.cache.read * effectiveRates.cacheRead +
    message.tokens.cache.write * effectiveRates.cacheWrite

  const divisor = guessModelCostDivisor(effectiveRates)
  const normalized = rawCost / divisor
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 0
}
