import type { QuotaSnapshot } from './types.js'

const SUPPORTED_QUOTA_PROVIDER_IDS = new Set([
  'openai',
  'github-copilot',
  'anthropic',
  'kimi-for-coding',
  'zhipuai-coding-plan',
  'minimax-cn-coding-plan',
  'rightcode',
])

const SUPPORTED_QUOTA_TITLE_LABELS = new Set([
  'OAI',
  'Cop',
  'Ant',
  'Kimi',
  'Zhipu',
  'MiniMax',
  'RC',
])

export function isSupportedQuotaProviderID(providerID: string) {
  if (providerID.startsWith('github-copilot')) return true
  if (providerID.startsWith('rightcode-')) return true
  return SUPPORTED_QUOTA_PROVIDER_IDS.has(providerID)
}

export function isSupportedQuotaSnapshot(
  quota: Pick<QuotaSnapshot, 'providerID' | 'adapterID'>,
) {
  if (typeof quota.adapterID === 'string' && quota.adapterID) {
    return isSupportedQuotaProviderID(quota.adapterID)
  }
  return isSupportedQuotaProviderID(quota.providerID)
}

export function isSupportedQuotaTitleLabel(label: string) {
  if (SUPPORTED_QUOTA_TITLE_LABELS.has(label)) return true
  return /^RC-[^\s]+$/.test(label)
}
