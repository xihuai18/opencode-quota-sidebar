import { asNumber } from './helpers.js'

export function normalizeTimestampMs(value: unknown, fallback = Date.now()) {
  const num = asNumber(value)
  if (num === undefined) return fallback
  // Seconds -> ms heuristic
  if (num > 0 && num < 1_000_000_000_000) return num * 1000
  if (num > 0) return num
  return fallback
}

function pad2(value: number) {
  return `${value}`.padStart(2, '0')
}

/**
 * Extract date parts from a timestamp.
 * M12 fix: accepts already-normalized ms timestamp — no double normalization.
 */
function datePartsFromMs(timestampMs: number) {
  const date = new Date(timestampMs)
  if (Number.isNaN(date.getTime())) {
    const now = new Date()
    return {
      year: `${now.getFullYear()}`,
      month: pad2(now.getMonth() + 1),
      day: pad2(now.getDate()),
    }
  }
  return {
    year: `${date.getFullYear()}`,
    month: pad2(date.getMonth() + 1),
    day: pad2(date.getDate()),
  }
}

export function isDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [yearText, monthText, dayText] = value.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  if (!Number.isInteger(year)) return false
  if (!Number.isInteger(month) || month < 1 || month > 12) return false
  if (!Number.isInteger(day) || day < 1 || day > 31) return false
  const probe = new Date(year, month - 1, day)
  return (
    probe.getFullYear() === year &&
    probe.getMonth() === month - 1 &&
    probe.getDate() === day
  )
}

/**
 * Convert a timestamp (already in ms) to a date key string.
 * M12 fix: no double normalization — caller must pass ms.
 */
export function dateKeyFromTimestamp(timestampMs: number) {
  const { year, month, day } = datePartsFromMs(timestampMs)
  return `${year}-${month}-${day}`
}

export function dateStartFromKey(dateKey: string) {
  if (!isDateKey(dateKey)) return 0
  const [yearText, monthText, dayText] = dateKey.split('-')
  return new Date(
    Number(yearText),
    Number(monthText) - 1,
    Number(dayText),
  ).getTime()
}

/** M7 fix: cap iteration at 400 days (~13 months). */
const MAX_DATE_RANGE_DAYS = 400

export function dateKeysInRange(startAt: number, endAt: number) {
  const startDate = new Date(startAt)
  if (Number.isNaN(startDate.getTime())) return []

  const endDate = new Date(endAt)
  if (Number.isNaN(endDate.getTime())) return []

  const cursor = new Date(
    startDate.getFullYear(),
    startDate.getMonth(),
    startDate.getDate(),
  )
  const endDay = new Date(
    endDate.getFullYear(),
    endDate.getMonth(),
    endDate.getDate(),
  )

  const keys: string[] = []
  let iterations = 0
  while (
    cursor.getTime() <= endDay.getTime() &&
    iterations < MAX_DATE_RANGE_DAYS
  ) {
    keys.push(dateKeyFromTimestamp(cursor.getTime()))
    cursor.setDate(cursor.getDate() + 1)
    iterations++
  }
  return keys
}
