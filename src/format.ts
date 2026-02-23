import type { QuotaSidebarConfig, QuotaSnapshot } from './types.js'
import type { UsageSummary } from './usage.js'

function shortNumber(value: number, decimals = 1) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(decimals)}m`
  if (value >= 1000) return `${(value / 1000).toFixed(decimals)}k`
  return `${Math.round(value)}`
}

function clampText(value: string, width: number) {
  if (value.length <= width) return value
  if (width <= 1) return value.slice(0, width)
  return `${value.slice(0, width - 1)}~`
}

function lineUsage(usage: UsageSummary, width: number) {
  // Full format: i<input> o<output> r<reasoning> cr<cacheRead> cw<cacheWrite> t<total>
  // Adaptive: skip zero fields, merge cache, reduce decimals to fit width

  const full = (d: number) => {
    const parts: string[] = []
    parts.push(`i${shortNumber(usage.input, d)}`)
    parts.push(`o${shortNumber(usage.output, d)}`)
    if (usage.reasoning > 0) parts.push(`r${shortNumber(usage.reasoning, d)}`)
    if (usage.cacheRead > 0) parts.push(`cr${shortNumber(usage.cacheRead, d)}`)
    if (usage.cacheWrite > 0)
      parts.push(`cw${shortNumber(usage.cacheWrite, d)}`)
    parts.push(`t${shortNumber(usage.total, d)}`)
    return parts.join(' ')
  }

  const merged = (d: number) => {
    const parts: string[] = []
    parts.push(`i${shortNumber(usage.input, d)}`)
    parts.push(`o${shortNumber(usage.output, d)}`)
    if (usage.reasoning > 0) parts.push(`r${shortNumber(usage.reasoning, d)}`)
    const cache = usage.cacheRead + usage.cacheWrite
    if (cache > 0) parts.push(`c${shortNumber(cache, d)}`)
    parts.push(`t${shortNumber(usage.total, d)}`)
    return parts.join(' ')
  }

  // Prefer keeping all fields over merging; reduce decimals before merging
  const candidates = [full(1), full(0), merged(1), merged(0)]
  const fit = candidates.find((c) => c.length <= width)
  return clampText(fit ?? candidates[candidates.length - 1], width)
}

function compactQuota(quota: QuotaSnapshot) {
  const code =
    quota.providerID === 'openai'
      ? 'o'
      : quota.providerID === 'github-copilot'
        ? 'g'
        : quota.providerID === 'anthropic'
          ? 'a'
          : quota.providerID.slice(0, 1)

  if (quota.status !== 'ok') return `${code}?`
  const percent =
    quota.remainingPercent === undefined
      ? '?'
      : `${Math.round(quota.remainingPercent)}`
  return `${code}${percent}%`
}

function lineFooter(
  usage: UsageSummary,
  quotas: QuotaSnapshot[],
  config: QuotaSidebarConfig,
  width: number,
) {
  const cost = config.sidebar.showCost ? `$${usage.cost.toFixed(3)}` : ''
  const quotaItems = config.sidebar.showQuota
    ? quotas
        .slice(0, config.sidebar.maxQuotaProviders)
        .map((item) => compactQuota(item))
        .join(' ')
    : ''
  const line = [cost, quotaItems].filter((item) => item).join(' ')
  if (!line) return ''
  return clampText(line, width)
}

export function renderSidebarTitle(
  baseTitle: string,
  usage: UsageSummary,
  quotas: QuotaSnapshot[],
  config: QuotaSidebarConfig,
) {
  const width = config.sidebar.width
  const title = clampText(baseTitle || 'Session', width)
  const body = lineUsage(usage, width)
  const footer = lineFooter(usage, quotas, config, width)
  return [title, body, footer].filter((line) => line).join('\n')
}

function dateLine(iso: string | undefined) {
  if (!iso) return '-'
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  return new Date(time).toLocaleString()
}

function periodLabel(period: string) {
  if (period === 'day') return 'Today'
  if (period === 'week') return 'This Week'
  if (period === 'month') return 'This Month'
  return 'Current Session'
}

export function renderMarkdownReport(
  period: string,
  usage: UsageSummary,
  quotas: QuotaSnapshot[],
) {
  const providers = Object.values(usage.providers)
    .sort((a, b) => b.total - a.total)
    .map(
      (provider) =>
        `| ${provider.providerID} | ${shortNumber(provider.input)} | ${shortNumber(provider.output)} | ${shortNumber(provider.reasoning)} | ${shortNumber(provider.cacheRead + provider.cacheWrite)} | ${shortNumber(provider.total)} | $${provider.cost.toFixed(3)} |`,
    )

  const quotaLines = quotas.map((quota) => {
    const remaining =
      quota.remainingPercent === undefined
        ? '-'
        : `${quota.remainingPercent.toFixed(1)}%`
    return `- ${quota.label}: ${quota.status} | remaining ${remaining} | reset ${dateLine(quota.resetAt)}${quota.note ? ` | ${quota.note}` : ''}`
  })

  return [
    `## Quota Report - ${periodLabel(period)}`,
    '',
    `- Sessions: ${usage.sessionCount}`,
    `- Assistant messages: ${usage.assistantMessages}`,
    `- Tokens: input ${usage.input}, output ${usage.output}, reasoning ${usage.reasoning}, cache ${usage.cacheRead + usage.cacheWrite}, total ${usage.total}`,
    `- Cost: $${usage.cost.toFixed(4)}`,
    '',
    '### Usage by Provider',
    '| Provider | Input | Output | Reasoning | Cache | Total | Cost |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...(providers.length ? providers : ['| - | - | - | - | - | - | - |']),
    '',
    '### Subscription Quota',
    ...(quotaLines.length
      ? quotaLines
      : ['- no provider quota data available']),
  ].join('\n')
}

export function renderToastMessage(
  period: string,
  usage: UsageSummary,
  quotas: QuotaSnapshot[],
) {
  const heading = `${periodLabel(period)} - t${shortNumber(usage.total)} $${usage.cost.toFixed(3)}`
  const quota = quotas
    .map((item) => {
      if (item.status !== 'ok') return `${item.label}: ${item.status}`
      const percent =
        item.remainingPercent === undefined
          ? '-'
          : `${item.remainingPercent.toFixed(1)}%`
      return `${item.label}: ${percent}`
    })
    .join('\n')
  return [heading, quota].filter((line) => line).join('\n')
}
