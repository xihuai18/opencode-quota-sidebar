export class TtlValueCache<T> {
  private entry: { value: T; expiresAt: number } | undefined

  get(now = Date.now()) {
    if (!this.entry) return undefined
    if (this.entry.expiresAt <= now) {
      this.entry = undefined
      return undefined
    }
    return this.entry.value
  }

  set(value: T, ttlMs: number, now = Date.now()) {
    this.entry = {
      value,
      expiresAt: now + Math.max(0, ttlMs),
    }
    return value
  }

  clear() {
    this.entry = undefined
  }
}
