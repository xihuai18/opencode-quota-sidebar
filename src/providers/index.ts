import { anthropicAdapter } from './core/anthropic.js'
import { copilotAdapter } from './core/copilot.js'
import { kimiForCodingAdapter } from './core/kimi_for_coding.js'
import { minimaxCnCodingPlanAdapter } from './core/minimax_cn_coding_plan.js'
import { openaiAdapter } from './core/openai.js'
import { zhipuCodingPlanAdapter } from './core/zhipu_coding_plan.js'
import { QuotaProviderRegistry } from './registry.js'
import { rightCodeAdapter } from './third_party/rightcode.js'

export function createDefaultProviderRegistry() {
  const registry = new QuotaProviderRegistry()
  registry.register(rightCodeAdapter)
  registry.register(kimiForCodingAdapter)
  registry.register(zhipuCodingPlanAdapter)
  registry.register(minimaxCnCodingPlanAdapter)
  registry.register(openaiAdapter)
  registry.register(copilotAdapter)
  registry.register(anthropicAdapter)
  return registry
}

export {
  anthropicAdapter,
  copilotAdapter,
  kimiForCodingAdapter,
  minimaxCnCodingPlanAdapter,
  openaiAdapter,
  rightCodeAdapter,
  zhipuCodingPlanAdapter,
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
