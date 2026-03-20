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
    assert.equal(normalizeBaseTitle('\u001b[2mHello\u001b[0m\nWorld'), 'Hello\nWorld')
    assert.equal(
      normalizeBaseTitle('Hello | Input 1  Output 2 | OpenAI 80%'),
      'Hello',
    )
    assert.equal(
      normalizeBaseTitle('Session | I see OpenAI'),
      'Session | I see OpenAI',
    )
    assert.equal(normalizeBaseTitle(''), 'Session')
  })

  it('canonicalizes by trimming line endings', () => {
    assert.equal(canonicalizeTitle('A  \nB\n'), 'A\nB\n')
  })

  it('detects decorated titles', () => {
    assert.equal(looksDecorated('Session'), false)
    assert.equal(looksDecorated('Session\nInput 1k  Output 2k'), true)
    assert.equal(looksDecorated('Session\nCache Read 10'), true)
    assert.equal(looksDecorated('Session\nCache Coverage 60%'), false)
    assert.equal(looksDecorated('Session\nCache Read Coverage 75%'), false)
    assert.equal(looksDecorated('Session\n$1.23 as API cost'), true)
    assert.equal(looksDecorated('Session\nOpenAI 5h 80%'), false)
    assert.equal(looksDecorated('Project rollout\nOpenAI 50% complete'), false)
    assert.equal(looksDecorated('Ops\nRC Balance $50'), false)
    assert.equal(looksDecorated('Budget\n$100 as API cost target'), false)
    assert.equal(looksDecorated('Session\nCache Coverage plan'), false)
    assert.equal(looksDecorated('Session\nCache Read Coverage notes'), false)
    assert.equal(looksDecorated('Session\nOpenAI migration plan'), false)
    assert.equal(looksDecorated('Session\n$100 budget'), false)
    assert.equal(looksDecorated('Session | I see OpenAI'), false)
    assert.equal(
      looksDecorated('Session | Input 1k  Output 2k | OpenAI 80%'),
      true,
    )
    assert.equal(looksDecorated('Session|Input 1k  Output 2k|OpenAI 80%'), true)
    assert.equal(looksDecorated('Greetin~ | Input 1.~'), true)
    assert.equal(looksDecorated('Greetin~ | Input 1.~ | OpenAI 8~'), true)
    assert.equal(looksDecorated('Spec | Input validation'), false)
    assert.equal(looksDecorated('Spec | Input 1 Output format'), false)
    assert.equal(looksDecorated('Notes | OpenAI migration plan'), false)
    assert.equal(looksDecorated('Budget | $100 as API cost target'), false)
    assert.equal(looksDecorated('Input 1k  Output 2k | OpenAI 80%'), false)
  })
})
