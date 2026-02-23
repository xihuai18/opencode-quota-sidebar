import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { isRecord, asNumber, asBoolean, mapConcurrent } from '../helpers.js'

describe('isRecord', () => {
  it('returns true for plain objects', () => {
    assert.equal(isRecord({}), true)
    assert.equal(isRecord({ a: 1 }), true)
  })

  it('returns false for non-objects', () => {
    assert.equal(isRecord(null), false)
    assert.equal(isRecord(undefined), false)
    assert.equal(isRecord(42), false)
    assert.equal(isRecord('string'), false)
    assert.equal(isRecord([1, 2]), false)
  })
})

describe('asNumber', () => {
  it('returns number for valid numbers', () => {
    assert.equal(asNumber(42, 0), 42)
    assert.equal(asNumber(0, 99), 0)
    assert.equal(asNumber(-1, 0), -1)
  })

  it('returns fallback for non-numbers', () => {
    assert.equal(asNumber('42', 0), 0)
    assert.equal(asNumber(null, 0), 0)
    assert.equal(asNumber(undefined, 0), 0)
    assert.equal(asNumber(NaN, 0), 0)
    assert.equal(asNumber(Infinity, 0), 0)
    assert.equal(asNumber(-Infinity, 0), 0)
  })

  it('returns undefined without fallback for non-numbers', () => {
    assert.equal(asNumber('42'), undefined)
    assert.equal(asNumber(NaN), undefined)
    assert.equal(asNumber(Infinity), undefined)
  })

  it('returns number without fallback for valid numbers', () => {
    assert.equal(asNumber(42), 42)
    assert.equal(asNumber(0), 0)
  })
})

describe('asBoolean', () => {
  it('returns boolean for booleans', () => {
    assert.equal(asBoolean(true, false), true)
    assert.equal(asBoolean(false, true), false)
  })

  it('returns fallback for non-booleans', () => {
    assert.equal(asBoolean(1, false), false)
    assert.equal(asBoolean('true', false), false)
    assert.equal(asBoolean(null, true), true)
  })
})

describe('mapConcurrent', () => {
  it('processes items with concurrency limit', async () => {
    const items = [1, 2, 3, 4, 5]
    const results = await mapConcurrent(items, 2, async (item) => item * 2)
    assert.deepEqual(results, [2, 4, 6, 8, 10])
  })

  it('handles empty array', async () => {
    const results = await mapConcurrent([], 5, async (item: number) => item)
    assert.deepEqual(results, [])
  })

  it('preserves order', async () => {
    const items = [3, 1, 2]
    const results = await mapConcurrent(items, 1, async (item) => {
      await new Promise((r) => setTimeout(r, item * 10))
      return item
    })
    assert.deepEqual(results, [3, 1, 2])
  })
})
