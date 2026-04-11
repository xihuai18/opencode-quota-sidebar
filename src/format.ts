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

export type TitleView = 'multiline' | 'compact'

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
export function fitLine(value: string, width: number) {
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

function trimTrailingZeroUnit(value: string) {
  return value
    .replace(/(\d+)\.0(?=[km]\b)/i, '$1')
    .replace(/(\d+)\.0(?=$)/, '$1')
}

function panelNumber(value: number) {
  return trimTrailingZeroUnit(shortNumber(value, 1))
}

function formatRequestsLabel(value: number, short = false) {
  const count = shortNumber(value, 1)
  return short ? `Req ${count}` : `Requests ${count}`
}

export function resolveTitleView(opts: {
  config: QuotaSidebarConfig
}): TitleView {
  void opts
  if (opts.config.sidebar.titleMode === 'compact') return 'compact'
  if (opts.config.sidebar.titleMode === 'multiline') return 'multiline'
  return 'compact'
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
  if (canonical === 'zhipuai-coding-plan') return 'Zhipu'
  if (canonical === 'minimax-cn-coding-plan') return 'MiniMax'
  if (canonical === 'rightcode') return 'RC'
  if (canonical === 'xyai') return 'XYAI'
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

function compactQuotaResetToken(resetLabel?: string) {
  const safe = sanitizeLine(resetLabel || '')
  if (!safe || /^rst$/i.test(safe)) return 'R'
  if (/^exp\+$/i.test(safe)) return 'E+'
  if (/^exp$/i.test(safe)) return 'E'
  return safe
}

function compactQuotaPercentToken(
  label: string | undefined,
  percent: number | undefined,
) {
  const rounded =
    percent !== undefined && Number.isFinite(percent)
      ? `${Math.round(percent)}`
      : ''
  const safe = sanitizeLine(label || '')
  if (!safe) return rounded ? `R${rounded}` : ''
  if (/^sonnet\s+7d$/i.test(safe)) return rounded ? `S7d${rounded}` : 'S7d'
  if (/^opus\s+7d$/i.test(safe)) return rounded ? `O7d${rounded}` : 'O7d'
  if (/^oauth\s+apps\s+7d$/i.test(safe)) {
    return rounded ? `OA7d${rounded}` : 'OA7d'
  }
  if (/^cowork\s+7d$/i.test(safe)) return rounded ? `Co7d${rounded}` : 'Co7d'
  const token = compactWindowToken(safe).replace(/\s+/g, '')
  if (!rounded) return token
  if (/^(?:D|W|M|\d+[hdw])$/i.test(token)) return `${token}${rounded}`
  return `${token} ${rounded}%`
}

function compactQuotaWindowText(
  win: NonNullable<QuotaSnapshot['windows']>[number],
) {
  const reset = compactReset(win.resetAt, win.resetLabel, win.label)
  const resetToken = reset
    ? `${compactQuotaResetToken(win.resetLabel)}${reset}`
    : undefined
  const note = sanitizeLine(win.note || '')

  if (win.showPercent === false) {
    const safe = sanitizeLine(win.label || '')
    const daily = safe ? safe.replace(/^Daily\s+/i, 'D') : ''
    return [daily, resetToken, note].filter(Boolean).join(' ')
  }

  const percentToken = compactQuotaPercentToken(win.label, win.remainingPercent)
  return [percentToken, resetToken, note].filter(Boolean).join(' ')
}

function compactQuotaWindowTokens(
  win: NonNullable<QuotaSnapshot['windows']>[number],
): string[] {
  const reset = compactReset(win.resetAt, win.resetLabel, win.label)
  const resetToken = reset
    ? `${compactQuotaResetToken(win.resetLabel)}${reset}`
    : undefined
  const note = sanitizeLine(win.note || '')

  if (win.showPercent === false) {
    const safe = sanitizeLine(win.label || '')
    const daily = safe ? safe.replace(/^Daily\s+/i, 'D') : ''
    return [daily, resetToken, note].filter((value): value is string =>
      Boolean(value),
    )
  }

  const percentToken = compactQuotaPercentToken(win.label, win.remainingPercent)
  return [percentToken, resetToken, note].filter((value): value is string =>
    Boolean(value),
  )
}

function compactQuotaBalanceText(
  balance: NonNullable<QuotaSnapshot['balance']>,
) {
  return `B${compactDesktopCurrencyValue(balance.amount, balance.currency)}`
}

function packInlineTokens(
  label: string,
  tokens: string[],
  width: number,
  indent = '  ',
) {
  if (tokens.length === 0) return [label]

  const lines: string[] = []
  let current = label

  for (const token of tokens) {
    const candidate = `${current} ${token}`
    if (stringCellWidth(candidate) <= width || current === label) {
      current = candidate
      continue
    }
    lines.push(current)
    current = `${indent}${token}`
  }

  lines.push(current)
  return lines
}

function compactDesktopCurrencyValue(value: number, currency: string) {
  const rendered = formatCurrency(value, currency)
  if (currency === '$') return rendered.replace(/^\$/, '')
  return rendered
}

function compactQuotaStaleToken(quota: QuotaSnapshot) {
  return quota.stale ? 'St' : undefined
}

function verboseQuotaStaleText(quota: QuotaSnapshot) {
  return quota.stale ? 'stale' : undefined
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
      parts.push(...compactQuotaWindowTokens(win))
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

  const staleToken = compactQuotaStaleToken(quota)
  if (staleToken) parts.push(staleToken)

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

  const cacheMetrics = getCacheCoverageMetrics(usage)
  const usageSegments: string[] = []
  if (cacheMetrics.cachedRatio !== undefined) {
    usageSegments.push(`Cd${formatPercent(cacheMetrics.cachedRatio, 0)}`)
  }
  if (config.sidebar.showCost && usage.apiCost > 0) {
    usageSegments.push(`Est${formatApiCostValue(usage.apiCost)}`)
  }

  const segments = [...quotaSegments, ...usageSegments]
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

function fitsLine(value: string, width: number) {
  return stringCellWidth(sanitizeLine(value)) <= width
}

function usageDetailLines(
  usage: UsageSummary,
  cacheMetrics: ReturnType<typeof getCacheCoverageMetrics>,
  options: {
    width: number
    showCost: boolean
    numberToken?: (value: number) => string
    costToken?: (value: number) => string
    cacheReadFirst?: boolean
  },
) {
  const width = options.width
  const numberToken = options.numberToken || sidebarNumber
  const costToken =
    options.costToken || ((value: number) => `Est${formatApiCostValue(value)}`)
  const groups: string[][] = []

  groups.push([
    `R${shortNumber(usage.assistantMessages, 1)}`,
    `I${numberToken(usage.input)}`,
    `O${numberToken(usage.output)}`,
  ])

  const secondary: string[] = []
  const pushCacheRead = () => {
    if (usage.cacheRead > 0) {
      secondary.push(`CR${numberToken(usage.cacheRead)}`)
    }
  }
  const pushCacheWrite = () => {
    if (usage.cacheWrite > 0) {
      secondary.push(`CW${numberToken(usage.cacheWrite)}`)
    }
  }
  if (options.cacheReadFirst) {
    pushCacheRead()
    pushCacheWrite()
  } else {
    pushCacheWrite()
    pushCacheRead()
  }
  if (cacheMetrics.cachedRatio !== undefined) {
    secondary.push(`Cd${formatPercent(cacheMetrics.cachedRatio, 0)}`)
  }
  if (secondary.length > 0) groups.push(secondary)

  if (options.showCost && usage.apiCost > 0) {
    groups.push([costToken(usage.apiCost)])
  }

  const packed: string[] = []
  for (const group of groups) {
    let current = ''
    for (const token of group) {
      const candidate = current ? `${current} ${token}` : token
      if (!current || fitsLine(candidate, width)) {
        current = candidate
        continue
      }
      packed.push(current)
      current = token
    }
    if (current) packed.push(current)
  }

  return packed
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
  const staleToken = compactQuotaStaleToken(quota)
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
    return `${label}${summary ? ` ${summary}` : ''}${hasMore ? '+' : ''}${staleToken ? ` ${staleToken}` : ''}`
  }

  if (quota.balance) {
    return `${label} Balance ${formatCurrency(quota.balance.amount, quota.balance.currency)}${staleToken ? ` ${staleToken}` : ''}`
  }

  const singlePercent = formatQuotaPercent(quota.remainingPercent, {
    rounded: true,
    missing: '',
  })
  if (singlePercent) {
    return `${label} ${singlePercent}${staleToken ? ` ${staleToken}` : ''}`
  }

  return `${label}${staleToken ? ` ${staleToken}` : ''}`
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

  if (usage.cacheWrite > 0) {
    segments.push(`Cache Write ${sidebarNumber(usage.cacheWrite)}`)
  }
  if (usage.cacheRead > 0) {
    segments.push(`Cache Read ${sidebarNumber(usage.cacheRead)}`)
  }
  if (cacheMetrics.cachedRatio !== undefined) {
    segments.push(`Cached ${formatPercent(cacheMetrics.cachedRatio, 0)}`)
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
  view?: TitleView,
) {
  const width = Math.max(8, Math.floor(config.sidebar.width || 36))
  const safeBaseTitle = stripAnsi(baseTitle || 'Session') || 'Session'
  const mode = view || resolveTitleView({ config })

  if (mode === 'compact') {
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

  for (const detailLine of usageDetailLines(usage, cacheMetrics, {
    width,
    showCost: config.sidebar.showCost,
  })) {
    lines.push(fitLine(detailLine, width))
  }

  // Quota lines (one provider per line for stable wrapping)
  if (config.sidebar.showQuota) {
    const visibleQuotas = collapseQuotaSnapshots(quotas).filter((q) =>
      ['ok', 'error', 'unsupported', 'unavailable'].includes(q.status),
    )

    const compactQuotaDetails = true
    const forceWrappedProviders = false
    const labelWidth = visibleQuotas.reduce((max, item) => {
      const label = compactQuotaDetails
        ? compactProviderLabel(item)
        : sanitizeLine(quotaDisplayLabel(item))
      return Math.max(max, stringCellWidth(label))
    }, 0)

    const quotaItems = visibleQuotas
      .flatMap((item) =>
        compactQuotaWide(item, labelWidth, {
          width,
          wrapLines: config.sidebar.wrapQuotaLines,
          forceWrapped: forceWrappedProviders,
          compactDetails: compactQuotaDetails,
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

export function renderSidebarContextLine(
  tokens: number,
  percent: number | undefined,
  width: number,
) {
  const parts = [`${panelNumber(tokens)} tok`]
  if (percent !== undefined && Number.isFinite(percent) && percent >= 0) {
    parts.push(`${Math.round(percent)}% ctx`)
  }
  return fitLine(parts.join(' '), width)
}

export function renderSidebarUsageLines(
  usage: UsageSummary,
  config: QuotaSidebarConfig,
  options?: { showCost?: boolean },
) {
  const width = Math.max(8, Math.floor(config.sidebar.width || 36))
  const cacheMetrics = getCacheCoverageMetrics(usage)
  return usageDetailLines(usage, cacheMetrics, {
    width,
    showCost: options?.showCost ?? config.sidebar.showCost,
    numberToken: panelNumber,
    costToken: (value) => `Est ${formatApiCostValue(value)}`,
    cacheReadFirst: true,
  }).map((line) => fitLine(line, width))
}

export function renderSidebarQuotaLines(
  quotas: QuotaSnapshot[],
  config: QuotaSidebarConfig,
) {
  return renderSidebarQuotaLineGroups(quotas, config).flatMap(
    (group) => group.lines,
  )
}

export function renderSidebarQuotaLineGroups(
  quotas: QuotaSnapshot[],
  config: QuotaSidebarConfig,
) {
  const width = Math.max(8, Math.floor(config.sidebar.width || 36))
  const visibleQuotas = collapseQuotaSnapshots(quotas).filter((q) =>
    ['ok', 'error', 'unsupported', 'unavailable'].includes(q.status),
  )
  const labelWidth = visibleQuotas.reduce((max, item) => {
    const label = compactProviderLabel(item)
    return Math.max(max, stringCellWidth(label))
  }, 0)

  return visibleQuotas
    .map((item) => ({
      quota: item,
      lines: compactQuotaWide(item, labelWidth, {
        width,
        wrapLines: config.sidebar.wrapQuotaLines,
        forceWrapped: false,
        compactDetails: true,
      })
        .filter((line): line is string => Boolean(line))
        .map((line) => fitLine(line, width)),
    }))
    .filter((group) => group.lines.length > 0)
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
  options?: {
    width?: number
    wrapLines?: boolean
    forceWrapped?: boolean
    compactDetails?: boolean
  },
) {
  const compactDetails = options?.compactDetails === true
  const label = compactDetails
    ? compactProviderLabel(quota)
    : sanitizeLine(quotaDisplayLabel(quota))
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
    ? compactDetails
      ? compactQuotaBalanceText(quota.balance)
      : `Balance ${formatCurrency(quota.balance.amount, quota.balance.currency)}`
    : undefined

  const renderWindow = (win: NonNullable<QuotaSnapshot['windows']>[number]) => {
    if (compactDetails) return compactQuotaWindowText(win)
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
    if (win.note) parts.push(sanitizeLine(win.note))
    return parts.join(' ')
  }

  // Multi-window rendering
  if (quota.windows && quota.windows.length > 0) {
    const parts = quota.windows.map(renderWindow)
    const compactTokens = compactDetails
      ? quota.windows.flatMap((win) => compactQuotaWindowTokens(win))
      : []

    // Build the detail lines (window texts + optional balance)
    const details = [...parts]
    if (balanceText && !parts.some((p) => p.includes('Balance '))) {
      details.push(balanceText)
    }

    if (compactDetails) {
      const tokens = [...compactTokens]
      if (balanceText) tokens.push(balanceText)
      const staleToken = compactQuotaStaleToken(quota)
      if (staleToken) tokens.push(staleToken)
      return packInlineTokens(
        label,
        tokens,
        width,
        ' '.repeat(stringCellWidth(label) + 1),
      )
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
    const staleText = verboseQuotaStaleText(quota)
    const detail = staleText ? `${balanceText} ${staleText}` : balanceText
    return maybeBreak(detail, [detail])
  }

  // Fallback: single value from top-level remainingPercent
  const percent = formatQuotaPercent(quota.remainingPercent, { rounded: true })
  const reset = compactReset(quota.resetAt, 'Rst')
  const fallbackText = compactDetails
    ? [
        `R${percent.replace(/%$/, '')}`,
        reset ? `R${reset}` : undefined,
        compactQuotaStaleToken(quota),
      ]
        .filter(Boolean)
        .join(' ')
    : `Remaining ${percent}${reset ? ` Rst ${reset}` : ''}${verboseQuotaStaleText(quota) ? ` ${verboseQuotaStaleText(quota)}` : ''}`
  return maybeBreak(fallbackText, [fallbackText])
}
function compactCountdown(remainingMs: number) {
  if (!Number.isFinite(remainingMs)) return undefined
  if (remainingMs <= 0) return '0m'

  const minuteMs = 60_000
  const hourMinutes = 60
  const dayMinutes = 24 * hourMinutes
  const totalMinutes = Math.max(1, Math.floor(remainingMs / minuteMs))

  if (totalMinutes < hourMinutes) {
    return `${totalMinutes}m`
  }

  if (totalMinutes < dayMinutes) {
    const hours = Math.floor(totalMinutes / hourMinutes)
    const minutes = totalMinutes % hourMinutes
    return `${hours}h${`${minutes}`.padStart(2, '0')}m`
  }

  const days = Math.floor(totalMinutes / dayMinutes)
  const hours = Math.floor((totalMinutes % dayMinutes) / hourMinutes)
  return `${days}D${`${hours}`.padStart(2, '0')}h`
}

function compactReset(
  iso: string | undefined,
  resetLabel?: string,
  windowLabel?: string,
) {
  void resetLabel
  void windowLabel
  if (!iso) return undefined
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return undefined

  return compactCountdown(timestamp - Date.now())
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

  const countdown = compactCountdown(remainingMs)
  if (!countdown) return undefined
  return `Exp ${countdown}`
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

function toolVisibleQuotaSnapshots(quotas: QuotaSnapshot[]) {
  return collapseQuotaSnapshots(quotas).filter(
    (item) => item.status === 'ok' || item.status === 'error',
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

  const cachedCell = (provider: UsageSummary['providers'][string]) => {
    const metrics = getProviderCacheCoverageMetrics(provider)
    return metrics.cachedRatio !== undefined
      ? formatPercent(metrics.cachedRatio, 1)
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

    const bestCachedRatio = providerEntries
      .map((provider) => ({
        provider,
        value: getProviderCacheCoverageMetrics(provider).cachedRatio,
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
    if (bestCachedRatio) {
      lines.push(
        `- Best Cached Ratio: ${providerLabel(bestCachedRatio.provider.providerID)} (${formatPercent(bestCachedRatio.value, 1)})`,
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
      ? `| ${providerID} | ${shortNumber(provider.assistantMessages)} | ${shortNumber(provider.input)} | ${shortNumber(provider.output)} | ${shortNumber(provider.cacheRead + provider.cacheWrite)} | ${shortNumber(provider.total)} | ${cachedCell(provider)} | ${measuredCostCell(provider.providerID, provider.cost)} | ${apiCostCell(provider.providerID, provider.apiCost)} |`
      : `| ${providerID} | ${shortNumber(provider.assistantMessages)} | ${shortNumber(provider.input)} | ${shortNumber(provider.output)} | ${shortNumber(provider.cacheRead + provider.cacheWrite)} | ${shortNumber(provider.total)} |`
  })

  const providerHeader = showCost
    ? '| Provider | Requests | Input | Output | Cache | Total | Cached | Measured Cost | API Cost |'
    : '| Provider | Requests | Input | Output | Cache | Total |'
  const providerDivider = showCost
    ? '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
    : '| --- | ---: | ---: | ---: | ---: | ---: |'

  const quotaLines = toolVisibleQuotaSnapshots(quotas).flatMap((quota) => {
    const displayLabel = quotaDisplayLabel(quota)
    const staleSuffix = quota.stale ? ' | stale' : ''
    // Multi-window detail
    if (quota.windows && quota.windows.length > 0 && quota.status === 'ok') {
      const windowLines = quota.windows.map((win) => {
        const extraNote =
          win.note || (win === quota.windows?.[0] && quota.note)
            ? ` | ${win.note || quota.note}`
            : ''
        const staleNote =
          quota.stale && win === quota.windows?.[0] ? staleSuffix : ''
        if (win.showPercent === false) {
          const winLabel = win.label ? ` (${win.label})` : ''
          return mdCell(
            `- ${displayLabel}${winLabel}: ${quota.status} | reset ${reportResetLine(win.resetAt, win.resetLabel, win.label)}${extraNote}${staleNote}`,
          )
        }
        const remaining = formatQuotaPercent(win.remainingPercent)
        const winLabel = win.label ? ` (${win.label})` : ''
        return mdCell(
          `- ${displayLabel}${winLabel}: ${quota.status} | remaining ${remaining} | reset ${reportResetLine(win.resetAt, win.resetLabel, win.label)}${extraNote}${staleNote}`,
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
          `- ${displayLabel}: ${quota.status} | balance ${formatCurrency(quota.balance.amount, quota.balance.currency)}${staleSuffix}`,
        ),
      ]
    }
    if (quota.status === 'error') {
      return [
        mdCell(
          `- ${displayLabel}: ${quota.status}${quota.note ? ` | ${quota.note}` : ''}`,
        ),
      ]
    }
    const remaining = formatQuotaPercent(quota.remainingPercent)
    return [
      mdCell(
        `- ${displayLabel}: ${quota.status} | remaining ${remaining} | reset ${reportResetLine(quota.resetAt)}${quota.note ? ` | ${quota.note}` : ''}${staleSuffix}`,
      ),
    ]
  })

  return [
    `## Quota Report - ${periodLabel(period)}`,
    '',
    `- Sessions: ${usage.sessionCount}`,
    `- Requests: ${usage.assistantMessages}`,
    `- Tokens: input ${usage.input}, output ${usage.output}, cache_read ${usage.cacheRead}, cache_write ${usage.cacheWrite}, total ${usage.total}`,
    ...(cacheMetrics.cachedRatio !== undefined
      ? [`- Cached: ${formatPercent(cacheMetrics.cachedRatio, 1)}`]
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
    '',
    providerHeader,
    providerDivider,
    ...(providerRows.length
      ? providerRows
      : [
          showCost
            ? '| - | - | - | - | - | - | - | - | - |'
            : '| - | - | - | - | - | - |',
        ]),
    '',
    '### Subscription Quota',
    '',
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
  if (usage.cacheWrite > 0) {
    tokenPairs.push({
      label: 'Cache Write',
      value: shortNumber(usage.cacheWrite),
    })
  }
  if (usage.cacheRead > 0) {
    tokenPairs.push({
      label: 'Cache Read',
      value: shortNumber(usage.cacheRead),
    })
  }
  if (cacheMetrics.cachedRatio !== undefined) {
    tokenPairs.push({
      label: 'Cached',
      value: formatPercent(cacheMetrics.cachedRatio, 1),
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
      const hasOnlyCopilotUsage =
        hasAnyUsage &&
        Object.values(usage.providers).every(
          (provider) =>
            canonicalProviderID(provider.providerID) === 'github-copilot',
        )
      lines.push(
        fitLine(
          hasOnlyCopilotUsage
            ? '  N/A (Copilot)'
            : hasAnyUsage
              ? '  N/A'
              : '  -',
          width,
        ),
      )
    }
  }

  const providerCachePairs = Object.values(usage.providers)
    .map((provider) => {
      const metrics = getProviderCacheCoverageMetrics(provider)
      if (metrics.cachedRatio === undefined) return undefined
      return {
        label: displayShortLabel(provider.providerID),
        value: `Cached ${formatPercent(metrics.cachedRatio, 1)}`,
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

  const quotaPairs = toolVisibleQuotaSnapshots(quotas).flatMap((item) => {
    if (item.status === 'ok') {
      if (item.windows && item.windows.length > 0) {
        const pairs = item.windows.map((win, idx) => {
          const showPercent = win.showPercent !== false
          const pct = formatQuotaPercent(win.remainingPercent)
          const reset = compactReset(win.resetAt, win.resetLabel, win.label)
          const parts = [win.label]
          if (showPercent) parts.push(pct)
          if (reset) parts.push(`${win.resetLabel || 'Rst'} ${reset}`)
          if (win.note) parts.push(win.note)
          if (item.stale && idx === 0) parts.push('stale')
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
            value: `Balance ${formatCurrency(item.balance.amount, item.balance.currency)}${item.stale ? ' stale' : ''}`,
          },
        ]
      }

      const percent = formatQuotaPercent(item.remainingPercent)
      const reset = compactReset(item.resetAt, 'Rst')
      return [
        {
          label: quotaDisplayLabel(item),
          value: `Remaining ${percent}${reset ? ` Rst ${reset}` : ''}${item.stale ? ' stale' : ''}`,
        },
      ]
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
