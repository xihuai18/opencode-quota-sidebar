import type { QuotaSidebarConfig, QuotaSnapshot } from './types.js'
import type { UsageSummary } from './usage.js'
import {
  canonicalProviderID,
  collapseQuotaSnapshots,
  displayShortLabel,
  quotaDisplayLabel,
} from './quota_render.js'
import { stripAnsi } from './title.js'

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

function formatApiCostValue(value: number) {
  const safe = Number.isFinite(value) && value > 0 ? value : 0
  return `$${safe.toFixed(2)}`
}

function formatApiCostLine(value: number) {
  return `${formatApiCostValue(value)} as API cost`
}

function alignPairs(
  pairs: Array<{ label: string; value: string }>,
  indent = '  ',
) {
  if (pairs.length === 0) return [] as string[]
  const labelWidth = Math.max(...pairs.map((pair) => pair.label.length), 0)
  return pairs.map((pair) => {
    if (!pair.label) {
      return `${indent}${' '.repeat(labelWidth)}  ${pair.value}`
    }
    return `${indent}${pair.label.padEnd(labelWidth)}  ${pair.value}`
  })
}

/**
 * Render sidebar title with multi-line token breakdown.
 *
 * Layout:
 *   Session title
 *   Input 18.9k  Output 53
 *   Cache Read 1.5k           (only if read > 0)
 *   Cache Write 200           (only if write > 0)
 *   $3.81 as API cost         (only if showCost=true)
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

  const safeBaseTitle =
    stripAnsi(baseTitle || 'Session').split(/\r?\n/, 1)[0] || 'Session'
  lines.push(fitLine(safeBaseTitle, width))
  lines.push('')

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
  if (config.sidebar.showCost && usage.apiCost > 0) {
    lines.push(fitLine(formatApiCostLine(usage.apiCost), width))
  }

  // Quota lines (one provider per line for stable wrapping)
  if (config.sidebar.showQuota) {
    const visibleQuotas = collapseQuotaSnapshots(quotas).filter((q) =>
      ['ok', 'error', 'unsupported', 'unavailable'].includes(q.status),
    )
    const labelWidth = visibleQuotas.reduce((max, item) => {
      const label = quotaDisplayLabel(item)
      return Math.max(max, label.length)
    }, 0)

    const quotaItems = visibleQuotas
      .flatMap((item) => compactQuotaWide(item, labelWidth))
      .filter((s): s is string => Boolean(s))
    if (quotaItems.length > 0) {
      lines.push('')
    }
    for (const line of quotaItems) {
      lines.push(fitLine(line, width))
    }
  }

  return lines.join('\n')
}

/**
 * Multi-window quota format for sidebar.
 * Single window:  "OpenAI 5h 80% Rst 16:20"
 * Multi window:   "OpenAI 5h 80% Rst 16:20" + indented next line
 * Copilot:        "Copilot Monthly 70% Rst 03-01"
 */
function compactQuotaWide(quota: QuotaSnapshot, labelWidth = 0) {
  const label = quotaDisplayLabel(quota)

  const labelPadding = ' '.repeat(Math.max(0, labelWidth - label.length))
  const withLabel = (content: string) => `${label}${labelPadding} ${content}`

  if (quota.status === 'error') return [withLabel('Remaining ?')]
  if (quota.status === 'unsupported') return [withLabel('unsupported')]
  if (quota.status === 'unavailable') return [withLabel('unavailable')]
  if (quota.status !== 'ok') return []

  const balanceText = quota.balance
    ? `Balance ${quota.balance.currency}${quota.balance.amount.toFixed(2)}`
    : undefined

  const renderWindow = (win: NonNullable<QuotaSnapshot['windows']>[number]) => {
    const showPercent = win.showPercent !== false
    const pct =
      win.remainingPercent === undefined
        ? '?'
        : `${Math.round(win.remainingPercent)}%`
    const parts = win.label
      ? showPercent
        ? [win.label, pct]
        : [win.label]
      : [pct]
    const reset = compactReset(win.resetAt)
    if (reset) {
      parts.push(`${win.resetLabel || 'Rst'} ${reset}`)
    }
    return parts.join(' ')
  }

  // Multi-window rendering
  if (quota.windows && quota.windows.length > 0) {
    const parts = quota.windows.map(renderWindow)
    if (parts.length === 1) {
      const first = withLabel(parts[0])
      if (balanceText && !parts[0].includes('Balance ')) {
        const indent = ' '.repeat(labelWidth + 1)
        return [first, `${indent}${balanceText}`]
      }
      return [first]
    }
    const indent = ' '.repeat(labelWidth + 1)
    const lines = [
      withLabel(parts[0]),
      ...parts.slice(1).map((part) => `${indent}${part}`),
    ]
    const alreadyHasBalance = parts.some((part) => part.includes('Balance '))
    if (balanceText && !alreadyHasBalance) {
      lines.push(`${indent}${balanceText}`)
    }
    return lines
  }

  if (balanceText) {
    return [withLabel(balanceText)]
  }

  // Fallback: single value from top-level remainingPercent
  const percent =
    quota.remainingPercent === undefined
      ? '?'
      : `${Math.round(quota.remainingPercent)}%`
  const reset = compactReset(quota.resetAt)
  return [withLabel(`Remaining ${percent}${reset ? ` Rst ${reset}` : ''}`)]
}

function compactReset(iso: string | undefined) {
  if (!iso) return undefined
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return undefined

  const value = new Date(timestamp)
  const now = new Date()
  const sameDay =
    value.getFullYear() === now.getFullYear() &&
    value.getMonth() === now.getMonth() &&
    value.getDate() === now.getDate()

  const two = (num: number) => `${num}`.padStart(2, '0')
  if (sameDay) {
    return `${two(value.getHours())}:${two(value.getMinutes())}`
  }
  return `${two(value.getMonth() + 1)}-${two(value.getDate())}`
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

  const measuredCostCell = (providerID: string, cost: number) => {
    const canonical = canonicalProviderID(providerID)
    const isSubscription =
      canonical === 'openai' ||
      canonical === 'github-copilot' ||
      providerID.startsWith('rightcode')
    if (isSubscription) return '-'
    return `$${cost.toFixed(3)}`
  }

  const apiCostCell = (providerID: string, apiCost: number) => {
    const canonical = canonicalProviderID(providerID)
    if (canonical === 'github-copilot') return '-'
    if (!Number.isFinite(apiCost) || apiCost <= 0) return '$0.00'
    return `$${apiCost.toFixed(2)}`
  }

  const providerRows = Object.values(usage.providers)
    .sort((a, b) => b.total - a.total)
    .map((provider) =>
      showCost
        ? `| ${provider.providerID} | ${shortNumber(provider.input)} | ${shortNumber(provider.output)} | ${shortNumber(provider.cacheRead + provider.cacheWrite)} | ${shortNumber(provider.total)} | ${measuredCostCell(provider.providerID, provider.cost)} | ${apiCostCell(provider.providerID, provider.apiCost)} |`
        : `| ${provider.providerID} | ${shortNumber(provider.input)} | ${shortNumber(provider.output)} | ${shortNumber(provider.cacheRead + provider.cacheWrite)} | ${shortNumber(provider.total)} |`,
    )

  const quotaLines = collapseQuotaSnapshots(quotas).flatMap((quota) => {
    // Multi-window detail
    if (quota.windows && quota.windows.length > 0 && quota.status === 'ok') {
      return quota.windows.map((win) => {
        if (win.showPercent === false) {
          const winLabel = win.label ? ` (${win.label})` : ''
          return `- ${quota.label}${winLabel}: ${quota.status} | reset ${dateLine(win.resetAt)}`
        }
        const remaining =
          win.remainingPercent === undefined
            ? '-'
            : `${win.remainingPercent.toFixed(1)}%`
        const winLabel = win.label ? ` (${win.label})` : ''
        return `- ${quota.label}${winLabel}: ${quota.status} | remaining ${remaining} | reset ${dateLine(win.resetAt)}`
      })
    }
    if (quota.status === 'ok' && quota.balance) {
      return [
        `- ${quota.label}: ${quota.status} | balance ${quota.balance.currency}${quota.balance.amount.toFixed(2)}`,
      ]
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
    `- Tokens: input ${usage.input}, output ${usage.output}, cache_read ${usage.cacheRead}, cache_write ${usage.cacheWrite}, total ${usage.total}`,
    ...(showCost
      ? [
          `- Measured cost: $${usage.cost.toFixed(4)}`,
          `- API cost: ${formatApiCostValue(usage.apiCost)}`,
        ]
      : []),
    '',
    '### Usage by Provider',
    showCost
      ? '| Provider | Input | Output | Cache | Total | Measured Cost | API Cost |'
      : '| Provider | Input | Output | Cache | Total |',
    showCost
      ? '|---|---:|---:|---:|---:|---:|---:|'
      : '|---|---:|---:|---:|---:|',
    ...(providerRows.length
      ? providerRows
      : [showCost ? '| - | - | - | - | - | - | - |' : '| - | - | - | - | - |']),
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
  options?: { showCost?: boolean; width?: number },
) {
  const width = Math.max(24, Math.floor(options?.width || 56))
  const showCost = options?.showCost !== false
  const lines: string[] = []
  lines.push(
    fitLine(
      `${periodLabel(period)} - Total ${shortNumber(usage.total)}`,
      width,
    ),
  )
  lines.push('')
  lines.push(fitLine('Token Usage', width))

  const tokenPairs: Array<{ label: string; value: string }> = [
    { label: 'Input', value: shortNumber(usage.input) },
    { label: 'Output', value: shortNumber(usage.output) },
  ]
  if (usage.cacheRead > 0) {
    tokenPairs.push({
      label: 'Cache Read',
      value: shortNumber(usage.cacheRead),
    })
  }
  if (usage.cacheWrite > 0) {
    tokenPairs.push({
      label: 'Cache Write',
      value: shortNumber(usage.cacheWrite),
    })
  }
  if (showCost) {
    if (usage.apiCost > 0) {
      tokenPairs.push({
        label: 'API Cost',
        value: formatApiCostValue(usage.apiCost),
      })
    }
  }

  lines.push(...alignPairs(tokenPairs).map((line) => fitLine(line, width)))

  if (showCost) {
    const costPairs = Object.values(usage.providers)
      .filter(
        (provider) =>
          canonicalProviderID(provider.providerID) !== 'github-copilot',
      )
      .filter((provider) => provider.apiCost > 0)
      .sort((left, right) => right.apiCost - left.apiCost)
      .map((provider) => ({
        label: displayShortLabel(provider.providerID),
        value: `$${provider.apiCost.toFixed(2)}`,
      }))

    lines.push('')
    lines.push(fitLine('Cost as API', width))
    if (costPairs.length > 0) {
      lines.push(...alignPairs(costPairs).map((line) => fitLine(line, width)))
    } else {
      lines.push(fitLine('  No provider usage in this range', width))
    }
  }

  const quotaPairs = collapseQuotaSnapshots(quotas).flatMap((item) => {
    if (item.status === 'ok') {
      if (item.windows && item.windows.length > 0) {
        const pairs = item.windows.map((win, idx) => {
          const showPercent = win.showPercent !== false
          const pct =
            win.remainingPercent === undefined
              ? '-'
              : `${win.remainingPercent.toFixed(1)}%`
          const reset = compactReset(win.resetAt)
          const parts = [win.label]
          if (showPercent) parts.push(pct)
          if (reset) parts.push(`${win.resetLabel || 'Rst'} ${reset}`)
          return {
            label: idx === 0 ? quotaDisplayLabel(item) : '',
            value: parts.filter(Boolean).join(' '),
          }
        })

        if (item.balance) {
          pairs.push({
            label: '',
            value: `Balance ${item.balance.currency}${item.balance.amount.toFixed(2)}`,
          })
        }

        return pairs
      }

      if (item.balance) {
        return [
          {
            label: quotaDisplayLabel(item),
            value: `Balance ${item.balance.currency}${item.balance.amount.toFixed(2)}`,
          },
        ]
      }

      const percent =
        item.remainingPercent === undefined
          ? '-'
          : `${item.remainingPercent.toFixed(1)}%`
      const reset = compactReset(item.resetAt)
      return [
        {
          label: quotaDisplayLabel(item),
          value: `Remaining ${percent}${reset ? ` Rst ${reset}` : ''}`,
        },
      ]
    }

    if (item.status === 'unsupported') {
      return [{ label: quotaDisplayLabel(item), value: 'unsupported' }]
    }
    if (item.status === 'unavailable') {
      return [{ label: quotaDisplayLabel(item), value: 'unavailable' }]
    }
    return [{ label: quotaDisplayLabel(item), value: 'Remaining ?' }]
  })

  if (quotaPairs.length > 0) {
    lines.push('')
    lines.push(fitLine('Quota', width))
    lines.push(...alignPairs(quotaPairs).map((line) => fitLine(line, width)))
  }

  return lines.join('\n')
}
