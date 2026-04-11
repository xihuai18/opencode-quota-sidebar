export type HistoryPeriod = 'day' | 'week' | 'month'

export type SincePrecision = 'month' | 'day'

export type SinceSpec = {
  raw: string
  precision: SincePrecision
  startAt: number
}

export type PeriodRange = {
  period: HistoryPeriod
  startAt: number
  endAt: number
  label: string
  shortLabel: string
  isCurrent: boolean
  isPartial: boolean
  index: number
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

function pad2(value: number) {
  return `${value}`.padStart(2, '0')
}

function startOfDay(timestamp: number) {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function startOfMonth(timestamp: number) {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime()
}

function startOfWeek(timestamp: number) {
  const date = new Date(timestamp)
  const day = date.getDay()
  const shift = day === 0 ? 6 : day - 1
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - shift,
  ).getTime()
}

function nextDayStart(timestamp: number) {
  const date = new Date(timestamp)
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1,
  ).getTime()
}

function nextWeekStart(timestamp: number) {
  const weekStart = new Date(startOfWeek(timestamp))
  return new Date(
    weekStart.getFullYear(),
    weekStart.getMonth(),
    weekStart.getDate() + 7,
  ).getTime()
}

function nextMonthStart(timestamp: number) {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime()
}

function formatLocalDate(timestamp: number) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function formatMonthLabel(timestamp: number) {
  const date = new Date(timestamp)
  return `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`
}

function formatMonthShortLabel(timestamp: number) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`
}

function formatDayShortLabel(timestamp: number) {
  const date = new Date(timestamp)
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function periodBoundaryStart(period: HistoryPeriod, timestamp: number) {
  if (period === 'month') return startOfMonth(timestamp)
  if (period === 'week') return startOfWeek(timestamp)
  return startOfDay(timestamp)
}

function nextPeriodBoundary(period: HistoryPeriod, timestamp: number) {
  if (period === 'month') return nextMonthStart(timestamp)
  if (period === 'week') return nextWeekStart(timestamp)
  return nextDayStart(timestamp)
}

function periodRangeLabels(
  period: HistoryPeriod,
  startAt: number,
  endAt: number,
) {
  if (period === 'month') {
    return {
      label: formatMonthLabel(startAt),
      shortLabel: formatMonthShortLabel(startAt),
    }
  }
  if (period === 'week') {
    const endLabel = formatLocalDate(Math.max(startAt, endAt - 1))
    const startLabel = formatLocalDate(startAt)
    return {
      label: `${startLabel} to ${endLabel}`,
      shortLabel: `${startLabel}..${endLabel}`,
    }
  }
  return {
    label: formatLocalDate(startAt),
    shortLabel: formatDayShortLabel(startAt),
  }
}

export function parseSince(raw: string, now = Date.now()) {
  const value = raw.trim()
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(value)
  if (monthMatch) {
    const year = Number(monthMatch[1])
    const month = Number(monthMatch[2])
    if (year < 100 || month < 1 || month > 12) {
      throw new Error('`since` is not a valid calendar date')
    }
    const startAt = new Date(year, month - 1, 1).getTime()
    if (Number.isNaN(startAt)) {
      throw new Error('`since` is not a valid calendar date')
    }
    if (startAt > now) {
      throw new Error('`since` cannot be in the future')
    }
    return { raw: value, precision: 'month' as const, startAt }
  }

  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (dayMatch) {
    const year = Number(dayMatch[1])
    const month = Number(dayMatch[2])
    const day = Number(dayMatch[3])
    if (year < 100) {
      throw new Error('`since` is not a valid calendar date')
    }
    const startAt = new Date(year, month - 1, day).getTime()
    const probe = new Date(startAt)
    if (
      Number.isNaN(startAt) ||
      probe.getFullYear() !== year ||
      probe.getMonth() !== month - 1 ||
      probe.getDate() !== day
    ) {
      throw new Error('`since` is not a valid calendar date')
    }
    if (startAt > now) {
      throw new Error('`since` cannot be in the future')
    }
    return { raw: value, precision: 'day' as const, startAt }
  }

  throw new Error('`since` must be `YYYY-MM` or `YYYY-MM-DD`')
}

export function periodRanges(
  period: HistoryPeriod,
  since: SinceSpec,
  endAt = Date.now(),
) {
  if (since.startAt > endAt) {
    throw new Error('`since` cannot be in the future')
  }

  const ranges: PeriodRange[] = []
  let cursor = since.startAt
  let index = 0

  while (cursor < endAt) {
    const boundaryStart = periodBoundaryStart(period, cursor)
    const boundaryEnd = nextPeriodBoundary(period, cursor)
    const rangeEnd = Math.min(boundaryEnd, endAt)
    const isCurrent =
      rangeEnd === endAt && endAt !== periodBoundaryStart(period, endAt)
    const isPartial = cursor !== boundaryStart || isCurrent
    const { label, shortLabel } = periodRangeLabels(period, cursor, rangeEnd)
    ranges.push({
      period,
      startAt: cursor,
      endAt: rangeEnd,
      label,
      shortLabel,
      isCurrent,
      isPartial,
      index,
    })
    cursor = rangeEnd
    index += 1
  }

  if (period === 'day' && ranges.length > 90) {
    throw new Error(
      'day history is limited to 90 days; choose a later `since` date',
    )
  }

  return ranges
}

export function periodStart(period: HistoryPeriod) {
  return periodBoundaryStart(period, Date.now())
}
