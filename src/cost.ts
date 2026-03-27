import type { AssistantMessage } from '@opencode-ai/sdk'

import { asNumber, isRecord } from './helpers.js'
import type { CacheCoverageMode } from './types.js'

export const API_COST_ENABLED_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'kimi-for-coding',
])

const MODEL_COST_RATE_ALIASES: Record<string, string[]> = {
  'kimi-for-coding:k2p5': ['moonshotai-cn:kimi-k2.5'],
  'kimi-for-coding:kimi-k2-thinking': ['moonshotai-cn:kimi-k2-thinking'],
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

export function canonicalApiCostProviderID(providerID: string) {
  const normalized = normalizeKnownProviderID(providerID)
  if (API_COST_ENABLED_PROVIDERS.has(normalized)) return normalized

  const lowered = providerID.toLowerCase()
  if (lowered.includes('copilot')) return 'github-copilot'
  if (lowered.includes('openai') || lowered.endsWith('-oai')) return 'openai'
  if (lowered.includes('anthropic') || lowered.includes('claude')) {
    return 'anthropic'
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

export function modelCostKey(providerID: string, modelID: string) {
  return `${providerID}:${modelID}`
}

export function modelCostLookupKeys(providerID: string, modelID: string) {
  const keys: string[] = []
  const canonicalProviderID = canonicalApiCostProviderID(providerID)

  const push = (key: string) => {
    if (!keys.includes(key)) keys.push(key)
  }

  const modelIDs =
    canonicalProviderID === 'anthropic'
      ? anthropicModelAliases(modelID)
      : [modelID]

  for (const candidateModelID of modelIDs) {
    push(modelCostKey(providerID, candidateModelID))
    if (canonicalProviderID !== providerID) {
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
