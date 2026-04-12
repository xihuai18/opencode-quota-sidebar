import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  cliBaseUrl,
  cliExitCodeForError,
  cliServerCommandCandidates,
  parseCliArgs,
} from '../cli.js'

describe('parseCliArgs', () => {
  it('parses current natural period commands', () => {
    assert.deepEqual(parseCliArgs(['day']), { period: 'day' })
    assert.deepEqual(parseCliArgs(['week']), { period: 'week' })
    assert.deepEqual(parseCliArgs(['month']), { period: 'month' })
  })

  it('parses positional last arguments', () => {
    assert.deepEqual(parseCliArgs(['day', '7']), { period: 'day', last: 7 })
    assert.deepEqual(parseCliArgs(['week', '8']), { period: 'week', last: 8 })
    assert.deepEqual(parseCliArgs(['month', '6']), {
      period: 'month',
      last: 6,
    })
  })

  it('parses positional and flag since arguments', () => {
    assert.deepEqual(parseCliArgs(['day', '2026-04-01']), {
      period: 'day',
      since: '2026-04-01',
    })
    assert.deepEqual(parseCliArgs(['month', '--since', '2026-01']), {
      period: 'month',
      since: '2026-01',
    })
  })

  it('rejects invalid combinations', () => {
    assert.throws(
      () => parseCliArgs(['day', '7', '--since', '2026-04-01']),
      /Cannot use both since and last/,
    )
    assert.throws(
      () => parseCliArgs(['month', '--since', '2026-04-01']),
      /YYYY-MM/,
    )
    assert.throws(() => parseCliArgs(['year']), /Unknown period/)
  })

  it('returns exit code 0 only for explicit help text', () => {
    const helpError = (() => {
      try {
        parseCliArgs(['--help'])
        return ''
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })()

    const invalidError = (() => {
      try {
        parseCliArgs(['year'])
        return ''
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })()

    assert.equal(cliExitCodeForError(helpError), 0)
    assert.equal(cliExitCodeForError(invalidError), 1)
  })

  it('uses localhost API by default and allows override', () => {
    const original = process.env.OPENCODE_BASE_URL
    try {
      delete process.env.OPENCODE_BASE_URL
      assert.equal(cliBaseUrl(), 'http://localhost:4096')
      process.env.OPENCODE_BASE_URL = 'http://127.0.0.1:7777'
      assert.equal(cliBaseUrl(), 'http://127.0.0.1:7777')
    } finally {
      if (original === undefined) delete process.env.OPENCODE_BASE_URL
      else process.env.OPENCODE_BASE_URL = original
    }
  })

  it('uses platform-specific server startup candidates', () => {
    assert.deepEqual(cliServerCommandCandidates('linux'), [
      {
        command: 'opencode',
        args: ['serve', '--hostname=127.0.0.1', '--port=4096'],
      },
    ])

    const win = cliServerCommandCandidates('win32')
    assert.equal(win[0]?.command, 'opencode.cmd')
    assert.equal(
      win[1]?.command,
      'opencode serve --hostname=127.0.0.1 --port=4096',
    )
    assert.equal(win[1]?.shell, true)
    assert.equal(win[2]?.command, 'bash')
  })
})
