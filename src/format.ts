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

function sanitizeLine(value: string) {
  // Sidebars/titles must be plain text: no ANSI and no embedded newlines.
  return (
    stripAnsi(value)
      .replace(/\r?\n/g, ' ')
      // Remove control characters that can corrupt TUI rendering.
      .replace(/[\x00-\x1F\x7F-\x9F]/g, ' ')
  )
}

function isCombiningCodePoint(codePoint: number) {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  )
}

function isVariationSelector(codePoint: number) {
  return (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  )
}

function isWideCodePoint(codePoint: number) {
  // Based on commonly used fullwidth ranges (similar to string-width).
  // This intentionally errs toward width=2 to avoid sidebar overflow.
  if (codePoint >= 0x1100) {
    if (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    ) {
      return true
    }
  }

  // Emoji/symbol ranges (best-effort).
  if (
    (codePoint >= 0x1f300 && codePoint <= 0x1f5ff) ||
    (codePoint >= 0x1f600 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x1fa70 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2600 && codePoint <= 0x26ff) ||
    (codePoint >= 0x2700 && codePoint <= 0x27bf)
  ) {
    return true
  }

  return false
}

function cellWidthOfCodePoint(codePoint: number) {
  if (codePoint === 0) return 0
  // ZWJ sequences should not add width (best-effort).
  if (codePoint === 0x200d) return 0
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0
  if (isCombiningCodePoint(codePoint)) return 0
  if (isVariationSelector(codePoint)) return 0
  return isWideCodePoint(codePoint) ? 2 : 1
}

function stringCellWidth(value: string) {
  let width = 0
  for (const char of value) {
    width += cellWidthOfCodePoint(char.codePointAt(0) || 0)
  }
  return width
}

function padEndCells(value: string, targetWidth: number) {
  const current = stringCellWidth(value)
  if (current >= targetWidth) return value
  return `${value}${' '.repeat(targetWidth - current)}`
}

function truncateToCellWidth(value: string, width: number) {
  if (width <= 0) return ''
  let used = 0
  let out = ''
  for (const char of value) {
    const w = cellWidthOfCodePoint(char.codePointAt(0) || 0)
    if (used + w > width) break
    used += w
    out += char
  }
  return out
}

/**
 * Truncate `value` to at most `width` terminal cells.
 * Keep plain text only (no ANSI) to avoid renderer corruption.
 */
function fitLine(value: string, width: number) {
  if (width <= 0) return ''
  const safe = sanitizeLine(value)
  if (stringCellWidth(safe) <= width) return safe
  if (width <= 1) return truncateToCellWidth(safe, width)
  const head = truncateToCellWidth(safe, width - 1)
  // If we couldn't fit any characters with a suffix reserved, fall back to a
  // best-effort truncation without the suffix.
  if (!head) return truncateToCellWidth(safe, width)
  return `${head}~`
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
  const safePairs = pairs.map((pair) => ({
    label: sanitizeLine(pair.label || ''),
    value: sanitizeLine(pair.value || ''),
  }))
  const labelWidth = Math.max(
    ...safePairs.map((pair) => stringCellWidth(pair.label)),
    0,
  )
  return safePairs.map((pair) => {
    if (!pair.label) {
      return `${indent}${' '.repeat(labelWidth)}  ${pair.value}`
    }
    return `${indent}${padEndCells(pair.label, labelWidth)}  ${pair.value}`
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
      const label = sanitizeLine(quotaDisplayLabel(item))
      return Math.max(max, stringCellWidth(label))
    }, 0)

      const quotaItems = visibleQuotas
        .flatMap((item) =>
          compactQuotaWide(item, labelWidth, {
            width,
            wrapLines: config.sidebar.wrapQuotaLines,
          }),
        )
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
 *
 * When wrapLines=false (or content fits):
 *   "OpenAI 5h 80% Rst 16:20"
 *   "       Weekly 70% Rst 03-01"
 *
 * When wrapLines=true and label+content overflows width:
 *   "RC-openai"
 *   "  Daily $349.66/$180 Exp+ 02-27"
 *   "  Balance $108.88"
 */
function compactQuotaWide(
  quota: QuotaSnapshot,
  labelWidth = 0,
  options?: { width?: number; wrapLines?: boolean },
) {
  const label = sanitizeLine(quotaDisplayLabel(quota))
  const labelPadded = padEndCells(label, labelWidth)
  const indent = ' '.repeat(labelWidth + 1)
  const detailIndent = '  '
  const withLabel = (content: string) => `${labelPadded} ${content}`
  const wrap = options?.wrapLines === true && (options?.width || 0) > 0
  const width = options?.width || 0

  /** If inline version overflows, break into label-line + indented detail lines. */
  const maybeBreak = (
    inlineText: string,
    detailLines: string[],
  ): string[] => {
    const inline = withLabel(inlineText)
    if (!wrap || stringCellWidth(inline) <= width) return [inline]
    return [label, ...detailLines.map((d) => `${detailIndent}${d}`)]
  }

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
        ? [sanitizeLine(win.label), pct]
        : [sanitizeLine(win.label)]
      : [pct]
    const reset = compactReset(win.resetAt, win.resetLabel)
    if (reset) {
      parts.push(`${sanitizeLine(win.resetLabel || 'Rst')} ${reset}`)
    }
    return parts.join(' ')
  }

  // Multi-window rendering
  if (quota.windows && quota.windows.length > 0) {
    const parts = quota.windows.map(renderWindow)

    // Build the detail lines (window texts + optional balance)
    const details = [...parts]
    if (balanceText && !parts.some((p) => p.includes('Balance '))) {
      details.push(balanceText)
    }

    // Try inline first (single window, fits in one line)
    if (parts.length === 1) {
      const firstInline = withLabel(parts[0])
      if (!wrap || stringCellWidth(firstInline) <= width) {
        // Inline fits — use classic layout
        const lines = [firstInline]
        if (balanceText && !parts[0].includes('Balance ')) {
          lines.push(`${indent}${balanceText}`)
        }
        return lines
      }
      // Overflow — break: label on its own line, details indented
      return [label, ...details.map((d) => `${detailIndent}${d}`)]
    }

    // Multiple windows: try classic inline layout first
    const firstInline = withLabel(parts[0])
    if (!wrap || stringCellWidth(firstInline) <= width) {
      const lines = [
        firstInline,
        ...parts.slice(1).map((part) => `${indent}${part}`),
      ]
      if (balanceText && !parts.some((p) => p.includes('Balance '))) {
        lines.push(`${indent}${balanceText}`)
      }
      return lines
    }

    // Overflow — break all
    return [label, ...details.map((d) => `${detailIndent}${d}`)]
  }

  if (balanceText) {
    return maybeBreak(balanceText, [balanceText])
  }

  // Fallback: single value from top-level remainingPercent
  const percent =
    quota.remainingPercent === undefined
      ? '?'
      : `${Math.round(quota.remainingPercent)}%`
  const reset = compactReset(quota.resetAt, 'Rst')
  const fallbackText = `Remaining ${percent}${reset ? ` Rst ${reset}` : ''}`
  return maybeBreak(fallbackText, [fallbackText])
}
function compactReset(iso: string | undefined, resetLabel?: string) {
  if (!iso) return undefined
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return undefined

  const value = new Date(timestamp)

  // RightCode subscriptions are displayed as an expiry date (MM-DD), not a time.
  // Using UTC here makes the output stable across time zones for ISO `...Z` input.
  if (typeof resetLabel === 'string' && resetLabel.startsWith('Exp')) {
    const two = (num: number) => `${num}`.padStart(2, '0')
    return `${two(value.getUTCMonth() + 1)}-${two(value.getUTCDate())}`
  }

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

  const mdCell = (value: string) => sanitizeLine(value).replace(/\|/g, '\\|')

  const rightCodeSubscriptionProviderIDs = new Set(
    collapseQuotaSnapshots(quotas)
      .filter((quota) => quota.adapterID === 'rightcode')
      .filter((quota) => quota.status === 'ok')
      .filter((quota) => Array.isArray(quota.windows) && quota.windows.length)
      .filter((quota) => quota.windows![0].label.startsWith('Daily $'))
      .map((quota) => quota.providerID),
  )

  const measuredCostCell = (providerID: string, cost: number) => {
    const canonical = canonicalProviderID(providerID)
    const isSubscription =
      canonical === 'openai' ||
      canonical === 'github-copilot' ||
      rightCodeSubscriptionProviderIDs.has(providerID)
    if (isSubscription) return '-'
    return `$${cost.toFixed(3)}`
  }

  const isSubscriptionMeasuredProvider = (providerID: string) => {
    const canonical = canonicalProviderID(providerID)
    return (
      canonical === 'openai' ||
      canonical === 'github-copilot' ||
      rightCodeSubscriptionProviderIDs.has(providerID)
    )
  }

  const apiCostCell = (providerID: string, apiCost: number) => {
    const canonical = canonicalProviderID(providerID)
    if (canonical === 'github-copilot') return '-'
    if (!Number.isFinite(apiCost) || apiCost <= 0) return '$0.00'
    return `$${apiCost.toFixed(2)}`
  }

  const measuredCostSummaryValue = () => {
    const providers = Object.values(usage.providers)
    if (providers.length === 0) return `$${usage.cost.toFixed(4)}`
    const hasNonSubscription = providers.some(
      (provider) => !isSubscriptionMeasuredProvider(provider.providerID),
    )
    if (!hasNonSubscription) return '-'
    return `$${usage.cost.toFixed(4)}`
  }

  const apiCostSummaryValue = () => {
    const providers = Object.values(usage.providers)
    if (providers.length === 0) return formatApiCostValue(usage.apiCost)
    const hasNonCopilot = providers.some(
      (provider) =>
        canonicalProviderID(provider.providerID) !== 'github-copilot',
    )
    if (!hasNonCopilot) return '-'
    return formatApiCostValue(usage.apiCost)
  }

  const providerRows = Object.values(usage.providers)
    .sort((a, b) => b.total - a.total)
    .map((provider) => {
      const providerID = mdCell(provider.providerID)
      return showCost
        ? `| ${providerID} | ${shortNumber(provider.input)} | ${shortNumber(provider.output)} | ${shortNumber(provider.cacheRead + provider.cacheWrite)} | ${shortNumber(provider.total)} | ${measuredCostCell(provider.providerID, provider.cost)} | ${apiCostCell(provider.providerID, provider.apiCost)} |`
        : `| ${providerID} | ${shortNumber(provider.input)} | ${shortNumber(provider.output)} | ${shortNumber(provider.cacheRead + provider.cacheWrite)} | ${shortNumber(provider.total)} |`
    })

  const quotaLines = collapseQuotaSnapshots(quotas).flatMap((quota) => {
    // Multi-window detail
    if (quota.windows && quota.windows.length > 0 && quota.status === 'ok') {
      return quota.windows.map((win) => {
        if (win.showPercent === false) {
          const winLabel = win.label ? ` (${win.label})` : ''
          return mdCell(
            `- ${quota.label}${winLabel}: ${quota.status} | reset ${dateLine(win.resetAt)}`,
          )
        }
        const remaining =
          win.remainingPercent === undefined
            ? '-'
            : `${win.remainingPercent.toFixed(1)}%`
        const winLabel = win.label ? ` (${win.label})` : ''
        return mdCell(
          `- ${quota.label}${winLabel}: ${quota.status} | remaining ${remaining} | reset ${dateLine(win.resetAt)}`,
        )
      })
    }
    if (quota.status === 'ok' && quota.balance) {
      return [
        mdCell(
          `- ${quota.label}: ${quota.status} | balance ${quota.balance.currency}${quota.balance.amount.toFixed(2)}`,
        ),
      ]
    }
    const remaining =
      quota.remainingPercent === undefined
        ? '-'
        : `${quota.remainingPercent.toFixed(1)}%`
    return [
      mdCell(
        `- ${quota.label}: ${quota.status} | remaining ${remaining} | reset ${dateLine(quota.resetAt)}${quota.note ? ` | ${quota.note}` : ''}`,
      ),
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
          `- Measured cost: ${measuredCostSummaryValue()}`,
          `- API cost: ${apiCostSummaryValue()}`,
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
      const hasAnyUsage = Object.keys(usage.providers).length > 0
      lines.push(fitLine(hasAnyUsage ? '  N/A (Copilot)' : '  -', width))
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
          const reset = compactReset(win.resetAt, win.resetLabel)
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
      const reset = compactReset(item.resetAt, 'Rst')
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
