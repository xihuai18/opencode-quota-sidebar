import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeTimestampMs, dateKeyFromTimestamp } from '../storage.js'

describe('normalizeTimestampMs', () => {
  it('returns ms timestamp as-is', () => {
    const ts = 1708700000000
    assert.equal(normalizeTimestampMs(ts), ts)
  })

  it('converts seconds to ms', () => {
    const seconds = 1708700000
    assert.equal(normalizeTimestampMs(seconds), seconds * 1000)
  })

  it('returns fallback for non-numbers', () => {
    const fallback = 999
    assert.equal(normalizeTimestampMs('abc', fallback), fallback)
    assert.equal(normalizeTimestampMs(null, fallback), fallback)
    assert.equal(normalizeTimestampMs(NaN, fallback), fallback)
  })

  it('returns fallback for zero or negative', () => {
    const fallback = 999
    assert.equal(normalizeTimestampMs(0, fallback), fallback)
    assert.equal(normalizeTimestampMs(-1, fallback), fallback)
  })
})

describe('dateKeyFromTimestamp', () => {
  it('formats date correctly', () => {
    // 2026-02-23 in UTC
    const ts = new Date(2026, 1, 23).getTime()
    assert.equal(dateKeyFromTimestamp(ts), '2026-02-23')
  })

  it('pads single-digit months and days', () => {
    const ts = new Date(2026, 0, 5).getTime()
    assert.equal(dateKeyFromTimestamp(ts), '2026-01-05')
  })
})
