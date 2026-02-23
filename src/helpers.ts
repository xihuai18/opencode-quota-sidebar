/** Shared type guards, utilities, and debug logging. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asNumber(value: unknown, fallback: number): number
export function asNumber(value: unknown): number | undefined
export function asNumber(
  value: unknown,
  fallback?: number,
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return value
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value !== 'boolean') return fallback
  return value
}

const DEBUG =
  typeof process !== 'undefined' && process.env.OPENCODE_QUOTA_DEBUG === '1'

export function debug(message: string, ...args: unknown[]) {
  if (!DEBUG) return
  console.error(`[quota-sidebar] ${message}`, ...args)
}

export function debugError(context: string, error: unknown) {
  if (!DEBUG) return
  const msg = error instanceof Error ? error.message : String(error)
  console.error(`[quota-sidebar] ${context}: ${msg}`)
}

/** Returns a `.catch()` handler that logs in debug mode and returns undefined. */
export function swallow(context: string) {
  return (error: unknown): undefined => {
    debugError(context, error)
    return undefined
  }
}

/**
 * Run up to `limit` async tasks concurrently from `items`.
 * Returns results in original order.
 */
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0

  async function worker() {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx], idx)
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  )
  await Promise.all(workers)
  return results
}
