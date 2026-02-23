import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { QuotaSidebarPlugin } from '../index.js'
import {
  dateKeyFromTimestamp,
  resolveOpencodeDataDir,
  stateFilePath,
} from '../storage.js'

const tmpDirs: string[] = []

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-range-test-'))
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

describe('range usage persistence', () => {
  it('persists recomputed apiCost into day chunks', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome

    try {
      const dataDir = resolveOpencodeDataDir()
      await fs.mkdir(dataDir, { recursive: true })
      const statePath = stateFilePath(dataDir)

      const createdAt = Date.now() - 10_000
      const dateKey = dateKeyFromTimestamp(createdAt)
      const [year, month, day] = dateKey.split('-')
      const chunkRoot = path.join(dataDir, 'quota-sidebar-sessions')
      const chunkPath = path.join(chunkRoot, year, month, `${day}.json`)
      await fs.mkdir(path.dirname(chunkPath), { recursive: true })

      await fs.writeFile(
        statePath,
        `${JSON.stringify(
          {
            version: 2,
            titleEnabled: true,
            sessionDateMap: { s1: dateKey },
            quotaCache: {},
          },
          null,
          2,
        )}\n`,
        'utf8',
      )

      await fs.writeFile(
        chunkPath,
        `${JSON.stringify(
          {
            version: 1,
            dateKey,
            sessions: {
              s1: {
                createdAt,
                baseTitle: 'Session',
                usage: {
                  input: 1,
                  output: 1,
                  reasoning: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 2,
                  cost: 0,
                  apiCost: 0,
                  assistantMessages: 1,
                  providers: {},
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      )

      const msg = {
        id: 'm1',
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5',
        sessionID: 's1',
        time: {
          created: createdAt + 1000,
          completed: createdAt + 1100,
        },
        tokens: {
          input: 1_000_000,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0,
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
                limit: { context: 1_000_000, output: 8192 },
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
            messages: async () => ({ data: [{ info: msg }] }),
          },
          provider: {
            list: async () => ({ data: providerListData }),
          },
        },
      } as never)

      await hooks.tool!.quota_summary.execute({ period: 'day', toast: false }, {
        sessionID: 's1',
      } as never)

      await delay(600)

      const updated = JSON.parse(await fs.readFile(chunkPath, 'utf8')) as any
      assert.ok(updated.sessions?.s1?.usage?.apiCost > 0)
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })
})
