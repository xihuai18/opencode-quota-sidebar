import type { AssistantMessage, Message } from '@opencode-ai/sdk'

export type ProviderUsage = {
  providerID: string
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  cost: number
  assistantMessages: number
}

export type UsageSummary = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  cost: number
  assistantMessages: number
  sessionCount: number
  providers: Record<string, ProviderUsage>
}

export type ModelPricing = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type PricingTable = Map<string, ModelPricing>

export function emptyUsageSummary(): UsageSummary {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
    assistantMessages: 0,
    sessionCount: 0,
    providers: {},
  }
}

function isAssistant(message: Message): message is AssistantMessage {
  return message.role === 'assistant'
}

function tokenTotal(message: AssistantMessage) {
  return (
    message.tokens.input +
    message.tokens.output +
    message.tokens.reasoning +
    message.tokens.cache.read +
    message.tokens.cache.write
  )
}

function modelKey(providerID: string, modelID: string) {
  return `${providerID}:${modelID}`
}

export function estimateMessageCost(
  message: AssistantMessage,
  pricing: PricingTable,
) {
  const model = pricing.get(modelKey(message.providerID, message.modelID))
  if (!model) return message.cost

  const estimated =
    (message.tokens.input * model.input +
      (message.tokens.output + message.tokens.reasoning) * model.output +
      message.tokens.cache.read * model.cacheRead +
      message.tokens.cache.write * model.cacheWrite) /
    1_000_000

  if (!Number.isFinite(estimated) || estimated < 0) return message.cost
  if (estimated === 0) return message.cost
  return estimated
}

function addMessageUsage(
  target: UsageSummary,
  message: AssistantMessage,
  cost: number,
) {
  const total = tokenTotal(message)
  target.input += message.tokens.input
  target.output += message.tokens.output
  target.reasoning += message.tokens.reasoning
  target.cacheRead += message.tokens.cache.read
  target.cacheWrite += message.tokens.cache.write
  target.total += total
  target.assistantMessages += 1
  target.cost += cost

  const provider =
    target.providers[message.providerID] ||
    ({
      providerID: message.providerID,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      cost: 0,
      assistantMessages: 0,
    } as ProviderUsage)

  provider.input += message.tokens.input
  provider.output += message.tokens.output
  provider.reasoning += message.tokens.reasoning
  provider.cacheRead += message.tokens.cache.read
  provider.cacheWrite += message.tokens.cache.write
  provider.total += total
  provider.cost += cost
  provider.assistantMessages += 1
  target.providers[message.providerID] = provider
}

export function summarizeMessages(
  entries: Array<{ info: Message }>,
  pricing: PricingTable,
  startAt = 0,
  sessionCount = 1,
) {
  const summary = emptyUsageSummary()
  summary.sessionCount = sessionCount

  for (const entry of entries) {
    if (!isAssistant(entry.info)) continue
    if (!entry.info.time.completed) continue
    if (entry.info.time.created < startAt) continue
    addMessageUsage(
      summary,
      entry.info,
      estimateMessageCost(entry.info, pricing),
    )
  }

  return summary
}

export function mergeUsage(target: UsageSummary, source: UsageSummary) {
  target.input += source.input
  target.output += source.output
  target.reasoning += source.reasoning
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.total += source.total
  target.cost += source.cost
  target.assistantMessages += source.assistantMessages

  for (const provider of Object.values(source.providers)) {
    const existing =
      target.providers[provider.providerID] ||
      ({
        providerID: provider.providerID,
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        assistantMessages: 0,
      } as ProviderUsage)

    existing.input += provider.input
    existing.output += provider.output
    existing.reasoning += provider.reasoning
    existing.cacheRead += provider.cacheRead
    existing.cacheWrite += provider.cacheWrite
    existing.total += provider.total
    existing.cost += provider.cost
    existing.assistantMessages += provider.assistantMessages
    target.providers[provider.providerID] = existing
  }

  return target
}

function asNumber(value: unknown) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  return value
}

function asRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function buildPricingTable(input: unknown) {
  const map: PricingTable = new Map()
  if (!asRecord(input)) return map
  if (!Array.isArray(input.all)) return map

  for (const provider of input.all) {
    if (!asRecord(provider)) continue
    if (typeof provider.id !== 'string') continue
    if (!asRecord(provider.models)) continue

    for (const [modelID, value] of Object.entries(provider.models)) {
      if (!asRecord(value)) continue
      if (!asRecord(value.cost)) continue
      const cacheRead = asNumber(value.cost.cache_read)
      const cacheWrite = asNumber(value.cost.cache_write)
      const pricing: ModelPricing = {
        input: asNumber(value.cost.input),
        output: asNumber(value.cost.output),
        cacheRead,
        cacheWrite,
      }
      map.set(modelKey(provider.id, modelID), pricing)
    }
  }

  return map
}
