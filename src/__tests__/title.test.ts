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
    assert.equal(
      normalizeBaseTitle('\u001b[2mHello\u001b[0m\nWorld'),
      'Hello\nWorld',
    )
    assert.equal(
      normalizeBaseTitle('Hello | Input 1  Output 2 | OpenAI 80%'),
      'Hello',
    )
    assert.equal(
      normalizeBaseTitle(
        'Hello | R12 I18.9k O53 | OAI 5h80 W70 | RC D88.9/60 B260',
      ),
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
    assert.equal(looksDecorated('Session\nCache Coverage 60%'), true)
    assert.equal(looksDecorated('Session\nCache Read Coverage 75%'), true)
    assert.equal(looksDecorated('Session\nCache Cov 60%'), true)
    assert.equal(looksDecorated('Session\nCache Read Cov 75%'), true)
    assert.equal(looksDecorated('Session\nCache R Cov 75%'), true)
    assert.equal(looksDecorated('Session\n$1.23 as API cost'), true)
    assert.equal(looksDecorated('Session\nAPI $1.23'), true)
    assert.equal(looksDecorated('Session\nR3 I16.3k O916'), true)
    assert.equal(looksDecorated('Session\nCd 66% W300 R31.4k'), true)
    assert.equal(looksDecorated('Session\nCR31.4k CRC66% CC70%'), true)
    assert.equal(looksDecorated('Session\nCached 66%'), true)
    assert.equal(looksDecorated('Session\nEst$0.12'), true)
    assert.equal(
      looksDecorated('Session\nLEGACYAI Daily $58.3/$90 Rst 22:18'),
      true,
    )
    assert.equal(looksDecorated('Session\nKimi\n  5h 100% Rst 23:44'), true)
    assert.equal(looksDecorated('Session\nOpenAI 5h 80%'), true)
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
    assert.equal(
      looksDecorated(
        'Session | R12 I18.9k O53 | OAI 5h80 W70 | RC D88.9/60 B260',
      ),
      true,
    )
    assert.equal(
      looksDecorated('Session | R12 I18.9k O53 | OAI 5h80 W70 Sk5h100 SkW100'),
      true,
    )
    assert.equal(
      looksDecorated('Session | R12 I18.9k O53 | Ant 5h80 St | Est$0.12'),
      true,
    )
    assert.equal(
      looksDecorated('Session | LEGACYAI D$58.3/$90 R22:18 | Est$0.12'),
      true,
    )
    assert.equal(looksDecorated('Session\nAnthropic 5h 80% stale'), true)
    assert.equal(looksDecorated('Session|Input 1k  Output 2k|OpenAI 80%'), true)
    assert.equal(looksDecorated('Greetin~ | Input 1.~'), true)
    assert.equal(looksDecorated('Greetin~ | Input 1.~ | OpenAI 8~'), true)
    assert.equal(looksDecorated('Spec | Input validation'), false)
    assert.equal(looksDecorated('Spec | Input 1 Output format'), false)
    assert.equal(looksDecorated('Notes | OpenAI migration plan'), false)
    assert.equal(looksDecorated('Budget | $100 as API cost target'), false)
    assert.equal(looksDecorated('Input 1k  Output 2k | OpenAI 80%'), false)
  })

  it('treats multiline cache coverage echoes as decorated while preserving plain text titles', () => {
    assert.equal(normalizeBaseTitle('Session\nCache Coverage 60%'), 'Session')
    assert.equal(
      normalizeBaseTitle('Session\nCache Read Coverage 75%'),
      'Session',
    )
    assert.equal(normalizeBaseTitle('Session\nCache Cov 60%'), 'Session')
    assert.equal(normalizeBaseTitle('Session\nCache R Cov 75%'), 'Session')
    assert.equal(normalizeBaseTitle('Session\nAPI $1.23'), 'Session')
    assert.equal(normalizeBaseTitle('Session\nR3 I16.3k O916'), 'Session')
    assert.equal(normalizeBaseTitle('Session\nCd 66% W300 R31.4k'), 'Session')
    assert.equal(normalizeBaseTitle('Session\nCR31.4k CRC66% CC70%'), 'Session')
    assert.equal(normalizeBaseTitle('Session\nCached 66%'), 'Session')
    assert.equal(normalizeBaseTitle('Session\nEst$0.12'), 'Session')
    assert.equal(
      normalizeBaseTitle('Session\nLEGACYAI Daily $58.3/$90 Rst 22:18'),
      'Session',
    )
    assert.equal(
      normalizeBaseTitle('Session | LEGACYAI D$58.3/$90 R22:18 | Est$0.12'),
      'Session',
    )
    assert.equal(
      normalizeBaseTitle('Session | OAI 5h80 W70 Sk5h100 SkW100 | Est$0.12'),
      'Session',
    )
    assert.equal(
      normalizeBaseTitle('Project notes\nCache Coverage plan'),
      'Project notes\nCache Coverage plan',
    )
    assert.equal(
      normalizeBaseTitle('Session\nAnthropic 5h 80% stale'),
      'Session',
    )
    assert.equal(
      normalizeBaseTitle('Project notes\nOpenAI 50% complete'),
      'Project notes\nOpenAI 50% complete',
    )
  })
})
