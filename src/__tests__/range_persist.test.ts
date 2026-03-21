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
import { USAGE_BILLING_CACHE_VERSION } from '../usage.js'

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
  it('summarizes day usage by message completion time rather than session creation time', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome

    try {
      const dataDir = resolveOpencodeDataDir()
      await fs.mkdir(dataDir, { recursive: true })
      const statePath = stateFilePath(dataDir)

      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const yesterdayStart = todayStart.getTime() - 24 * 60 * 60 * 1000
      const todayKey = dateKeyFromTimestamp(todayStart.getTime())
      const yesterdayKey = dateKeyFromTimestamp(yesterdayStart)

      await fs.writeFile(
        statePath,
        `${JSON.stringify(
          {
            version: 2,
            titleEnabled: true,
            sessionDateMap: {
              carry: yesterdayKey,
              early: todayKey,
            },
            deletedSessionDateMap: {},
            quotaCache: {},
          },
          null,
          2,
        )}\n`,
        'utf8',
      )

      const chunkRoot = path.join(dataDir, 'quota-sidebar-sessions')
      const carryPath = path.join(
        chunkRoot,
        yesterdayKey.slice(0, 4),
        yesterdayKey.slice(5, 7),
        `${yesterdayKey.slice(8, 10)}.json`,
      )
      const earlyPath = path.join(
        chunkRoot,
        todayKey.slice(0, 4),
        todayKey.slice(5, 7),
        `${todayKey.slice(8, 10)}.json`,
      )
      await fs.mkdir(path.dirname(carryPath), { recursive: true })
      await fs.mkdir(path.dirname(earlyPath), { recursive: true })

      await fs.writeFile(
        carryPath,
        `${JSON.stringify(
          {
            version: 1,
            dateKey: yesterdayKey,
            sessions: {
              carry: {
                createdAt: yesterdayStart + 1_000,
                baseTitle: 'Carry',
              },
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      )

      await fs.writeFile(
        earlyPath,
        `${JSON.stringify(
          {
            version: 1,
            dateKey: todayKey,
            sessions: {
              early: {
                createdAt: todayStart.getTime() + 1_000,
                baseTitle: 'Early',
              },
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      )

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

      const messagesBySession: Record<string, Array<{ info: any }>> = {
        carry: [
          {
            info: {
              id: 'm-carry',
              role: 'assistant',
              providerID: 'openai',
              modelID: 'gpt-5',
              sessionID: 'carry',
              time: {
                created: yesterdayStart + 2_000,
                completed: todayStart.getTime() + 60_000,
              },
              tokens: {
                input: 100,
                output: 20,
                reasoning: 0,
                cache: { read: 20, write: 0 },
              },
              cost: 0,
            },
          },
        ],
        early: [
          {
            info: {
              id: 'm-early',
              role: 'assistant',
              providerID: 'openai',
              modelID: 'gpt-5',
              sessionID: 'early',
              time: {
                created: todayStart.getTime() + 2_000,
                completed: yesterdayStart + 60_000,
              },
              tokens: {
                input: 999,
                output: 1,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              cost: 0,
            },
          },
        ],
      }

      const hooks = await QuotaSidebarPlugin({
        directory: projectDir,
        worktree: projectDir,
        client: {
          session: {
            messages: async ({ path: requestPath }: any) => ({
              data: messagesBySession[requestPath.id] || [],
            }),
          },
          provider: {
            list: async () => ({ data: providerListData }),
          },
        },
      } as never)

      const report = await hooks.tool!.quota_summary.execute(
        { period: 'day', toast: false },
        { sessionID: 'carry' } as never,
      )

      assert.match(report, /- Sessions: 1/)
      assert.match(
        report,
        /input 100, output 20, cache_read 20, cache_write 0, total 140/,
      )
      assert.match(report, /- Cache Read Coverage: 16\.7%/)
      assert.doesNotMatch(report, /999/)
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

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
            deletedSessionDateMap: {},
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

  it('persists recomputed usage for disk-only sessions not loaded in memory', async () => {
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

      // Keep sessionDateMap empty so this session remains disk-only during
      // plugin load (not materialized into state.sessions memory cache).
      await fs.writeFile(
        statePath,
        `${JSON.stringify(
          {
            version: 2,
            titleEnabled: true,
            sessionDateMap: {},
            deletedSessionDateMap: {},
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
              's-disk': {
                createdAt,
                baseTitle: 'Disk Session',
                usage: {
                  billingVersion: 0,
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
                cursor: {
                  lastMessageId: 'old',
                  lastMessageTime: createdAt,
                  lastMessageIdsAtTime: ['old'],
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
        sessionID: 's-disk',
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
        sessionID: 's-disk',
      } as never)

      await delay(600)

      const updated = JSON.parse(await fs.readFile(chunkPath, 'utf8')) as any
      const usage = updated.sessions?.['s-disk']?.usage
      assert.ok(usage)
      assert.equal(usage.billingVersion, USAGE_BILLING_CACHE_VERSION)
      assert.ok(usage.apiCost > 0)
      assert.equal(updated.sessions?.['s-disk']?.cursor?.lastMessageId, 'm1')
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('fails day summary instead of silently undercounting when session messages cannot load', async () => {
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
            deletedSessionDateMap: {},
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
              },
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      )

      const hooks = await QuotaSidebarPlugin({
        directory: projectDir,
        worktree: projectDir,
        client: {
          session: {
            messages: async () => {
              throw new Error('load failed')
            },
          },
          provider: {
            list: async () => ({
              data: { all: [], default: {}, connected: [] },
            }),
          },
        },
      } as never)

      await assert.rejects(
        hooks.tool!.quota_summary.execute({ period: 'day', toast: false }, {
          sessionID: 's1',
        } as never),
        /range usage unavailable: failed to load 1 session\(s\)/,
      )
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('prunes missing sessions from persisted range data and continues the summary', async () => {
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
            sessionDateMap: { stale: dateKey, live: dateKey },
            deletedSessionDateMap: {},
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
              stale: {
                createdAt,
                baseTitle: 'Stale Session',
                cursor: {
                  lastMessageId: 'stale-last',
                  lastMessageTime: createdAt + 2_000,
                  lastMessageIdsAtTime: ['stale-last'],
                },
              },
              live: {
                createdAt,
                baseTitle: 'Live Session',
              },
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      )

      const hooks = await QuotaSidebarPlugin({
        directory: projectDir,
        worktree: projectDir,
        client: {
          session: {
            messages: async (args: { path: { id: string } }) => {
              if (args.path.id === 'stale') {
                throw Object.assign(new Error('session not found'), {
                  status: 404,
                })
              }

              return {
                data: [
                  {
                    info: {
                      id: 'm-live',
                      role: 'assistant',
                      providerID: 'openai',
                      modelID: 'gpt-5',
                      sessionID: 'live',
                      time: {
                        created: createdAt + 3_000,
                        completed: createdAt + 3_500,
                      },
                      tokens: {
                        input: 10,
                        output: 5,
                        reasoning: 0,
                        cache: { read: 0, write: 0 },
                      },
                      cost: 0,
                    },
                  },
                ],
              }
            },
          },
          provider: {
            list: async () => ({
              data: { all: [], default: {}, connected: [] },
            }),
          },
        },
      } as never)

      const markdown = await hooks.tool!.quota_summary.execute(
        { period: 'day', toast: false },
        { sessionID: 'live' } as never,
      )

      assert.match(markdown, /- Sessions: 1/)

      await delay(600)

      const updatedState = JSON.parse(
        await fs.readFile(statePath, 'utf8'),
      ) as any
      const updatedChunk = JSON.parse(
        await fs.readFile(chunkPath, 'utf8'),
      ) as any
      assert.equal(updatedState.sessionDateMap?.stale, undefined)
      assert.equal(updatedState.deletedSessionDateMap?.stale, undefined)
      assert.equal(updatedChunk.sessions?.stale, undefined)
      assert.ok(updatedChunk.sessions?.live)
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('fails day summary when a dirty session cannot load even if last cursor is before the range', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome

    try {
      const dataDir = resolveOpencodeDataDir()
      await fs.mkdir(dataDir, { recursive: true })
      const statePath = stateFilePath(dataDir)

      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const yesterday = todayStart.getTime() - 24 * 60 * 60 * 1000
      const dateKey = dateKeyFromTimestamp(yesterday)
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
            deletedSessionDateMap: {},
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
                createdAt: yesterday,
                baseTitle: 'Dirty Session',
                dirty: true,
                cursor: {
                  lastMessageId: 'old',
                  lastMessageTime: yesterday,
                  lastMessageIdsAtTime: ['old'],
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      )

      const hooks = await QuotaSidebarPlugin({
        directory: projectDir,
        worktree: projectDir,
        client: {
          session: {
            messages: async () => {
              throw new Error('load failed')
            },
          },
          provider: {
            list: async () => ({
              data: { all: [], default: {}, connected: [] },
            }),
          },
        },
      } as never)

      await assert.rejects(
        hooks.tool!.quota_summary.execute({ period: 'day', toast: false }, {
          sessionID: 's1',
        } as never),
        /range usage unavailable: failed to load 1 session\(s\)/,
      )
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('treats user-only sessions as zero-usage instead of load failures', async () => {
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
            deletedSessionDateMap: {},
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
              },
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      )

      const hooks = await QuotaSidebarPlugin({
        directory: projectDir,
        worktree: projectDir,
        client: {
          session: {
            messages: async () => ({
              data: [
                {
                  info: {
                    id: 'u1',
                    sessionID: 's1',
                    role: 'user',
                    time: { created: createdAt, completed: createdAt },
                  },
                },
              ],
            }),
          },
          provider: {
            list: async () => ({
              data: { all: [], default: {}, connected: [] },
            }),
          },
        },
      } as never)

      const report = await hooks.tool!.quota_summary.execute(
        { period: 'day', toast: false },
        { sessionID: 's1' } as never,
      )

      assert.match(report, /- Sessions: 0/)
      assert.match(
        report,
        /input 0, output 0, cache_read 0, cache_write 0, total 0/,
      )
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })
})
