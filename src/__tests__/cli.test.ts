import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import {
  cliBaseUrl,
  cliExitCodeForError,
  cliServerCommandCandidates,
  cliShouldRunMain,
  closeCliServerProcess,
  parseCliArgs,
  tryStartCliOpencodeServer,
} from '../cli.js'

type SpawnFn = typeof import('node:child_process').spawn

class FakeChildStream extends EventEmitter {
  destroyCalls = 0
  unpipeCalls = 0

  destroy() {
    this.destroyCalls += 1
    return this
  }

  unpipe() {
    this.unpipeCalls += 1
    return this
  }
}

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

  it('starts the fallback server in a detached process group and releases pipes after startup', async () => {
    const stdout = new FakeChildStream()
    const stderr = new FakeChildStream()
    const proc = Object.assign(new EventEmitter(), {
      pid: 4321,
      stdout,
      stderr,
      unrefCalls: 0,
      unref() {
        this.unrefCalls += 1
      },
    })

    const calls: Array<{
      command: string
      args: string[]
      options: Record<string, unknown>
    }> = []
    const fakeSpawn = ((command: string, args: string[], options: object) => {
      calls.push({
        command,
        args,
        options: options as Record<string, unknown>,
      })
      queueMicrotask(() => {
        stdout.emit(
          'data',
          'opencode server listening on http://127.0.0.1:4096\n',
        )
      })
      return proc as unknown as ReturnType<SpawnFn>
    }) as unknown as SpawnFn

    const server = await tryStartCliOpencodeServer(
      {
        command: 'opencode',
        args: ['serve', '--hostname=127.0.0.1', '--port=4096'],
      },
      fakeSpawn,
    )

    assert.equal(server.url, 'http://127.0.0.1:4096')
    assert.equal(calls[0]?.command, 'opencode')
    assert.equal(calls[0]?.options.detached, true)
    assert.equal(calls[0]?.options.windowsHide, true)
    assert.equal(proc.unrefCalls, 1)
    assert.equal(stdout.listenerCount('data'), 0)
    assert.equal(stderr.listenerCount('data'), 0)
    assert.equal(stdout.unpipeCalls, 1)
    assert.equal(stderr.unpipeCalls, 1)
    assert.equal(stdout.destroyCalls, 1)
    assert.equal(stderr.destroyCalls, 1)
  })

  it('routes returned server.close through the close helper', async () => {
    const stdout = new FakeChildStream()
    const stderr = new FakeChildStream()
    const proc = Object.assign(new EventEmitter(), {
      pid: 4321,
      stdout,
      stderr,
      unref() {},
    })

    const fakeSpawn = ((command: string, args: string[], options: object) => {
      void command
      void args
      void options
      queueMicrotask(() => {
        stdout.emit(
          'data',
          'opencode server listening on http://127.0.0.1:4096\n',
        )
      })
      return proc as unknown as ReturnType<SpawnFn>
    }) as unknown as SpawnFn

    const closed: Array<{ pid: number }> = []
    const server = await tryStartCliOpencodeServer(
      {
        command: 'opencode',
        args: ['serve', '--hostname=127.0.0.1', '--port=4096'],
      },
      fakeSpawn,
      ((child) => {
        closed.push({ pid: child.pid ?? -1 })
      }) as typeof closeCliServerProcess,
    )

    server.close()

    assert.deepEqual(closed, [{ pid: 4321 }])
  })

  it('kills the detached process group on POSIX', () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = []
    closeCliServerProcess({ pid: 4321 } as never, 'linux', ((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      signals.push({ pid, signal: signal as NodeJS.Signals })
      return true
    }) as typeof process.kill)

    assert.deepEqual(signals, [{ pid: -4321, signal: 'SIGTERM' }])
  })

  it('uses taskkill tree termination on Windows', () => {
    const calls: Array<{
      command: string
      args: string[]
      options: Record<string, unknown>
    }> = []
    let unrefCalls = 0
    const fakeSpawn = ((command: string, args: string[], options: object) => {
      calls.push({
        command,
        args,
        options: options as Record<string, unknown>,
      })
      return {
        unref() {
          unrefCalls += 1
        },
      } as never
    }) as unknown as SpawnFn

    closeCliServerProcess(
      { pid: 4321 } as never,
      'win32',
      process.kill,
      fakeSpawn,
    )

    assert.deepEqual(calls, [
      {
        command: 'taskkill',
        args: ['/PID', '4321', '/T', '/F'],
        options: { stdio: 'ignore', windowsHide: true },
      },
    ])
    assert.equal(unrefCalls, 1)
  })

  it('treats symlinked bin paths as the CLI entrypoint', () => {
    const modulePath = '/pkg/dist/cli.js'
    const symlinkPath = '/usr/local/bin/opencode-quota'
    const resolvePath = (value: string) =>
      value === symlinkPath ? modulePath : value

    assert.equal(cliShouldRunMain(symlinkPath, modulePath, resolvePath), true)
    assert.equal(
      cliShouldRunMain('/tmp/other.js', modulePath, resolvePath),
      false,
    )
    assert.equal(cliShouldRunMain(undefined, modulePath, resolvePath), false)
  })
})
