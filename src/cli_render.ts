import {
  canonicalProviderID,
  collapseQuotaSnapshots,
  quotaDisplayLabel,
} from './quota_render.js'
import type { QuotaSnapshot } from './types.js'
import {
  getCacheCoverageMetrics,
  getProviderCacheCoverageMetrics,
  type UsageSummary,
} from './usage.js'
import type { HistoryUsageResult } from './usage_service.js'

function shortNumber(value: number, decimals = 1) {
  if (!Number.isFinite(value) || value < 0) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(decimals)}m`
  if (value >= 1000) {
    const k = value / 1000
    if (Number(k.toFixed(decimals)) >= 1000) {
      return `${(value / 1_000_000).toFixed(decimals)}m`
    }
    return `${k.toFixed(decimals)}k`
  }
  return `${Math.round(value)}`
}

function formatCurrency(value: number, currency: string) {
  const safe = Number.isFinite(value) ? value : 0
  const prefix = typeof currency === 'string' && currency ? currency : '$'
  if (safe === 0) return `${prefix}0.00`
  if (safe < 10 && safe > -10)
    return `${safe < 0 ? '-' : ''}${prefix}${Math.abs(safe).toFixed(2)}`
  const rounded = Math.abs(safe).toFixed(1).replace(/\.0$/, '')
  return `${safe < 0 ? '-' : ''}${prefix}${rounded}`
}

function formatApiCost(value: number) {
  return formatCurrency(value, '$')
}

function formatPercent(value: number, decimals = 1) {
  const safe = Number.isFinite(value) && value >= 0 ? value : 0
  const pct = (safe * 100).toFixed(decimals)
  return `${pct.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')}%`
}

function compactCountdown(iso: string | undefined) {
  if (!iso) return 'n/a'
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return 'n/a'
  const remainingMs = timestamp - Date.now()
  if (!Number.isFinite(remainingMs)) return 'n/a'
  if (remainingMs <= 0) return '0m'
  const totalMinutes = Math.max(1, Math.floor(remainingMs / 60_000))
  if (totalMinutes < 60) return `${totalMinutes}m`
  if (totalMinutes < 24 * 60) {
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return `${hours}h${`${minutes}`.padStart(2, '0')}m`
  }
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  return `${days}D${`${hours}`.padStart(2, '0')}h`
}

function gauge(value: number | undefined, width = 10) {
  if (value === undefined || !Number.isFinite(value))
    return `${'░'.repeat(width)}  n/a`
  const ratio = Math.max(0, Math.min(1, value / 100))
  const filled = Math.max(value > 0 ? 1 : 0, Math.round(ratio * width))
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${`${Math.round(value)}`.padStart(3, ' ')}%`
}

function formatDelta(
  current: number,
  previous: number | undefined,
  format: (value: number) => string,
) {
  if (previous === undefined) return `${format(current)} now`
  if (!Number.isFinite(previous) || previous < 0)
    return `${format(current)} now`
  if (previous === 0)
    return `${format(current)} now, ${current === 0 ? 'flat' : 'new'}`
  const delta = ((current - previous) / previous) * 100
  const rounded = Math.abs(delta) >= 10 ? delta.toFixed(0) : delta.toFixed(1)
  const normalized = rounded.replace(/\.0$/, '')
  return `${format(current)} now, ${delta > 0 ? '+' : ''}${normalized}%`
}

function clip(value: string, width: number) {
  return value.length <= width
    ? value
    : `${value.slice(0, Math.max(0, width - 1))}~`
}

function centerLine(value: string, width: number) {
  const clipped = clip(value, width)
  if (clipped.length >= width) return clipped
  const left = Math.floor((width - clipped.length) / 2)
  const right = width - clipped.length - left
  return `${' '.repeat(left)}${clipped}${' '.repeat(right)}`
}

function padRight(value: string, width: number) {
  return clip(value, width).padEnd(width, ' ')
}

function box(title: string, lines: string[], width = 78) {
  const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0)
  const inner = Math.max(
    1,
    Math.min(width, Math.max(title.length, longestLine)),
  )
  const top = centerLine(title, inner)
  const rule = '─'.repeat(inner)
  const body = lines.map((line) => clip(line, inner))
  return [top, rule, ...body, rule].join('\n')
}

function currentLabel(period: 'day' | 'week' | 'month') {
  if (period === 'day') return 'Today'
  if (period === 'week') return 'This Week'
  return 'This Month'
}

function historyLabel(result: HistoryUsageResult) {
  if (result.period === 'day') return `Daily since ${result.since.raw}`
  if (result.period === 'week') return `Weekly since ${result.since.raw}`
  return `Monthly since ${result.since.raw}`
}

function quotaRows(quotas: QuotaSnapshot[]) {
  const visible = collapseQuotaSnapshots(quotas).filter(
    (item) => item.status === 'ok' || item.status === 'error',
  )
  if (visible.length === 0) return ['no provider quota data available']

  return visible.flatMap((quota) => {
    const label = quotaDisplayLabel(quota).padEnd(11, ' ')
    if (quota.status === 'error') {
      return [`${label} error${quota.note ? ` · ${quota.note}` : ''}`]
    }
    if (quota.windows && quota.windows.length > 0) {
      const lines = quota.windows.map((win) => {
        const detail = padRight(win.label || 'quota', 18)
        if (win.showPercent === false) {
          return `${label}${detail} ${compactCountdown(win.resetAt)}`
        }
        return `${label}${detail} [${gauge(win.remainingPercent)}] ${compactCountdown(win.resetAt)}`
      })
      if (quota.balance) {
        lines.push(
          `${label}${padRight('balance', 18)} ${formatCurrency(quota.balance.amount, quota.balance.currency)}`,
        )
      }
      return lines
    }
    if (quota.balance) {
      return [
        `${label}${padRight('balance', 18)} ${formatCurrency(quota.balance.amount, quota.balance.currency)}`,
      ]
    }
    return [
      `${label}[${gauge(quota.remainingPercent)}] · ${compactCountdown(quota.resetAt)}`,
    ]
  })
}

function providerRows(usage: UsageSummary, showCost: boolean) {
  const providers = Object.values(usage.providers).sort(
    (a, b) => b.total - a.total,
  )
  if (providers.length === 0) return ['no provider activity']
  return providers.map((provider) => {
    const cache = getProviderCacheCoverageMetrics(provider).cachedRatio
    const base = `${quotaDisplayLabel({ providerID: provider.providerID, label: provider.providerID, status: 'ok', checkedAt: 0 }).padEnd(10, ' ')} ${shortNumber(provider.assistantMessages).padStart(4, ' ')} req  ${shortNumber(provider.total).padStart(7, ' ')} tok  ${(cache !== undefined ? formatPercent(cache, 0) : '-').padStart(4, ' ')} cache`
    const apiCost =
      canonicalProviderID(provider.providerID) === 'github-copilot'
        ? '-'
        : formatApiCost(provider.apiCost)
    return showCost ? `${base}  ${apiCost.padStart(7, ' ')}` : base
  })
}

function cliApiCostSummary(usage: UsageSummary) {
  const providers = Object.values(usage.providers)
  if (providers.length === 0) return formatApiCost(usage.apiCost)
  const hasNonCopilot = providers.some(
    (provider) => canonicalProviderID(provider.providerID) !== 'github-copilot',
  )
  return hasNonCopilot ? formatApiCost(usage.apiCost) : '-'
}

function totalsRows(input: {
  requests: string
  tokens: string
  cost?: string
  cache?: string
  periods?: string
  current?: string
}) {
  const left = [`Requests ${input.requests}`, `Tokens ${input.tokens}`]
  const right = [
    ...(input.cost ? [`API Cost ${input.cost}`] : []),
    ...(input.cache ? [`Cache ${input.cache}`] : []),
  ]
  const metaLeft = input.periods ? `Periods ${input.periods}` : undefined
  const metaRight = input.current ? `Current ${input.current}` : undefined

  const row1 = [left[0], left[1], ...right].join('   ')
  const row2 = [metaLeft, metaRight].filter(Boolean).join('   ')
  return [row1, ...(row2 ? [row2] : [])]
}

function trendBar(value: number, maxValue: number, width = 20) {
  if (!Number.isFinite(value) || value <= 0 || maxValue <= 0) {
    return '░'.repeat(width)
  }
  const filled = Math.max(1, Math.round((value / maxValue) * width))
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

function trendMetricBlock(input: {
  label: string
  rows: HistoryUsageResult['rows']
  current: HistoryUsageResult['rows'][number] | undefined
  pick: (row: HistoryUsageResult['rows'][number]) => number
  format: (value: number) => string
}) {
  const visibleRows = input.rows.slice(-Math.min(8, input.rows.length))
  const values = visibleRows.map(input.pick)
  const maxValue = Math.max(...values, 0)
  const currentValue = input.current ? input.pick(input.current) : 0
  const displayLabels = visibleRows.map(
    (row) => `${row.range.shortLabel}${row.range.isCurrent ? '*' : ''}`,
  )
  const labelWidth = Math.max(
    8,
    Math.min(28, Math.max(...displayLabels.map((label) => label.length), 8)),
  )

  return [
    `${input.label} ${input.format(currentValue)}`,
    ...visibleRows.map((row, index) => {
      const value = input.pick(row)
      const tag = padRight(displayLabels[index], labelWidth)
      return `  ${tag} | ${trendBar(value, maxValue)} | ${input.format(value)}`
    }),
  ]
}

export function renderCliDashboard(input: {
  label: string
  usage: UsageSummary
  quotas: QuotaSnapshot[]
  width?: number
  showCost?: boolean
}) {
  const width = input.width ?? 78
  const showCost = input.showCost !== false
  const cache = getCacheCoverageMetrics(input.usage).cachedRatio
  return box(
    `opencode-quota · ${input.label}`,
    [
      'QUOTA',
      ...quotaRows(input.quotas),
      '',
      'TOTALS',
      ...totalsRows({
        requests: shortNumber(input.usage.assistantMessages),
        tokens: shortNumber(input.usage.total),
        ...(showCost ? { cost: cliApiCostSummary(input.usage) } : {}),
        cache: cache !== undefined ? formatPercent(cache, 1) : '-',
        periods: `${input.usage.sessionCount}`,
      }),
      `Input ${shortNumber(input.usage.input)}   Output ${shortNumber(input.usage.output)}`,
      '',
      'PROVIDERS',
      ...providerRows(input.usage, showCost),
    ],
    width,
  )
}

export function renderCliHistoryDashboard(input: {
  result: HistoryUsageResult
  quotas: QuotaSnapshot[]
  width?: number
  showCost?: boolean
}) {
  const width = input.width ?? 78
  const showCost = input.showCost !== false
  const rows = input.result.rows
  const current =
    [...rows].reverse().find((row) => row.range.isCurrent) || rows.at(-1)
  const currentIndex = current ? rows.indexOf(current) : -1
  const previous = currentIndex > 0 ? rows[currentIndex - 1] : undefined
  const cache = getCacheCoverageMetrics(input.result.total).cachedRatio
  const trendBlocks = [
    ...trendMetricBlock({
      label: 'Requests',
      rows,
      current,
      pick: (row) => row.usage.assistantMessages,
      format: (value) => shortNumber(value),
    }),
    '',
    ...trendMetricBlock({
      label: 'Tokens',
      rows,
      current,
      pick: (row) => row.usage.total,
      format: (value) => shortNumber(value),
    }),
    '',
    ...trendMetricBlock({
      label: 'Cache',
      rows,
      current,
      pick: (row) => getCacheCoverageMetrics(row.usage).cachedRatio ?? 0,
      format: (value) => formatPercent(value, 1),
    }),
    ...(showCost
      ? [
          '',
          ...trendMetricBlock({
            label: 'API Cost',
            rows,
            current,
            pick: (row) => row.usage.apiCost,
            format: (value) => formatApiCost(value),
          }),
        ]
      : []),
  ]

  return box(
    `opencode-quota · ${historyLabel(input.result)}`,
    [
      'QUOTA',
      ...quotaRows(input.quotas),
      '',
      'TOTALS',
      ...totalsRows({
        requests: shortNumber(input.result.total.assistantMessages),
        tokens: shortNumber(input.result.total.total),
        ...(showCost ? { cost: cliApiCostSummary(input.result.total) } : {}),
        cache: cache !== undefined ? formatPercent(cache, 1) : '-',
        periods: `${rows.length}`,
        current: current?.range.shortLabel || '-',
      }),
      '',
      'PROVIDERS',
      ...providerRows(input.result.total, showCost),
      '',
      'TREND',
      ...trendBlocks,
    ],
    width,
  )
}

export function cliCurrentLabel(period: 'day' | 'week' | 'month') {
  return currentLabel(period)
}
