import type { QuotaSidebarConfig, QuotaSnapshot } from './types.js'
import {
  getCacheCoverageMetrics,
  getProviderCacheCoverageMetrics,
  type UsageSummary,
} from './usage.js'
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

function formatCurrency(value: number, currency: string) {
  const safe = Number.isFinite(value) ? value : 0
  const prefix = typeof currency === 'string' && currency ? currency : '$'
  if (safe === 0) return `${prefix}0.00`
  if (safe < 0) {
    const abs = Math.abs(safe)
    if (abs < 10) return `-${prefix}${abs.toFixed(2)}`
    const one = abs.toFixed(1)
    const trimmed = one.endsWith('.0') ? one.slice(0, -2) : one
    return `-${prefix}${trimmed}`
  }
  if (safe < 10) return `${prefix}${safe.toFixed(2)}`
  const one = safe.toFixed(1)
  const trimmed = one.endsWith('.0') ? one.slice(0, -2) : one
  return `${prefix}${trimmed}`
}

function formatUsd(value: number) {
  return formatCurrency(value, '$')
}

function formatApiCostValue(value: number) {
  return formatUsd(value)
}

function formatApiCostLine(value: number) {
  return `${formatApiCostValue(value)} as API cost`
}

function formatRequestsLabel(value: number, short = false) {
  const count = shortNumber(value, 1)
  return short ? `Req ${count}` : `Requests ${count}`
}

export function isDesktopClient() {
  return process.env.OPENCODE_CLIENT === 'desktop'
}

function desktopCompactSettings(config: QuotaSidebarConfig) {
  return {
    recentRequests: Math.max(
      1,
      config.sidebar.desktopCompact?.recentRequests ?? 50,
    ),
    recentMinutes: Math.max(
      1,
      config.sidebar.desktopCompact?.recentMinutes ?? 60,
    ),
  }
}

export function selectDesktopCompactProviderIDs(
  usage: UsageSummary,
  config: QuotaSidebarConfig,
  now = Date.now(),
) {
  const recentProviders = usage.recentProviders || []
  if (recentProviders.length === 0) return [] as string[]

  const { recentRequests, recentMinutes } = desktopCompactSettings(config)
  const cutoff = now - recentMinutes * 60_000
  const selected = new Set<string>()

  for (const event of recentProviders.slice(0, recentRequests)) {
    selected.add(event.providerID)
  }
  for (const event of recentProviders) {
    if (event.completedAt < cutoff) break
    selected.add(event.providerID)
  }

  const ordered: string[] = []
  for (const event of recentProviders) {
    if (!selected.has(event.providerID)) continue
    if (ordered.includes(event.providerID)) continue
    ordered.push(event.providerID)
  }

  return ordered
}

function compactProviderLabel(quota: QuotaSnapshot) {
  const canonical = canonicalProviderID(quota.adapterID || quota.providerID)
  if (canonical === 'openai') return 'OAI'
  if (canonical === 'github-copilot') return 'Cop'
  if (canonical === 'anthropic') return 'Ant'
  if (canonical === 'kimi-for-coding') return 'Kimi'
  if (canonical === 'rightcode') return 'RC'
  if (canonical === 'xyai-vibe') return 'XY'
  if (canonical === 'buzz') return 'Buzz'
  return sanitizeLine(quotaDisplayLabel(quota))
}

function compactWindowToken(label: string | undefined) {
  const safe = sanitizeLine(label || '')
  if (!safe) return ''
  if (/^daily$/i.test(safe)) return 'D'
  if (/^weekly$/i.test(safe)) return 'W'
  if (/^monthly$/i.test(safe)) return 'M'
  if (/^1d$/i.test(safe)) return 'D'
  return safe
}

function compactDesktopCurrencyValue(value: number, currency: string) {
  const rendered = formatCurrency(value, currency)
  if (currency === '$') return rendered.replace(/^\$/, '')
  return rendered
}

function compactDesktopQuotaSegment(quota: QuotaSnapshot) {
  const label = compactProviderLabel(quota)
  if (quota.status !== 'ok') {
    if (quota.status === 'error') return `${label} ?`
    return `${label} ${sanitizeLine(quota.status)}`
  }

  const parts: string[] = []
  let hasBalanceToken = false
  if (quota.windows && quota.windows.length > 0) {
    for (const win of quota.windows) {
      const winLabel = sanitizeLine(win.label || '')
      if (win.showPercent === false) {
        const daily = winLabel.match(/^Daily\s+\$?([\d.,]+)\/\$?([\d.,]+)/i)
        if (daily) {
          parts.push(`D${daily[1]}/${daily[2]}`)
          continue
        }
        if (winLabel) parts.push(winLabel.replace(/^Daily\s+/i, 'D'))
        continue
      }

      const percent =
        win.remainingPercent !== undefined &&
        Number.isFinite(win.remainingPercent)
          ? `${compactWindowToken(winLabel)}${Math.round(win.remainingPercent)}`
          : compactWindowToken(winLabel)
      if (percent) parts.push(percent)
    }
  } else if (quota.balance) {
    parts.push(
      `B${compactDesktopCurrencyValue(
        quota.balance.amount,
        quota.balance.currency,
      )}`,
    )
    hasBalanceToken = true
  } else if (
    quota.remainingPercent !== undefined &&
    Number.isFinite(quota.remainingPercent)
  ) {
    parts.push(`R${Math.round(quota.remainingPercent)}`)
  }

  if (quota.balance && !hasBalanceToken) {
    const balanceToken = `B${compactDesktopCurrencyValue(
      quota.balance.amount,
      quota.balance.currency,
    )}`
    parts.push(balanceToken)
  }

  return [label, ...parts].filter(Boolean).join(' ')
}

function renderDesktopCompactTitle(
  baseTitle: string,
  usage: UsageSummary,
  quotas: QuotaSnapshot[],
  config: QuotaSidebarConfig,
  _width: number,
) {
  const visibleQuotas = collapseQuotaSnapshots(quotas).filter((q) =>
    ['ok', 'error', 'unsupported', 'unavailable'].includes(q.status),
  )
  const selectedProviderIDs = new Set(
    selectDesktopCompactProviderIDs(usage, config),
  )
  const quotaSegments = visibleQuotas
    .filter((quota) => selectedProviderIDs.has(quota.providerID))
    .map(compactDesktopQuotaSegment)
    .filter(Boolean)

  const segments = [
    ...quotaSegments,
    `R${shortNumber(usage.assistantMessages, 1)} I${sidebarNumber(usage.input)} O${sidebarNumber(usage.output)}`,
  ]
  const detail = segments.join(' | ')
  const safeBase = sanitizeLine(baseTitle) || 'Session'
  if (!detail) return safeBase

  return `${safeBase} | ${detail}`
}

function formatPercent(value: number, decimals = 1) {
  const safe = Number.isFinite(value) && value >= 0 ? value : 0
  const pct = (safe * 100).toFixed(decimals)
  return `${pct.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')}%`
}

function formatQuotaPercent(
  value: number | undefined,
  options?: { decimals?: number; missing?: string; rounded?: boolean },
) {
  const missing = options?.missing ?? '-'
  if (value === undefined) return missing
  if (!Number.isFinite(value) || value < 0) return missing
  if (options?.rounded) return `${Math.round(value)}%`
  return `${value.toFixed(options?.decimals ?? 1)}%`
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

function compactQuotaInline(quota: QuotaSnapshot) {
  const label = sanitizeLine(quotaDisplayLabel(quota))
  if (quota.status !== 'ok') {
    if (quota.status === 'error') return `${label} Remaining ?`
    return `${label} ${sanitizeLine(quota.status)}`
  }

  if (quota.windows && quota.windows.length > 0) {
    const first = quota.windows[0]
    const showPercent = first.showPercent !== false
    const firstLabel = sanitizeLine(first.label || '')
    const pct = formatQuotaPercent(first.remainingPercent, {
      rounded: true,
      missing: '',
    })

    const summary = showPercent
      ? [firstLabel, pct].filter(Boolean).join(' ')
      : firstLabel.replace(/^Daily\s+/i, '') || firstLabel

    const hasMore =
      quota.windows.length > 1 ||
      (quota.balance !== undefined && !summary.includes('Balance '))
    return `${label}${summary ? ` ${summary}` : ''}${hasMore ? '+' : ''}`
  }

  if (quota.balance) {
    return `${label} Balance ${formatCurrency(quota.balance.amount, quota.balance.currency)}`
  }

  const singlePercent = formatQuotaPercent(quota.remainingPercent, {
    rounded: true,
    missing: '',
  })
  if (singlePercent) {
    return `${label} ${singlePercent}`
  }

  return label
}

function renderSingleLineTitle(
  baseTitle: string,
  usage: UsageSummary,
  quotas: QuotaSnapshot[],
  config: QuotaSidebarConfig,
  width: number,
) {
  const baseBudget = Math.min(16, Math.max(8, Math.floor(width * 0.35)))
  const base = fitLine(baseTitle, baseBudget)
  const cacheMetrics = getCacheCoverageMetrics(usage)

  const segments: string[] = [
    formatRequestsLabel(usage.assistantMessages, true),
    `Input ${sidebarNumber(usage.input)}  Output ${sidebarNumber(usage.output)}`,
  ]

  if (usage.cacheRead > 0) {
    segments.push(`Cache Read ${sidebarNumber(usage.cacheRead)}`)
  }
  if (usage.cacheWrite > 0) {
    segments.push(`Cache Write ${sidebarNumber(usage.cacheWrite)}`)
  }
  if (cacheMetrics.cacheCoverage !== undefined) {
    segments.push(
      `Cache Coverage ${formatPercent(cacheMetrics.cacheCoverage, 0)}`,
    )
  }
  if (cacheMetrics.cacheReadCoverage !== undefined) {
    segments.push(
      `Cache Read Coverage ${formatPercent(cacheMetrics.cacheReadCoverage, 0)}`,
    )
  }
  if (config.sidebar.showCost && usage.apiCost > 0) {
    segments.push(formatApiCostLine(usage.apiCost))
  }

  if (config.sidebar.showQuota) {
    const visibleQuotas = collapseQuotaSnapshots(quotas).filter((q) =>
      ['ok', 'error', 'unsupported', 'unavailable'].includes(q.status),
    )
    segments.push(...visibleQuotas.map(compactQuotaInline))
  }

  const detail = segments.filter(Boolean).join(' | ')
  if (!detail) return fitLine(baseTitle, width)
  return fitLine(`${base} | ${detail}`, width)
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
  const safeBaseTitle = stripAnsi(baseTitle || 'Session') || 'Session'

  if (isDesktopClient()) {
    const singleLineBase = safeBaseTitle.split(/\r?\n/, 1)[0] || 'Session'
    return renderDesktopCompactTitle(
      singleLineBase,
      usage,
      quotas,
      config,
      width,
    )
  }

  const cacheMetrics = getCacheCoverageMetrics(usage)

  const lines: string[] = []
  for (const line of safeBaseTitle.split(/\r?\n/)) {
    lines.push(fitLine(line || 'Session', width))
  }
  lines.push('')

  // Input / Output line
  lines.push(fitLine(formatRequestsLabel(usage.assistantMessages), width))
  const io = `Input ${sidebarNumber(usage.input)}  Output ${sidebarNumber(usage.output)}`
  lines.push(fitLine(io, width))

  // Cache lines (provider-compatible across OpenAI/Anthropic/Gemini/Copilot)
  if (usage.cacheRead > 0) {
    lines.push(fitLine(`Cache Read ${sidebarNumber(usage.cacheRead)}`, width))
  }
  if (usage.cacheWrite > 0) {
    lines.push(fitLine(`Cache Write ${sidebarNumber(usage.cacheWrite)}`, width))
  }
  if (cacheMetrics.cacheCoverage !== undefined) {
    lines.push(
      fitLine(
        `Cache Coverage ${formatPercent(cacheMetrics.cacheCoverage, 0)}`,
        width,
      ),
    )
  }
  if (cacheMetrics.cacheReadCoverage !== undefined) {
    lines.push(
      fitLine(
        `Cache Read Coverage ${formatPercent(
          cacheMetrics.cacheReadCoverage,
          0,
        )}`,
        width,
      ),
    )
  }
  if (config.sidebar.showCost && usage.apiCost > 0) {
    lines.push(fitLine(formatApiCostLine(usage.apiCost), width))
  }

  // Quota lines (one provider per line for stable wrapping)
  if (config.sidebar.showQuota) {
    const visibleQuotas = collapseQuotaSnapshots(quotas).filter((q) =>
      ['ok', 'error', 'unsupported', 'unavailable'].includes(q.status),
    )

    // When multiple providers are visible, keep a consistent visual rhythm by
    // always rendering each provider as a header line + indented detail line(s).
    const forceWrappedProviders = visibleQuotas.length > 1
    const labelWidth = visibleQuotas.reduce((max, item) => {
      const label = sanitizeLine(quotaDisplayLabel(item))
      return Math.max(max, stringCellWidth(label))
    }, 0)

    const quotaItems = visibleQuotas
      .flatMap((item) =>
        compactQuotaWide(item, labelWidth, {
          width,
          wrapLines: config.sidebar.wrapQuotaLines,
          forceWrapped: forceWrappedProviders,
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
 * When provider has a single detail line and it fits:
 *   "OpenAI 5h 80% Rst 16:20"
 *
 * When provider has multiple detail lines (multi-window or balance + window):
 *   "OpenAI"
 *   "  5h 80% Rst 16:20"
 *   "  Weekly 70% Rst 03-01"
 *
 * When wrapLines=true and label+content overflows width:
 *   "RC-openai"
 *   "  Daily $349.66/$180 Exp+ 02-27"
 *   "  Balance $108.88"
 */
function compactQuotaWide(
  quota: QuotaSnapshot,
  labelWidth = 0,
  options?: { width?: number; wrapLines?: boolean; forceWrapped?: boolean },
) {
  const label = sanitizeLine(quotaDisplayLabel(quota))
  const labelPadded = padEndCells(label, labelWidth)
  const detailIndent = '  '
  const withLabel = (content: string) => `${labelPadded} ${content}`
  const wrap = options?.wrapLines === true && (options?.width || 0) > 0
  const width = options?.width || 0
  const forceWrapped = options?.forceWrapped === true

  /** If inline version overflows, break into label-line + indented detail lines. */
  const maybeBreak = (inlineText: string, detailLines: string[]): string[] => {
    const inline = withLabel(inlineText)
    if (forceWrapped)
      return [label, ...detailLines.map((d) => `${detailIndent}${d}`)]
    if (!wrap || stringCellWidth(inline) <= width) return [inline]
    return [label, ...detailLines.map((d) => `${detailIndent}${d}`)]
  }

  if (quota.status === 'error')
    return maybeBreak('Remaining ?', ['Remaining ?'])
  if (quota.status === 'unsupported')
    return maybeBreak('unsupported', ['unsupported'])
  if (quota.status === 'unavailable')
    return maybeBreak('unavailable', ['unavailable'])
  if (quota.status !== 'ok') return []

  const balanceText = quota.balance
    ? `Balance ${formatCurrency(quota.balance.amount, quota.balance.currency)}`
    : undefined

  const renderWindow = (win: NonNullable<QuotaSnapshot['windows']>[number]) => {
    const showPercent = win.showPercent !== false
    const pct = formatQuotaPercent(win.remainingPercent, { rounded: true })
    const parts = win.label
      ? showPercent
        ? [sanitizeLine(win.label), pct]
        : [sanitizeLine(win.label)]
      : [pct]
    const reset = compactReset(win.resetAt, win.resetLabel, win.label)
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

    // Keep a unified wrapped layout for providers that have multiple detail
    // lines so OpenAI/Copilot/others match the RightCode multi-line style,
    // regardless of wrapLines.
    if (details.length > 1) {
      return [label, ...details.map((d) => `${detailIndent}${d}`)]
    }

    // Single detail line: keep inline unless width wrapping requires a break.
    const single = details[0]
    return maybeBreak(single, [single])
  }

  if (balanceText) {
    return maybeBreak(balanceText, [balanceText])
  }

  // Fallback: single value from top-level remainingPercent
  const percent = formatQuotaPercent(quota.remainingPercent, { rounded: true })
  const reset = compactReset(quota.resetAt, 'Rst')
  const fallbackText = `Remaining ${percent}${reset ? ` Rst ${reset}` : ''}`
  return maybeBreak(fallbackText, [fallbackText])
}
function isShortResetWindow(label: string | undefined) {
  if (typeof label !== 'string') return false
  return /^\s*(?:\d+\s*[hd]|daily)\b/i.test(label)
}

function compactReset(
  iso: string | undefined,
  resetLabel?: string,
  windowLabel?: string,
) {
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
  if (isShortResetWindow(windowLabel)) {
    const hhmm = `${two(value.getHours())}:${two(value.getMinutes())}`
    if (sameDay) return hhmm
    return `${two(value.getMonth() + 1)}-${two(value.getDate())} ${hhmm}`
  }
  return `${two(value.getMonth() + 1)}-${two(value.getDate())}`
}

function dateLine(iso: string | undefined) {
  if (!iso) return '-'
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  return new Date(time).toLocaleString()
}

function expiryAlertLine(iso: string | undefined, nowMs = Date.now()) {
  if (!iso) return undefined
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp) || timestamp <= nowMs) return undefined
  const remainingMs = timestamp - nowMs
  const thresholdMs = 3 * 24 * 60 * 60 * 1000
  if (remainingMs > thresholdMs) return undefined

  const value = new Date(timestamp)
  const now = new Date(nowMs)
  const sameDay =
    value.getFullYear() === now.getFullYear() &&
    value.getMonth() === now.getMonth() &&
    value.getDate() === now.getDate()

  const two = (num: number) => `${num}`.padStart(2, '0')
  const hhmm = `${two(value.getHours())}:${two(value.getMinutes())}`
  if (sameDay) return `Exp today ${hhmm}`
  return `Exp ${two(value.getMonth() + 1)}-${two(value.getDate())} ${hhmm}`
}

function quotaExpiryPairs(quotas: QuotaSnapshot[], nowMs = Date.now()) {
  return collapseQuotaSnapshots(quotas)
    .filter((item) => item.status === 'ok')
    .map((item) => ({
      label: quotaDisplayLabel(item),
      value: expiryAlertLine(item.expiresAt, nowMs),
    }))
    .filter((item): item is { label: string; value: string } =>
      Boolean(item.value),
    )
}

function reportResetLine(
  iso: string | undefined,
  resetLabel?: string,
  windowLabel?: string,
) {
  const compact = compactReset(iso, resetLabel, windowLabel)
  if (compact) return compact
  return dateLine(iso)
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
  const cacheMetrics = getCacheCoverageMetrics(usage)

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
      canonical === 'anthropic' ||
      canonical === 'github-copilot' ||
      rightCodeSubscriptionProviderIDs.has(providerID)
    if (isSubscription) return '-'
    return formatUsd(cost)
  }

  const isSubscriptionMeasuredProvider = (providerID: string) => {
    const canonical = canonicalProviderID(providerID)
    return (
      canonical === 'openai' ||
      canonical === 'anthropic' ||
      canonical === 'github-copilot' ||
      rightCodeSubscriptionProviderIDs.has(providerID)
    )
  }

  const apiCostCell = (providerID: string, apiCost: number) => {
    const canonical = canonicalProviderID(providerID)
    if (canonical === 'github-copilot') return '-'
    return formatUsd(apiCost)
  }

  const measuredCostSummaryValue = () => {
    const providers = Object.values(usage.providers)
    if (providers.length === 0) return formatUsd(usage.cost)
    const hasNonSubscription = providers.some(
      (provider) => !isSubscriptionMeasuredProvider(provider.providerID),
    )
    if (!hasNonSubscription) return '-'
    return formatUsd(usage.cost)
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

  const cacheCoverageCell = (provider: UsageSummary['providers'][string]) => {
    const metrics = getProviderCacheCoverageMetrics(provider)
    return metrics.cacheCoverage !== undefined
      ? formatPercent(metrics.cacheCoverage, 1)
      : '-'
  }

  const cacheReadCoverageCell = (
    provider: UsageSummary['providers'][string],
  ) => {
    const metrics = getProviderCacheCoverageMetrics(provider)
    return metrics.cacheReadCoverage !== undefined
      ? formatPercent(metrics.cacheReadCoverage, 1)
      : '-'
  }

  const providerEntries = Object.values(usage.providers).sort(
    (a, b) => b.total - a.total,
  )

  const highlightLines = () => {
    const lines: string[] = []
    const providerLabel = (providerID: string) =>
      quotaDisplayLabel({
        providerID,
        label: providerID,
        status: 'ok',
        checkedAt: 0,
      })
    const topApiCost = providerEntries
      .filter((provider) => provider.apiCost > 0)
      .sort((a, b) => b.apiCost - a.apiCost)[0]
    if (topApiCost) {
      lines.push(
        `- Top API cost: ${quotaDisplayLabel({
          providerID: topApiCost.providerID,
          label: topApiCost.providerID,
          status: 'ok',
          checkedAt: 0,
        })} (${formatUsd(topApiCost.apiCost)})`,
      )
    }

    const bestCacheCoverage = providerEntries
      .map((provider) => ({
        provider,
        value: getProviderCacheCoverageMetrics(provider).cacheCoverage,
      }))
      .filter(
        (
          entry,
        ): entry is {
          provider: UsageSummary['providers'][string]
          value: number
        } => entry.value !== undefined,
      )
      .sort((a, b) => b.value - a.value)[0]
    if (bestCacheCoverage) {
      lines.push(
        `- Best Cache Coverage: ${providerLabel(bestCacheCoverage.provider.providerID)} (${formatPercent(bestCacheCoverage.value, 1)})`,
      )
    }

    const bestCacheReadCoverage = providerEntries
      .map((provider) => ({
        provider,
        value: getProviderCacheCoverageMetrics(provider).cacheReadCoverage,
      }))
      .filter(
        (
          entry,
        ): entry is {
          provider: UsageSummary['providers'][string]
          value: number
        } => entry.value !== undefined,
      )
      .sort((a, b) => b.value - a.value)[0]
    if (bestCacheReadCoverage) {
      lines.push(
        `- Best Cache Read Coverage: ${providerLabel(bestCacheReadCoverage.provider.providerID)} (${formatPercent(bestCacheReadCoverage.value, 1)})`,
      )
    }

    const highestMeasured = providerEntries
      .filter(
        (provider) =>
          measuredCostCell(provider.providerID, provider.cost) !== '-',
      )
      .sort((a, b) => b.cost - a.cost)[0]
    if (highestMeasured && highestMeasured.cost > 0) {
      lines.push(
        `- Highest measured cost: ${providerLabel(highestMeasured.providerID)} (${formatUsd(highestMeasured.cost)})`,
      )
    }

    return lines
  }

  const providerRows = providerEntries.map((provider) => {
    const providerID = mdCell(provider.providerID)
    return showCost
      ? `| ${providerID} | ${shortNumber(provider.assistantMessages)} | ${shortNumber(provider.input)} | ${shortNumber(provider.output)} | ${shortNumber(provider.cacheRead + provider.cacheWrite)} | ${shortNumber(provider.total)} | ${cacheCoverageCell(provider)} | ${cacheReadCoverageCell(provider)} | ${measuredCostCell(provider.providerID, provider.cost)} | ${apiCostCell(provider.providerID, provider.apiCost)} |`
      : `| ${providerID} | ${shortNumber(provider.assistantMessages)} | ${shortNumber(provider.input)} | ${shortNumber(provider.output)} | ${shortNumber(provider.cacheRead + provider.cacheWrite)} | ${shortNumber(provider.total)} |`
  })

  const quotaLines = collapseQuotaSnapshots(quotas).flatMap((quota) => {
    const displayLabel = quotaDisplayLabel(quota)
    // Multi-window detail
    if (quota.windows && quota.windows.length > 0 && quota.status === 'ok') {
      const windowLines = quota.windows.map((win) => {
        const extraNote =
          win === quota.windows?.[0] && quota.note ? ` | ${quota.note}` : ''
        if (win.showPercent === false) {
          const winLabel = win.label ? ` (${win.label})` : ''
          return mdCell(
            `- ${displayLabel}${winLabel}: ${quota.status} | reset ${reportResetLine(win.resetAt, win.resetLabel, win.label)}${extraNote}`,
          )
        }
        const remaining = formatQuotaPercent(win.remainingPercent)
        const winLabel = win.label ? ` (${win.label})` : ''
        return mdCell(
          `- ${displayLabel}${winLabel}: ${quota.status} | remaining ${remaining} | reset ${reportResetLine(win.resetAt, win.resetLabel, win.label)}${extraNote}`,
        )
      })
      if (quota.balance) {
        windowLines.push(
          mdCell(
            `- ${displayLabel}: ${quota.status} | balance ${formatCurrency(quota.balance.amount, quota.balance.currency)}`,
          ),
        )
      }
      return windowLines
    }
    if (quota.status === 'ok' && quota.balance) {
      return [
        mdCell(
          `- ${displayLabel}: ${quota.status} | balance ${formatCurrency(quota.balance.amount, quota.balance.currency)}`,
        ),
      ]
    }
    if (quota.status !== 'ok') {
      return [
        mdCell(
          `- ${displayLabel}: ${quota.status}${quota.note ? ` | ${quota.note}` : ''}`,
        ),
      ]
    }
    const remaining = formatQuotaPercent(quota.remainingPercent)
    return [
      mdCell(
        `- ${displayLabel}: ${quota.status} | remaining ${remaining} | reset ${reportResetLine(quota.resetAt)}${quota.note ? ` | ${quota.note}` : ''}`,
      ),
    ]
  })

  return [
    `## Quota Report - ${periodLabel(period)}`,
    '',
    `- Sessions: ${usage.sessionCount}`,
    `- Requests: ${usage.assistantMessages}`,
    `- Tokens: input ${usage.input}, output ${usage.output}, cache_read ${usage.cacheRead}, cache_write ${usage.cacheWrite}, total ${usage.total}`,
    ...(cacheMetrics.cacheCoverage !== undefined
      ? [`- Cache Coverage: ${formatPercent(cacheMetrics.cacheCoverage, 1)}`]
      : []),
    ...(cacheMetrics.cacheReadCoverage !== undefined
      ? [
          `- Cache Read Coverage: ${formatPercent(cacheMetrics.cacheReadCoverage, 1)}`,
        ]
      : []),
    ...(showCost
      ? [
          `- Measured cost: ${measuredCostSummaryValue()}`,
          `- API cost: ${apiCostSummaryValue()}`,
        ]
      : []),
    ...(highlightLines().length > 0
      ? ['', '### Highlights', ...highlightLines()]
      : []),
    '',
    '### Usage by Provider',
    showCost
      ? '| Provider | Requests | Input | Output | Cache | Total | Cache Coverage | Cache Read Coverage | Measured Cost | API Cost |'
      : '| Provider | Requests | Input | Output | Cache | Total |',
    showCost
      ? '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
      : '|---|---:|---:|---:|---:|---:|',
    ...(providerRows.length
      ? providerRows
      : [
          showCost
            ? '| - | - | - | - | - | - | - | - | - | - |'
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
  options?: { showCost?: boolean; width?: number },
) {
  const width = Math.max(24, Math.floor(options?.width || 56))
  const showCost = options?.showCost !== false
  const cacheMetrics = getCacheCoverageMetrics(usage)
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
    { label: 'Requests', value: shortNumber(usage.assistantMessages) },
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
  if (cacheMetrics.cacheCoverage !== undefined) {
    tokenPairs.push({
      label: 'Cache Coverage',
      value: formatPercent(cacheMetrics.cacheCoverage, 1),
    })
  }
  if (cacheMetrics.cacheReadCoverage !== undefined) {
    tokenPairs.push({
      label: 'Cache Read Coverage',
      value: formatPercent(cacheMetrics.cacheReadCoverage, 1),
    })
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
        value: formatUsd(provider.apiCost),
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

  const providerCachePairs = Object.values(usage.providers)
    .map((provider) => {
      const metrics = getProviderCacheCoverageMetrics(provider)
      const parts: string[] = []
      if (metrics.cacheCoverage !== undefined) {
        parts.push(`Cov ${formatPercent(metrics.cacheCoverage, 1)}`)
      }
      if (metrics.cacheReadCoverage !== undefined) {
        parts.push(`Read ${formatPercent(metrics.cacheReadCoverage, 1)}`)
      }
      if (parts.length === 0) return undefined
      return {
        label: displayShortLabel(provider.providerID),
        value: parts.join('  '),
      }
    })
    .filter((item): item is { label: string; value: string } => Boolean(item))

  if (providerCachePairs.length > 0) {
    lines.push('')
    lines.push(fitLine('Provider Cache', width))
    lines.push(
      ...alignPairs(providerCachePairs).map((line) => fitLine(line, width)),
    )
  }

  const quotaPairs = collapseQuotaSnapshots(quotas).flatMap((item) => {
    if (item.status === 'ok') {
      if (item.windows && item.windows.length > 0) {
        const pairs = item.windows.map((win, idx) => {
          const showPercent = win.showPercent !== false
          const pct = formatQuotaPercent(win.remainingPercent)
          const reset = compactReset(win.resetAt, win.resetLabel, win.label)
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
            value: `Balance ${formatCurrency(item.balance.amount, item.balance.currency)}`,
          })
        }

        return pairs
      }

      if (item.balance) {
        return [
          {
            label: quotaDisplayLabel(item),
            value: `Balance ${formatCurrency(item.balance.amount, item.balance.currency)}`,
          },
        ]
      }

      const percent = formatQuotaPercent(item.remainingPercent)
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

  const expiryPairs = quotaExpiryPairs(quotas)
  if (expiryPairs.length > 0) {
    lines.push('')
    lines.push(fitLine('Expiry Soon', width))
    lines.push(...alignPairs(expiryPairs).map((line) => fitLine(line, width)))
  }

  return lines.join('\n')
}
