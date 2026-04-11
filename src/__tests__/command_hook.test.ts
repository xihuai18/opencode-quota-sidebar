import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { QuotaSidebarPlugin } from '../index.js'
import { createHistoryCommands } from '../tui_commands.js'

const tmpDirs: string[] = []

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-command-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(
    tmpDirs
      .splice(0, tmpDirs.length)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  )
})

describe('quota history command routing', () => {
  it('does not register a server-side qday/qweek/qmonth command hook', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome

    try {
      const hooks = await QuotaSidebarPlugin({
        directory: projectDir,
        worktree: projectDir,
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
          provider: {
            list: async () => ({
              data: { all: [], default: {}, connected: [] },
            }),
          },
        },
      } as never)

      assert.equal(hooks['command.execute.before'], undefined)
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('keeps historical quota_summary reports available without a TUI toast client', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome

    try {
      const hooks = await QuotaSidebarPlugin({
        directory: projectDir,
        worktree: projectDir,
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
          provider: {
            list: async () => ({
              data: { all: [], default: {}, connected: [] },
            }),
          },
        },
      } as never)

      const report = await hooks.tool!.quota_summary.execute(
        { period: 'month', since: '2026-01', toast: true },
        { sessionID: 's1' } as never,
      )

      assert.match(report, /## Quota History - Monthly since 2026-01/)
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('registers qday qweek and qmonth as TUI slash commands', () => {
    const opened: string[] = []
    const commands = createHistoryCommands((period) => opened.push(period))

    assert.deepEqual(
      commands.map((command) => ({
        value: command.value,
        slash: command.slash?.name,
      })),
      [
        { value: 'quota.history.day', slash: 'qday' },
        { value: 'quota.history.week', slash: 'qweek' },
        { value: 'quota.history.month', slash: 'qmonth' },
      ],
    )

    for (const command of commands) {
      command.onSelect?.()
    }

    assert.deepEqual(opened, ['day', 'week', 'month'])
  })
})
