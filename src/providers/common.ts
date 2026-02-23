import { asNumber as asNumberShared, isRecord } from '../helpers.js'

export const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

export async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export function asNumber(value: unknown) {
  return asNumberShared(value)
}

export function normalizePercent(value: unknown) {
  const numeric = asNumber(value)
  if (numeric === undefined) return undefined
  const expanded = numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric
  if (Number.isNaN(expanded)) return undefined
  if (expanded < 0) return 0
  if (expanded > 100) return 100
  return expanded
}

export function toIso(value: unknown) {
  if (typeof value === 'string') {
    const time = Date.parse(value)
    if (!Number.isNaN(time)) return new Date(time).toISOString()
    return value
  }
  const number = asNumber(value)
  if (number === undefined) return undefined
  const milliseconds = number > 10_000_000_000 ? number : number * 1000
  return new Date(milliseconds).toISOString()
}

/**
 * Derive a human-readable window label from `limit_window_seconds`.
 * Falls back to estimating from `reset_at` when missing.
 */
export function windowLabel(
  win: Record<string, unknown>,
  fallback = '',
): string {
  const limitSec = asNumber(win.limit_window_seconds)
  if (limitSec !== undefined && limitSec > 0) {
    const hours = limitSec / 3600
    if (hours <= 24) return `${Math.round(hours)}h`
    const days = hours / 24
    if (days <= 6) return `${Math.round(days)}d`
    return 'Weekly'
  }

  const resetAt = win.reset_at
  if (resetAt === undefined || resetAt === null) return fallback

  const resetMs =
    typeof resetAt === 'number'
      ? resetAt > 10_000_000_000
        ? resetAt
        : resetAt * 1000
      : typeof resetAt === 'string'
        ? Date.parse(resetAt)
        : NaN
  if (Number.isNaN(resetMs)) return fallback
  const hoursLeft = Math.max(0, (resetMs - Date.now()) / 3_600_000)
  if (hoursLeft <= 12) return `${Math.max(1, Math.round(hoursLeft))}h`
  if (hoursLeft <= 48) return `${Math.round(hoursLeft / 24)}d`
  return 'Weekly'
}

export function parseRateLimitWindow(
  win: Record<string, unknown>,
  fallbackLabel: string,
) {
  const usedPercent = normalizePercent(win.used_percent)
  const remainingPercent =
    normalizePercent(win.remaining_percent) ??
    (usedPercent === undefined ? undefined : 100 - usedPercent)
  if (remainingPercent === undefined) return undefined
  return {
    label: windowLabel(win, fallbackLabel),
    remainingPercent,
    usedPercent,
    resetAt: toIso(win.reset_at),
  }
}

export function asRecord(value: unknown) {
  return isRecord(value) ? value : undefined
}

export function configuredProviderEnabled(
  config: { providers?: Record<string, { enabled?: boolean }> },
  adapterID: string,
  fallback = true,
) {
  const enabled = config.providers?.[adapterID]?.enabled
  if (typeof enabled === 'boolean') return enabled
  return fallback
}

export function sanitizeBaseURL(value: unknown) {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const parsed = new URL(value)
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/'
    return `${parsed.origin}${pathname}`
  } catch {
    return undefined
  }
}

export function basePathPrefixes(value: unknown) {
  const sanitized = sanitizeBaseURL(value)
  if (!sanitized) return [] as string[]
  try {
    const parsed = new URL(sanitized)
    const parts = parsed.pathname.split('/').filter(Boolean)
    const prefixes: string[] = []
    for (let i = parts.length; i >= 1; i--) {
      prefixes.push(`/${parts.slice(0, i).join('/')}`)
    }
    if (prefixes.length === 0) prefixes.push('/')
    return prefixes
  } catch {
    return [] as string[]
  }
}
