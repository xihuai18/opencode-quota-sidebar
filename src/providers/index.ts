import { anthropicAdapter } from './core/anthropic.js'
import { buzzAdapter } from './third_party/buzz.js'
import { copilotAdapter } from './core/copilot.js'
import { minimaxAdapter } from './third_party/minimax.js'
import { kimiForCodingAdapter } from './core/kimi_for_coding.js'
import { openaiAdapter } from './core/openai.js'
import { QuotaProviderRegistry } from './registry.js'
import { rightCodeAdapter } from './third_party/rightcode.js'

export function createDefaultProviderRegistry() {
  const registry = new QuotaProviderRegistry()
  registry.register(rightCodeAdapter)
  registry.register(buzzAdapter)
  registry.register(minimaxAdapter)
  registry.register(kimiForCodingAdapter)
  registry.register(openaiAdapter)
  registry.register(copilotAdapter)
  registry.register(anthropicAdapter)
  return registry
}

export {
  anthropicAdapter,
  buzzAdapter,
  copilotAdapter,
  minimaxAdapter,
  kimiForCodingAdapter,
  openaiAdapter,
  rightCodeAdapter,
  QuotaProviderRegistry,
}

export type {
  AuthUpdate,
  AuthValue,
  ProviderResolveContext,
  QuotaFetchContext,
  QuotaProviderAdapter,
  RefreshedOAuthAuth,
} from './types.js'
