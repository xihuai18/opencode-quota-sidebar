import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { QuotaSidebarPlugin } from '../index.js'

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

describe('quota history command hook', () => {
  it('renders month history markdown for qmonth arguments', async () => {
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

      const output = { parts: [] as any[] }
      await hooks['command.execute.before']?.(
        {
          command: 'qmonth',
          arguments: '2026-01',
          sessionID: 's1',
        },
        output,
      )

      assert.equal(output.parts.length, 1)
      assert.equal(output.parts[0].type, 'text')
      assert.match(
        output.parts[0].text,
        /## Quota History - Monthly since 2026-01/,
      )
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })
})
