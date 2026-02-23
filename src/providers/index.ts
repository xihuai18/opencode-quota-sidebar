import { anthropicAdapter } from './anthropic.js'
import { copilotAdapter } from './copilot.js'
import { openaiAdapter } from './openai.js'
import { QuotaProviderRegistry } from './registry.js'
import { rightCodeAdapter } from './rightcode.js'

export function createDefaultProviderRegistry() {
  const registry = new QuotaProviderRegistry()
  registry.register(rightCodeAdapter)
  registry.register(openaiAdapter)
  registry.register(copilotAdapter)
  registry.register(anthropicAdapter)
  return registry
}

export {
  anthropicAdapter,
  copilotAdapter,
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
