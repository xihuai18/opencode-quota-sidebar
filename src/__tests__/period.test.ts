import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseSince, periodRanges } from '../period.js'

describe('parseSince', () => {
  it('parses month and day inputs', () => {
    const month = parseSince('2026-01', new Date(2026, 3, 11).getTime())
    const day = parseSince('2026-01-15', new Date(2026, 3, 11).getTime())

    assert.equal(month.precision, 'month')
    assert.equal(day.precision, 'day')
    assert.equal(month.startAt, new Date(2026, 0, 1).getTime())
    assert.equal(day.startAt, new Date(2026, 0, 15).getTime())
  })

  it('rejects invalid and future dates', () => {
    const now = new Date(2026, 3, 11).getTime()
    assert.throws(() => parseSince('2026-13', now), /valid calendar date/)
    assert.throws(() => parseSince('2026-02-30', now), /valid calendar date/)
    assert.throws(() => parseSince('0099-12', now), /valid calendar date/)
    assert.throws(() => parseSince('2026-05', now), /future/)
    assert.throws(() => parseSince('2026/01', now), /YYYY-MM/)
  })
})

describe('periodRanges', () => {
  it('uses monday week boundaries and marks the current partial row', () => {
    const since = parseSince('2026-04-01', new Date(2026, 3, 11, 15).getTime())
    const rows = periodRanges(
      'week',
      since,
      new Date(2026, 3, 11, 15).getTime(),
    )

    assert.equal(rows[0].label, '2026-04-01 to 2026-04-05')
    assert.equal(rows[0].isPartial, true)
    assert.equal(rows[1].label, '2026-04-06 to 2026-04-11')
    assert.equal(rows[1].isCurrent, true)
  })

  it('limits day history to 90 rows', () => {
    const endAt = new Date(2026, 3, 11, 15).getTime()
    const since = parseSince('2026-01-01', endAt)
    assert.throws(
      () => periodRanges('day', since, endAt),
      /day history is limited to 90 days/,
    )
  })

  it('does not mark a fully closed bucket as current at an exact boundary', () => {
    const endAt = new Date(2026, 3, 12, 0, 0, 0).getTime()
    const since = parseSince('2026-04-11', endAt)
    const rows = periodRanges('day', since, endAt)

    assert.equal(rows.length, 1)
    assert.equal(rows[0].label, '2026-04-11')
    assert.equal(rows[0].isCurrent, false)
    assert.equal(rows[0].isPartial, false)
  })
})
