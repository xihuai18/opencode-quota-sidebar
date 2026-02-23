import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { QuotaSidebarPlugin } from '../index.js'

const tmpDirs: string[] = []

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-plugin-test-'))
  tmpDirs.push(dir)
  return dir
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

afterEach(async () => {
  await Promise.all(
    tmpDirs
      .splice(0, tmpDirs.length)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  )
})

describe('plugin integration', () => {
  it('updates session title after assistant message with plain text lines', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome
    try {
      let title = 'Greeting and quick check-in'
      const updates: string[] = []

      const msg = {
        id: 'm1',
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5',
        sessionID: 's1',
        time: { created: Date.now() - 1000, completed: Date.now() - 900 },
        tokens: {
          input: 18_900,
          output: 53,
          reasoning: 0,
          cache: { read: 1500, write: 0 },
        },
        cost: 0.02,
      }

      const providerListData = {
        all: [
          {
            id: 'openai',
            name: 'OpenAI',
            env: [],
            models: {
              'gpt-5': {
                id: 'gpt-5',
                name: 'GPT-5',
                release_date: '2026-01-01',
                attachment: true,
                reasoning: true,
                temperature: true,
                tool_call: true,
                cost: {
                  input: 1,
                  output: 2,
                  cache_read: 0.5,
                  cache_write: 0,
                },
                limit: { context: 1_000_000, output: 8_192 },
                options: {},
              },
            },
          },
        ],
        default: {},
        connected: ['openai'],
      }

      const hooks = await QuotaSidebarPlugin({
        directory: projectDir,
        worktree: projectDir,
        client: {
          session: {
            get: async () => ({
              data: { id: 's1', title, time: { created: Date.now() - 10_000 } },
            }),
            update: async (args: { body: { title: string } }) => {
              title = args.body.title
              updates.push(title)
              return { data: { ok: true } }
            },
            messages: async () => ({ data: [{ info: msg }] }),
            list: async () => ({ data: [{ id: 's1' }] }),
          },
          tui: {
            showToast: async () => ({ data: { ok: true } }),
          },
          auth: {
            set: async () => ({ data: { ok: true } }),
          },
          provider: {
            list: async () => ({ data: providerListData }),
          },
        },
      } as never)

      await hooks.event!({
        event: { type: 'message.updated', properties: { info: msg } },
      } as never)

      await delay(500)

      assert.ok(updates.length > 0)
      assert.match(title, /Input\s+18\.9k\s+Output\s+53/)
      assert.match(title, /\$0\.02 as API cost/)
      assert.match(title, /Cache Read 1\.5k/)
      assert.doesNotMatch(title, /\u001b\[[0-9;]*m/)
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })
})
