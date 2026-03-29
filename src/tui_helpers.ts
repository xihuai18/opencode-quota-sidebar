import { fitLine, renderSidebarQuotaLineGroups } from './format.js'
import { collapseQuotaSnapshots } from './quota_render.js'
import type { QuotaSidebarConfig, QuotaSnapshot } from './types.js'

const VISIBLE_QUOTA_STATUSES = new Set<QuotaSnapshot['status']>([
  'ok',
  'error',
  'unsupported',
  'unavailable',
])

export type SidebarQuotaTone = 'success' | 'warning' | 'error' | 'muted'

export type SidebarQuotaGroup = {
  providerID: string
  status: QuotaSnapshot['status']
  tone: SidebarQuotaTone
  shortLabel: string
  detail: string
  continuationLines: string[]
}

function parseQuotaLineParts(lines: string[]) {
  const firstLine = lines[0]?.trimStart() || ''
  const match = /^(\S+)(?:\s+(.*))?$/.exec(firstLine)
  const shortLabel = match?.[1] || firstLine || 'Quota'
  const detail = match?.[2] || ''
  const continuationLines = lines
    .slice(1)
    .map((line) => line.trimEnd())
    .filter((line) => Boolean(line.trim()))

  return {
    shortLabel,
    detail,
    continuationLines,
  }
}

function quotaPercents(quota: QuotaSnapshot) {
  const values: number[] = []
  if (
    quota.remainingPercent !== undefined &&
    Number.isFinite(quota.remainingPercent)
  ) {
    values.push(quota.remainingPercent)
  }
  for (const window of quota.windows || []) {
    if (
      window.remainingPercent !== undefined &&
      Number.isFinite(window.remainingPercent)
    ) {
      values.push(window.remainingPercent)
    }
  }
  return values
}

function quotaTone(quota: QuotaSnapshot): SidebarQuotaTone {
  if (quota.status === 'error') return 'error'
  if (quota.status === 'unsupported' || quota.status === 'unavailable') {
    return 'muted'
  }
  if (quota.status !== 'ok') return 'muted'

  const percents = quotaPercents(quota)
  if (percents.length === 0) {
    if (quota.balance && Number.isFinite(quota.balance.amount)) {
      if (quota.balance.amount < 0) return 'error'
      return 'muted'
    }
    return 'muted'
  }

  const remaining = Math.min(...percents)
  if (remaining <= 5) return 'error'
  if (remaining <= 20) return 'warning'
  return 'success'
}

function fallbackQuotaTone(detail: string): SidebarQuotaTone {
  const safe = detail.trim()
  if (!safe) return 'muted'
  if (/\b(?:unsupported|unavailable)\b/i.test(safe)) return 'muted'
  if (/\berror\b/i.test(safe) || /^\?$/.test(safe)) return 'error'
  if (/\bB-/.test(safe)) return 'error'

  const percents = [...safe.matchAll(/\b(?:\d+[hdw]|[DWM]|S7d)(\d{1,3})\b/gi)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value))
  if (percents.length === 0) return 'muted'

  const remaining = Math.min(...percents)
  if (remaining <= 5) return 'error'
  if (remaining <= 20) return 'warning'
  return 'success'
}

export function renderSidebarQuotaGroups(
  quotas: QuotaSnapshot[],
  config: QuotaSidebarConfig,
): SidebarQuotaGroup[] {
  const visibleQuotaCount = collapseQuotaSnapshots(quotas).filter((quota) =>
    VISIBLE_QUOTA_STATUSES.has(quota.status),
  ).length
  const renderConfig =
    visibleQuotaCount > 1
      ? {
          ...config,
          sidebar: {
            ...config.sidebar,
            width: Math.max(8, config.sidebar.width - 2),
          },
        }
      : config

  return renderSidebarQuotaLineGroups(quotas, renderConfig).map((group) => {
    const parsed = parseQuotaLineParts(group.lines)
    return {
      providerID: group.quota.providerID,
      status: group.quota.status,
      tone: quotaTone(group.quota),
      shortLabel: parsed.shortLabel,
      detail: parsed.detail,
      continuationLines: parsed.continuationLines,
    }
  })
}

export function fallbackQuotaGroupsFromTitle(title: string, width: number) {
  const parts = (title || '')
    .split(' | ')
    .map((part) => part.trim())
    .filter(Boolean)
  const quotaParts = parts
    .slice(1)
    .filter((part) => !/^Cd\d/.test(part) && !/^Est\b/.test(part))
  if (quotaParts.length === 0) return [] as SidebarQuotaGroup[]

  const contentWidth = quotaParts.length > 1 ? Math.max(1, width - 2) : width

  return quotaParts.map((part, index) => {
    const line = fitLine(part, contentWidth)
    const parsed = parseQuotaLineParts([line])
    return {
      providerID: `fallback:${index}`,
      status: 'ok' as const,
      tone: fallbackQuotaTone(parsed.detail),
      shortLabel: parsed.shortLabel,
      detail: parsed.detail,
      continuationLines: parsed.continuationLines,
    }
  })
}

export function quotaGroupsUseBullets(groups: SidebarQuotaGroup[]) {
  return groups.length > 1
}

export function quotaGroupsAreCollapsible(groups: SidebarQuotaGroup[]) {
  return groups.length > 2
}

export function quotaGroupsSummary(groups: SidebarQuotaGroup[]) {
  if (groups.length === 0) return undefined
  return `(${groups.length})`
}
