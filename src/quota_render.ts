import type { QuotaSnapshot } from './types.js'

const PROVIDER_SHORT_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  'github-copilot': 'Copilot',
  anthropic: 'Anthropic',
  rightcode: 'RC',
}

export function canonicalProviderID(providerID: string) {
  if (providerID.startsWith('github-copilot')) return 'github-copilot'
  return providerID
}

export function displayShortLabel(providerID: string) {
  const canonical = canonicalProviderID(providerID)
  const direct = PROVIDER_SHORT_LABELS[canonical]
  if (direct) return direct
  if (canonical.startsWith('rightcode-')) {
    return `RC-${canonical.slice('rightcode-'.length)}`
  }
  return providerID
}

export function quotaDisplayLabel(quota: QuotaSnapshot) {
  if (quota.shortLabel) return quota.shortLabel
  if (quota.adapterID) {
    const adapterLabel = displayShortLabel(quota.adapterID)
    if (adapterLabel !== quota.adapterID) return adapterLabel
  }
  return displayShortLabel(quota.providerID)
}

function quotaKey(quota: QuotaSnapshot) {
  if (quota.adapterID === 'rightcode') return `rightcode:${quota.providerID}`
  return `${quota.adapterID || quota.providerID}:${quota.providerID}`
}

function quotaScore(quota: QuotaSnapshot) {
  let score = 0
  if (quota.status === 'ok') score += 10
  if (quota.windows && quota.windows.length > 0) {
    score += 5 + quota.windows.length
  }
  if (quota.balance) score += 3
  if (quota.remainingPercent !== undefined) score += 1
  return score
}

export function collapseQuotaSnapshots(quotas: QuotaSnapshot[]) {
  const grouped = new Map<string, QuotaSnapshot>()
  const hasRightCodeBase = quotas.some(
    (quota) =>
      quota.adapterID === 'rightcode' && quotaDisplayLabel(quota) === 'RC',
  )

  for (const quota of quotas) {
    // If both RC (balance) and RC-variant (subscription) exist,
    // treat balance as owned by RC.
    const normalizedQuota =
      hasRightCodeBase &&
      quota.adapterID === 'rightcode' &&
      quotaDisplayLabel(quota).startsWith('RC-')
        ? { ...quota, balance: undefined }
        : quota

    const key = quotaKey(normalizedQuota)
    const existing = grouped.get(key)
    if (!existing) {
      grouped.set(key, normalizedQuota)
      continue
    }

    const primary =
      quotaScore(normalizedQuota) >= quotaScore(existing)
        ? normalizedQuota
        : existing
    const secondary = primary === normalizedQuota ? existing : normalizedQuota

    grouped.set(key, {
      ...primary,
      windows:
        primary.windows && primary.windows.length > 0
          ? primary.windows
          : secondary.windows,
      balance: primary.balance || secondary.balance,
      remainingPercent:
        primary.remainingPercent !== undefined
          ? primary.remainingPercent
          : secondary.remainingPercent,
      resetAt: primary.resetAt || secondary.resetAt,
      note: primary.note || secondary.note,
    })
  }

  return [...grouped.values()]
}
