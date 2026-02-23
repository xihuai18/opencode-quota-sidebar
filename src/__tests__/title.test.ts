import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  canonicalizeTitle,
  looksDecorated,
  normalizeBaseTitle,
} from '../title.js'

describe('title', () => {
  it('normalizes base title to first line', () => {
    assert.equal(normalizeBaseTitle('Hello\nInput 1 Output 2'), 'Hello')
    assert.equal(normalizeBaseTitle('\u001b[2mHello\u001b[0m\nWorld'), 'Hello')
    assert.equal(normalizeBaseTitle(''), 'Session')
  })

  it('canonicalizes by trimming line endings', () => {
    assert.equal(canonicalizeTitle('A  \nB\n'), 'A\nB\n')
  })

  it('detects decorated titles', () => {
    assert.equal(looksDecorated('Session'), false)
    assert.equal(looksDecorated('Session\nInput 1k  Output 2k'), true)
    assert.equal(looksDecorated('Session\nCache Read 10'), true)
    assert.equal(looksDecorated('Session\n$1.23 as API cost'), true)
    assert.equal(looksDecorated('Session\nOpenAI 5h 80%'), true)
  })
})
