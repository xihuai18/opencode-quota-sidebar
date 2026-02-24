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

async function waitFor(check: () => boolean, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (check()) return
    await delay(25)
  }
  assert.ok(check(), 'condition not met before timeout')
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

      await waitFor(() => updates.length > 0)

      assert.ok(updates.length > 0)
      assert.match(title, /Input\s+18\.9k\s+Output\s+53/)
      assert.match(title, /\$0\.02 as API cost/)
      assert.match(title, /Cache Read 1\.5k/)
      assert.doesNotMatch(title, /\u001b/)
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('includes descendant subagent usage and quota providers in parent title', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome
    const originalFetch = globalThis.fetch

    const authPath = path.join(dataHome, 'auth.json')
    await fs.writeFile(
      authPath,
      JSON.stringify(
        {
          openai: { type: 'oauth', access: 'openai-token' },
          'github-copilot': { type: 'oauth', access: 'copilot-token' },
        },
        null,
        2,
      ),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = async (
      input,
    ) => {
      const url = String(input)
      if (url.includes('chatgpt.com/backend-api/wham/usage')) {
        return new Response(
          JSON.stringify({
            rate_limit: {
              primary_window: {
                used_percent: 20,
                limit_window_seconds: 18_000,
                reset_at: Math.floor(Date.now() / 1000) + 1800,
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('api.github.com/copilot_internal/user')) {
        return new Response(
          JSON.stringify({
            quota_snapshots: {
              premium_interactions: {
                remaining_percent: 75,
                quota_reset_date_utc: new Date(
                  Date.now() + 86400_000,
                ).toISOString(),
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('{}', { status: 404 })
    }

    try {
      const sessions = {
        p1: {
          id: 'p1',
          title: 'Parent Session',
          parentID: undefined as string | undefined,
          time: { created: Date.now() - 20_000 },
        },
        c1: {
          id: 'c1',
          title: 'Child Session',
          parentID: 'p1',
          time: { created: Date.now() - 10_000 },
        },
      }

      const updates: Array<{ id: string; title: string }> = []

      const parentMessage = {
        id: 'm-parent',
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5',
        sessionID: 'p1',
        time: { created: Date.now() - 9_000, completed: Date.now() - 8_900 },
        tokens: {
          input: 100,
          output: 20,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0.01,
      }

      const childMessage = {
        id: 'm-child',
        role: 'assistant',
        providerID: 'github-copilot',
        modelID: 'gpt-4.1',
        sessionID: 'c1',
        time: { created: Date.now() - 2_000, completed: Date.now() - 1_900 },
        tokens: {
          input: 200,
          output: 30,
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
                  cache_read: 0,
                  cache_write: 0,
                },
                limit: { context: 1_000_000, output: 8_192 },
                options: {},
              },
            },
          },
          {
            id: 'github-copilot',
            name: 'GitHub Copilot',
            env: [],
            models: {
              'gpt-4.1': {
                id: 'gpt-4.1',
                name: 'GPT-4.1',
                release_date: '2026-01-01',
                attachment: true,
                reasoning: true,
                temperature: true,
                tool_call: true,
                cost: {
                  input: 0,
                  output: 0,
                  cache_read: 0,
                  cache_write: 0,
                },
                limit: { context: 1_000_000, output: 8_192 },
                options: {},
              },
            },
          },
        ],
        default: {},
        connected: ['openai', 'github-copilot'],
      }

      const hooks = await QuotaSidebarPlugin({
        directory: projectDir,
        worktree: projectDir,
        client: {
          session: {
            get: async (args: { path: { id: string } }) => ({
              data: sessions[args.path.id as 'p1' | 'c1'],
            }),
            update: async (args: {
              path: { id: string }
              body: { title: string }
            }) => {
              const id = args.path.id as 'p1' | 'c1'
              sessions[id].title = args.body.title
              updates.push({ id, title: args.body.title })
              return { data: { ok: true } }
            },
            messages: async (args: { path: { id: string } }) => {
              const id = args.path.id
              if (id === 'p1') return { data: [{ info: parentMessage }] }
              if (id === 'c1') return { data: [{ info: childMessage }] }
              return { data: [] }
            },
            children: async (args: { path: { id: string } }) => {
              if (args.path.id === 'p1') return { data: [sessions.c1] }
              return { data: [] }
            },
            list: async () => ({ data: [{ id: 'p1' }, { id: 'c1' }] }),
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
        event: { type: 'message.updated', properties: { info: childMessage } },
      } as never)

      await waitFor(() => updates.some((u) => u.id === 'p1'))

      const latestParent = [...updates]
        .reverse()
        .find((item) => item.id === 'p1')
      assert.ok(latestParent)
      assert.match(latestParent!.title, /Input 300  Output 50/)
      assert.match(latestParent!.title, /OpenAI/)
      assert.match(latestParent!.title, /Copilot/)
    } finally {
      ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })
})
