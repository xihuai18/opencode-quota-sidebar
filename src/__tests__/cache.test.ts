import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { TtlValueCache } from '../cache.js'

describe('TtlValueCache', () => {
  it('set returns the stored value', () => {
    const cache = new TtlValueCache<string>()
    assert.equal(cache.set('hello', 1000, 0), 'hello')
  })

  it('returns value before expiry and undefined after expiry', () => {
    const cache = new TtlValueCache<string>()
    cache.set('v1', 1000, 100)

    assert.equal(cache.get(500), 'v1')
    assert.equal(cache.get(1100), undefined)
    assert.equal(cache.get(1200), undefined)
  })

  it('treats zero TTL as immediately expired', () => {
    const cache = new TtlValueCache<string>()
    cache.set('v1', 0, 100)
    assert.equal(cache.get(100), undefined)
  })

  it('clear removes cached value', () => {
    const cache = new TtlValueCache<number>()
    cache.set(123, 1000, 0)
    assert.equal(cache.get(10), 123)
    cache.clear()
    assert.equal(cache.get(10), undefined)
  })
})
