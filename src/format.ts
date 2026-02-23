import type { QuotaSidebarConfig, QuotaSnapshot } from './types.js'
import type { UsageSummary } from './usage.js'

/** M6 fix: handle negative, NaN, Infinity gracefully. */
function shortNumber(value: number, decimals = 1) {
  if (!Number.isFinite(value) || value < 0) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(decimals)}m`
  if (value >= 1000) {
    const k = value / 1000
    // Avoid "1000.0k" — promote to "m" when rounding pushes past 999
    if (Number(k.toFixed(decimals)) >= 1000)
      return `${(value / 1_000_000).toFixed(decimals)}m`
    return `${k.toFixed(decimals)}k`
  }
  return `${Math.round(value)}`
}

/** Sidebar token display: adaptive short unit (k/m) with one decimal. */
function sidebarNumber(value: number) {
  return shortNumber(value, 1)
}

/**
 * Truncate `value` to at most `width` visible characters.
 * Keep plain text only (no ANSI) to avoid renderer corruption.
 */
function fitLine(value: string, width: number) {
  if (width <= 0) return ''
  if (value.length > width) {
    return width <= 1 ? value.slice(0, width) : `${value.slice(0, width - 1)}~`
  }
  return value
}

/**
 * Render sidebar title with multi-line token breakdown.
 *
 * Layout:
 *   Session title
 *   Input 18.9k  Output 53
 *   Cache Read 1.5k           (only if read > 0)
 *   Cache Write 200           (only if write > 0)
 *   Reasoning 23              (only if > 0)
 *   OpenAI Remaining 78%      (only if quota available)
 */
export function renderSidebarTitle(
  baseTitle: string,
  usage: UsageSummary,
  quotas: QuotaSnapshot[],
  config: QuotaSidebarConfig,
) {
  const width = Math.max(8, Math.floor(config.sidebar.width || 36))
  const lines: string[] = []

  lines.push(fitLine(baseTitle || 'Session', width))

  // Input / Output line
  const io = `Input ${sidebarNumber(usage.input)}  Output ${sidebarNumber(usage.output)}`
  lines.push(fitLine(io, width))

  // Cache lines (provider-compatible across OpenAI/Anthropic/Gemini/Copilot)
  if (usage.cacheRead > 0) {
    lines.push(fitLine(`Cache Read ${sidebarNumber(usage.cacheRead)}`, width))
  }
  if (usage.cacheWrite > 0) {
    lines.push(fitLine(`Cache Write ${sidebarNumber(usage.cacheWrite)}`, width))
  }

  // Reasoning line (only if non-zero)
  if (usage.reasoning > 0) {
    lines.push(fitLine(`Reasoning ${sidebarNumber(usage.reasoning)}`, width))
  }

  // Quota lines (one provider per line for stable wrapping)
  if (config.sidebar.showQuota) {
    const quotaItems = quotas
      .filter((q) => q.status === 'ok' || q.status === 'error')
      .slice(0, config.sidebar.maxQuotaProviders)
      .map((item) => compactQuotaWide(item))
      .filter((s): s is string => Boolean(s))
    for (const line of quotaItems) {
      lines.push(fitLine(line, width))
    }
  }

  return lines.join('\n')
}

/**
 * Multi-window quota format for sidebar.
 * Single window:  "OpenAI Remaining 5h 80%"
 * Multi window:   "OpenAI 5h 80% Weekly 70%"
 * Copilot:        "Copilot Monthly 70%"
 */
function compactQuotaWide(quota: QuotaSnapshot) {
  const label =
    quota.providerID === 'openai'
      ? 'OpenAI'
      : quota.providerID === 'github-copilot'
        ? 'Copilot'
        : quota.providerID === 'anthropic'
          ? 'Claude'
          : quota.providerID.slice(0, 8)

  if (quota.status === 'error') return `${label} Remaining ?`
  if (quota.status !== 'ok') return ''

  // Multi-window rendering
  if (quota.windows && quota.windows.length > 0) {
    const parts = quota.windows.map((win) => {
      const pct =
        win.remainingPercent === undefined
          ? '?'
          : `${Math.round(win.remainingPercent)}%`
      return win.label ? `${win.label} ${pct}` : pct
    })
    if (parts.length === 1) {
      return `${label} Remaining ${parts[0]}`
    }
    // Multiple windows: compact format without "Remaining"
    return `${label} ${parts.join(' - ')}`
  }

  // Fallback: single value from top-level remainingPercent
  const percent =
    quota.remainingPercent === undefined
      ? '?'
      : `${Math.round(quota.remainingPercent)}%`
  return `${label} Remaining ${percent}`
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
  options?: { showCost?: boolean },
) {
  const showCost = options?.showCost !== false
  const providers = Object.values(usage.providers)
    .sort((a, b) => b.total - a.total)
    .map((provider) =>
      showCost
        ? `| ${provider.providerID} | ${shortNumber(provider.input)} | ${shortNumber(provider.output)} | ${shortNumber(provider.reasoning)} | ${shortNumber(provider.cacheRead + provider.cacheWrite)} | ${shortNumber(provider.total)} | $${provider.cost.toFixed(3)} |`
        : `| ${provider.providerID} | ${shortNumber(provider.input)} | ${shortNumber(provider.output)} | ${shortNumber(provider.reasoning)} | ${shortNumber(provider.cacheRead + provider.cacheWrite)} | ${shortNumber(provider.total)} |`,
    )

  const quotaLines = quotas.flatMap((quota) => {
    // Multi-window detail
    if (quota.windows && quota.windows.length > 0 && quota.status === 'ok') {
      return quota.windows.map((win) => {
        const remaining =
          win.remainingPercent === undefined
            ? '-'
            : `${win.remainingPercent.toFixed(1)}%`
        const winLabel = win.label ? ` (${win.label})` : ''
        return `- ${quota.label}${winLabel}: ${quota.status} | remaining ${remaining} | reset ${dateLine(win.resetAt)}`
      })
    }
    const remaining =
      quota.remainingPercent === undefined
        ? '-'
        : `${quota.remainingPercent.toFixed(1)}%`
    return [
      `- ${quota.label}: ${quota.status} | remaining ${remaining} | reset ${dateLine(quota.resetAt)}${quota.note ? ` | ${quota.note}` : ''}`,
    ]
  })

  return [
    `## Quota Report - ${periodLabel(period)}`,
    '',
    `- Sessions: ${usage.sessionCount}`,
    `- Assistant messages: ${usage.assistantMessages}`,
    `- Tokens: input ${usage.input}, output ${usage.output}, reasoning ${usage.reasoning}, cache_read ${usage.cacheRead}, cache_write ${usage.cacheWrite}, total ${usage.total}`,
    ...(showCost ? [`- Cost: $${usage.cost.toFixed(4)}`] : []),
    '',
    '### Usage by Provider',
    showCost
      ? '| Provider | Input | Output | Reasoning | Cache | Total | Cost |'
      : '| Provider | Input | Output | Reasoning | Cache | Total |',
    showCost
      ? '|---|---:|---:|---:|---:|---:|---:|'
      : '|---|---:|---:|---:|---:|---:|',
    ...(providers.length
      ? providers
      : [
          showCost
            ? '| - | - | - | - | - | - | - |'
            : '| - | - | - | - | - | - |',
        ]),
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
  const lines: string[] = []
  lines.push(`${periodLabel(period)} - Total ${shortNumber(usage.total)}`)
  lines.push(
    `Input ${shortNumber(usage.input)}  Output ${shortNumber(usage.output)}`,
  )
  if (usage.cacheRead > 0)
    lines.push(`Cache Read ${shortNumber(usage.cacheRead)}`)
  if (usage.cacheWrite > 0)
    lines.push(`Cache Write ${shortNumber(usage.cacheWrite)}`)
  if (usage.reasoning > 0)
    lines.push(`Reasoning ${shortNumber(usage.reasoning)}`)

  const quotaLines = quotas.flatMap((item) => {
    if (item.status === 'ok') {
      // Multi-window
      if (item.windows && item.windows.length > 0) {
        const parts = item.windows.map((win) => {
          const pct =
            win.remainingPercent === undefined
              ? '-'
              : `${win.remainingPercent.toFixed(1)}%`
          return win.label ? `${win.label} ${pct}` : pct
        })
        return [`${item.label} Remaining ${parts.join(' | ')}`]
      }
      const percent =
        item.remainingPercent === undefined
          ? '-'
          : `${item.remainingPercent.toFixed(1)}%`
      return [`${item.label} Remaining ${percent}`]
    }
    if (item.status === 'unsupported') return [`${item.label}: unsupported`]
    if (item.status === 'unavailable') return [`${item.label}: unavailable`]
    return [`${item.label} Remaining ?`]
  })
  lines.push(...quotaLines)

  return lines.filter((line) => line).join('\n')
}
