import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { QuotaSidebarPlugin } from '../index.js'
import { dateKeyFromTimestamp } from '../storage.js'

const tmpDirs: string[] = []
const ORIGINAL_OPENCODE_CLIENT = process.env.OPENCODE_CLIENT

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-plugin-test-'))
  tmpDirs.push(dir)
  return dir
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pad2(value: number) {
  return `${value}`.padStart(2, '0')
}

function dateString(value: Date) {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`
}

function monthString(value: Date) {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}`
}

function mondayString(value: Date) {
  const day = value.getDay()
  const shift = day === 0 ? 6 : day - 1
  return dateString(
    new Date(value.getFullYear(), value.getMonth(), value.getDate() - shift),
  )
}

async function waitFor(check: () => boolean, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (check()) return
    await delay(25)
  }
  assert.ok(check(), 'condition not met before timeout')
}

async function waitForAsync(check: () => Promise<boolean>, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await check()) return
    await delay(25)
  }
  assert.ok(await check(), 'condition not met before timeout')
}

async function emitAssistantLifecycle(
  hooks: Awaited<ReturnType<typeof QuotaSidebarPlugin>>,
  message: {
    time: { created: number; completed?: number }
    [key: string]: unknown
  },
) {
  const running = {
    ...message,
    time: { ...message.time, completed: undefined },
  }
  await hooks.event!({
    event: { type: 'message.updated', properties: { info: running } },
  } as never)
  await hooks.event!({
    event: { type: 'message.updated', properties: { info: message } },
  } as never)
}

afterEach(async () => {
  process.env.OPENCODE_CLIENT = ORIGINAL_OPENCODE_CLIENT
  await Promise.all(
    tmpDirs.splice(0, tmpDirs.length).map((dir) =>
      fs.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
    ),
  )
})

beforeEach(() => {
  process.env.OPENCODE_CLIENT = 'cli'
})

describe('plugin integration', () => {
  it('does not restore touched titles on startup when persisted display mode is off', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome
    try {
      await fs.mkdir(dataHome, { recursive: true })
      const statePath = path.join(dataHome, 'quota-sidebar.state.json')
      const createdAt = Date.now() - 10_000
      const dateKey = dateKeyFromTimestamp(createdAt)
      const [year, month, day] = dateKey.split('-')
      const chunkPath = path.join(
        dataHome,
        'quota-sidebar-sessions',
        year,
        month,
        `${day}.json`,
      )
      await fs.writeFile(
        statePath,
        `${JSON.stringify(
          {
            version: 2,
            titleEnabled: false,
            sessionDateMap: { s1: dateKey },
            deletedSessionDateMap: {},
            quotaCache: {},
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      await fs.mkdir(path.dirname(chunkPath), { recursive: true })
      await fs.writeFile(
        chunkPath,
        `${JSON.stringify(
          {
            version: 1,
            dateKey,
            sessions: {
              s1: {
                createdAt,
                baseTitle: 'Greeting and quick check-in',
                lastAppliedTitle:
                  'Greeting and quick check-in\n\nInput 18.9k  Output 53',
              },
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      )

      let title = 'Greeting and quick check-in\n\nInput 18.9k  Output 53'
      const updates: string[] = []

      await QuotaSidebarPlugin({
        directory: projectDir,
        worktree: projectDir,
        client: {
          session: {
            get: async () => ({
              data: { id: 's1', title, time: { created: createdAt } },
            }),
            update: async (args: { body: { title: string } }) => {
              title = args.body.title
              updates.push(title)
              return { data: { ok: true } }
            },
            messages: async () => ({ data: [] }),
            list: async () => ({ data: [{ id: 's1' }] }),
          },
          tui: {
            showToast: async () => ({ data: { ok: true } }),
          },
          auth: {
            set: async () => ({ data: { ok: true } }),
          },
          provider: {
            list: async () => ({
              data: { all: [], default: {}, connected: [] },
            }),
          },
        },
      } as never)

      await delay(100)
      assert.equal(updates.length, 0)
      assert.equal(
        title,
        'Greeting and quick check-in\n\nInput 18.9k  Output 53',
      )
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('does not refresh inactive titles on startup when persisted display mode is on', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome
    try {
      let title = 'Check recent upstream changes'
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

      await QuotaSidebarPlugin({
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

      await delay(100)

      assert.equal(updates.length, 0)
      assert.equal(title, 'Check recent upstream changes')
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('ignores replayed historical completed assistant updates for inactive sessions', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome
    try {
      let title = 'Old session'
      const updates: string[] = []

      const msg = {
        id: 'm-old',
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5',
        sessionID: 's1',
        time: {
          created: Date.now() - 60_000,
          completed: Date.now() - 55_000,
        },
        tokens: {
          input: 100,
          output: 20,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0.01,
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
              data: {
                id: 's1',
                title,
                time: { created: Date.now() - 120_000 },
              },
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

      await emitAssistantLifecycle(hooks, msg)

      await delay(100)
      assert.equal(updates.length, 0)
      assert.equal(title, 'Old session')
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('keeps shared titles compact even for the actively selected TUI session', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    await fs.writeFile(
      path.join(projectDir, 'quota-sidebar.config.json'),
      JSON.stringify({ sidebar: { multilineTitle: true } }, null, 2),
    )
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
        event: {
          type: 'tui.session.select',
          properties: { sessionID: 's1' },
        },
      } as never)

      await emitAssistantLifecycle(hooks, msg)

      await waitFor(() => updates.length > 0)

      assert.ok(updates.length > 0)
      assert.match(title, /Cd7%|Cd 7%/)
      assert.match(title, /Est\$0\.02/)
      assert.equal(title.includes('\n'), false)
      assert.doesNotMatch(title, /\u001b/)
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('does not promote shared titles to multiline on stale or renewed TUI activity', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    await fs.writeFile(
      path.join(projectDir, 'quota-sidebar.config.json'),
      JSON.stringify(
        {
          sidebar: { multilineTitle: true, showCost: false, showQuota: false },
        },
        null,
        2,
      ),
    )
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    const previousClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome
    process.env.OPENCODE_CLIENT = 'cli'
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
            list: async () => ({
              data: { all: [], default: {}, connected: [] },
            }),
          },
        },
      } as never)

      await hooks.event!({
        event: {
          type: 'tui.session.select',
          properties: { sessionID: 's1' },
        },
      } as never)
      await emitAssistantLifecycle(hooks, msg)

      await waitFor(() => updates.length > 0)
      assert.equal(title.includes('\n'), false)
      assert.match(title, /Cd7%|Cd 7%/)
      assert.doesNotMatch(title, /R1 I18\.9k O53/)

      await hooks.event!({
        event: {
          type: 'tui.command.execute',
          properties: { command: 'prompt.submit' },
        },
      } as never)
      await waitFor(() => updates.length >= 1)
      assert.equal(title.includes('\n'), false)
      assert.match(title, /Cd7%|Cd 7%/)
    } finally {
      process.env.OPENCODE_CLIENT = previousClient
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('treats a selected TUI session as active for completed-only assistant updates', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome
    try {
      let title = 'Greeting and quick check-in'
      const updates: string[] = []

      const msg = {
        id: 'm-complete-only',
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
            list: async () => ({
              data: { all: [], default: {}, connected: [] },
            }),
          },
        },
      } as never)

      await hooks.event!({
        event: {
          type: 'tui.session.select',
          properties: { sessionID: 's1' },
        },
      } as never)
      await hooks.event!({
        event: { type: 'message.updated', properties: { info: msg } },
      } as never)

      await waitFor(() => updates.length > 0)
      assert.match(title, /Cd7%|Cd 7%/)
      assert.equal(title.includes('\n'), false)
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('invalidates provider quota cache after completed updates even for inactive sessions', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome
    const originalFetch = globalThis.fetch

    await fs.writeFile(
      path.join(dataHome, 'auth.json'),
      JSON.stringify(
        {
          'rightcode-openai': { type: 'api', key: 'rc-key' },
        },
        null,
        2,
      ),
    )

    let quotaCalls = 0
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = async (
      input,
    ) => {
      const url = String(input)
      if (url.includes('www.right.codes/account/summary')) {
        quotaCalls++
        return new Response(
          JSON.stringify({
            balance: 248.4,
            subscriptions: [
              {
                name: 'Codex Plan',
                total_quota: 60,
                remaining_quota: 45,
                reset_today: true,
                available_prefixes: ['/codex'],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('{}', { status: 404 })
    }

    try {
      const msg = {
        id: 'm-inactive-quota',
        role: 'assistant',
        providerID: 'rightcode-openai',
        modelID: 'gpt-5',
        sessionID: 's1',
        time: { created: Date.now() - 1000, completed: Date.now() - 900 },
        tokens: {
          input: 100,
          output: 20,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0.01,
      }

      const providerListData = {
        all: [
          {
            id: 'rightcode-openai',
            name: 'RightCode OpenAI',
            env: [],
            options: { baseURL: 'https://www.right.codes/codex/v1' },
            models: {},
          },
        ],
        default: {},
        connected: ['rightcode-openai'],
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
          auth: {
            set: async () => ({ data: { ok: true } }),
          },
        },
      } as never)

      const tool = (hooks.tool as any).quota_summary
      await tool.execute({ period: 'day', toast: false }, { sessionID: 's1' })
      assert.equal(quotaCalls, 1)

      await hooks.event!({
        event: { type: 'message.updated', properties: { info: msg } },
      } as never)

      await tool.execute({ period: 'day', toast: false }, { sessionID: 's1' })
      assert.equal(quotaCalls, 2)
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
      ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
    }
  })

  it('uses compact single-line titles for cli/web sessions without TUI selection', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    await fs.writeFile(
      path.join(projectDir, 'quota-sidebar.config.json'),
      JSON.stringify(
        {
          sidebar: { multilineTitle: true, showCost: false, showQuota: false },
        },
        null,
        2,
      ),
    )
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    const previousClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome
    process.env.OPENCODE_CLIENT = 'cli'
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
            list: async () => ({
              data: { all: [], default: {}, connected: [] },
            }),
          },
        },
      } as never)

      await emitAssistantLifecycle(hooks, msg)

      await waitFor(() => updates.length > 0)

      assert.equal(title.includes('\n'), false)
      assert.match(title, /Cd7%|Cd 7%/)
      assert.doesNotMatch(title, /R1 I18\.9k O53|Est\$0\.02/)
    } finally {
      process.env.OPENCODE_CLIENT = previousClient
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('keeps shared titles compact when TUI switches between sessions', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    await fs.writeFile(
      path.join(projectDir, 'quota-sidebar.config.json'),
      JSON.stringify(
        {
          sidebar: { multilineTitle: true, showCost: false, showQuota: false },
        },
        null,
        2,
      ),
    )
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    const previousClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome
    process.env.OPENCODE_CLIENT = 'cli'
    try {
      const titles = {
        s1: 'Session One',
        s2: 'Session Two',
      }
      const updates: Array<{ id: 's1' | 's2'; title: string }> = []

      const messages = {
        s1: {
          id: 'm1',
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-5',
          sessionID: 's1',
          time: { created: Date.now() - 1000, completed: Date.now() - 900 },
          tokens: {
            input: 420,
            output: 84,
            reasoning: 0,
            cache: { read: 21, write: 0 },
          },
          cost: 0.01,
        },
        s2: {
          id: 'm2',
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-5',
          sessionID: 's2',
          time: { created: Date.now() - 1000, completed: Date.now() - 900 },
          tokens: {
            input: 520,
            output: 94,
            reasoning: 0,
            cache: { read: 31, write: 0 },
          },
          cost: 0.01,
        },
      }

      const hooks = await QuotaSidebarPlugin({
        directory: projectDir,
        worktree: projectDir,
        client: {
          session: {
            get: async (args: { path: { id: 's1' | 's2' } }) => ({
              data: {
                id: args.path.id,
                title: titles[args.path.id],
                time: { created: Date.now() - 10_000 },
              },
            }),
            update: async (args: {
              path: { id: 's1' | 's2' }
              body: { title: string }
            }) => {
              titles[args.path.id] = args.body.title
              updates.push({ id: args.path.id, title: args.body.title })
              return { data: { ok: true } }
            },
            messages: async (args: { path: { id: 's1' | 's2' } }) => ({
              data: [{ info: messages[args.path.id] }],
            }),
            list: async () => ({ data: [{ id: 's1' }, { id: 's2' }] }),
          },
          tui: {
            showToast: async () => ({ data: { ok: true } }),
          },
          auth: {
            set: async () => ({ data: { ok: true } }),
          },
          provider: {
            list: async () => ({
              data: { all: [], default: {}, connected: [] },
            }),
          },
        },
      } as never)

      await hooks.event!({
        event: {
          type: 'tui.session.select',
          properties: { sessionID: 's1' },
        },
      } as never)
      await emitAssistantLifecycle(hooks, messages.s1)
      await waitFor(() => updates.length > 0)

      await hooks.event!({
        event: {
          type: 'tui.session.select',
          properties: { sessionID: 's2' },
        },
      } as never)
      await emitAssistantLifecycle(hooks, messages.s2)

      await waitFor(() => updates.length >= 2)

      assert.equal(titles.s1.includes('\n'), false)
      assert.equal(titles.s2.includes('\n'), false)
      assert.match(titles.s1, /Cd5%|Cd 5%/)
      assert.doesNotMatch(titles.s1, /R1 I420 O84/)
      assert.match(titles.s2, /Cd6%|Cd 6%/)
      assert.doesNotMatch(titles.s2, /R1 I520 O94/)
      assert.ok(updates.some((item) => item.id === 's1'))
      assert.ok(updates.some((item) => item.id === 's2'))
    } finally {
      process.env.OPENCODE_CLIENT = previousClient
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('renders compact single-line titles automatically on desktop', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    await fs.writeFile(
      path.join(projectDir, 'quota-sidebar.config.json'),
      JSON.stringify(
        {
          sidebar: { multilineTitle: true, showCost: false, showQuota: false },
        },
        null,
        2,
      ),
    )
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    const previousClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome
    process.env.OPENCODE_CLIENT = 'desktop'
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
            list: async () => ({
              data: { all: [], default: {}, connected: [] },
            }),
          },
        },
      } as never)

      await emitAssistantLifecycle(hooks, msg)

      await waitFor(() => updates.length > 0)

      assert.equal(title.includes('\n'), false)
      assert.match(title, /Cd7%|Cd 7%/)
      assert.doesNotMatch(title, /Requests 1|Cache Read 1\.5k/)
      assert.doesNotMatch(title, /R1 I18\.9k O53|Est\$0\.02/)
    } finally {
      process.env.OPENCODE_CLIENT = previousClient
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('does not re-promote an untracked partial decorated echo into a duplicated title block', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    await fs.writeFile(
      path.join(projectDir, 'quota-sidebar.config.json'),
      JSON.stringify(
        {
          sidebar: {
            titleMode: 'multiline',
            multilineTitle: true,
            showCost: false,
            showQuota: false,
          },
        },
        null,
        2,
      ),
    )
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome
    try {
      let title = 'Echoed Session\nCd 5%\nOAI unavailable'
      const updates: string[] = []

      const msg = {
        id: 'm-echo',
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5',
        sessionID: 's-echo',
        time: { created: Date.now() - 1000, completed: Date.now() - 900 },
        tokens: {
          input: 420,
          output: 84,
          reasoning: 0,
          cache: { read: 21, write: 0 },
        },
        cost: 0.01,
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
              data: {
                id: 's-echo',
                title,
                time: { created: Date.now() - 10_000 },
              },
            }),
            update: async (args: { body: { title: string } }) => {
              title = args.body.title
              updates.push(title)
              return { data: { ok: true } }
            },
            messages: async () => ({ data: [{ info: msg }] }),
            list: async () => ({ data: [] }),
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
        event: {
          type: 'session.updated',
          properties: {
            info: {
              id: 's-echo',
              title,
              time: { created: Date.now() - 10_000 },
            },
          },
        },
      } as never)

      await delay(350)
      assert.equal(updates.length, 0)
      assert.equal(title, 'Echoed Session\nCd 5%\nOAI unavailable')

      await emitAssistantLifecycle(hooks, msg)

      await waitFor(() => updates.length > 0)

      const latest = updates.at(-1) || ''
      assert.match(latest, /^Echoed Session\n\nR1 I420 O84/m)
      assert.match(latest, /\bR21\b/)
      assert.match(latest, /Cd 5%/)
      assert.equal((latest.match(/Echoed Session/g) || []).length, 1)
      assert.equal((latest.match(/Cd 5%/g) || []).length, 1)
      assert.doesNotMatch(latest, /OpenAI unavailable/)
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('self-heals a persisted polluted baseTitle before rendering the next decorated title', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    await fs.writeFile(
      path.join(dataHome, 'auth.json'),
      JSON.stringify(
        {
          'rightcode-openai': { type: 'api', key: 'rc-key' },
        },
        null,
        2,
      ),
    )
    await fs.writeFile(
      path.join(projectDir, 'quota-sidebar.config.json'),
      JSON.stringify(
        {
          sidebar: {
            titleMode: 'multiline',
            multilineTitle: true,
            showCost: true,
            showQuota: true,
          },
        },
        null,
        2,
      ),
    )
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome
    try {
      let title = [
        '交叉验证Phase 1完成度与文档更新需求',
        'Session',
        'RC-openai Daily $58.3/$90 Exp 22:18',
      ].join('\n')
      const updates: string[] = []
      const createdAt = Date.now() - 10_000
      const msg = {
        id: 'm-heal',
        role: 'assistant',
        providerID: 'rightcode-openai',
        modelID: 'gpt-5',
        sessionID: 's-heal',
        time: { created: Date.now() - 1000, completed: Date.now() - 900 },
        tokens: {
          input: 1_400,
          output: 144_800,
          reasoning: 0,
          cache: { read: 35_800_000, write: 0 },
        },
        cost: 0.01,
      }

      const providerListData = {
        all: [
          {
            id: 'rightcode-openai',
            name: 'RightCode OpenAI',
            env: [],
            options: { baseURL: 'https://www.right.codes/codex/v1' },
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
        connected: ['rightcode-openai'],
      }

      const originalFetch = globalThis.fetch
      ;(globalThis as unknown as { fetch: typeof fetch }).fetch = async (
        input,
      ) => {
        const url = String(input)
        if (url.includes('www.right.codes/account/summary')) {
          return new Response(
            JSON.stringify({
              balance: 248.4,
              subscriptions: [
                {
                  name: 'Codex Plan',
                  total_quota: 60,
                  remaining_quota: 58.3,
                  reset_today: true,
                  expired_at: new Date(
                    Date.now() + 2 * 24 * 60 * 60 * 1000,
                  ).toISOString(),
                  available_prefixes: ['/codex'],
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response('{}', { status: 404 })
      }

      const hooks = await QuotaSidebarPlugin({
        directory: projectDir,
        worktree: projectDir,
        client: {
          session: {
            get: async () => ({
              data: { id: 's-heal', title, time: { created: createdAt } },
            }),
            update: async (args: { body: { title: string } }) => {
              title = args.body.title
              updates.push(title)
              return { data: { ok: true } }
            },
            messages: async () => ({ data: [{ info: msg }] }),
            list: async () => ({ data: [{ id: 's-heal' }] }),
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

      try {
        await hooks.event!({
          event: {
            type: 'session.updated',
            properties: {
              info: {
                id: 's-heal',
                title,
                time: { created: createdAt },
              },
            },
          },
        } as never)

        await emitAssistantLifecycle(hooks, msg)

        await waitFor(() => updates.length > 0)

        const latest = updates.at(-1) || ''
        assert.equal(
          latest.split(/\r?\n/)[0],
          '交叉验证Phase 1完成度与文档更新需求',
        )
        assert.equal((latest.match(/^Session$/gm) || []).length, 0)
        assert.equal(
          (latest.match(/交叉验证Phase 1完成度与文档更新需求/g) || []).length,
          1,
        )
      } finally {
        ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
          originalFetch
      }
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('auto-shows expiry toast at most once per session', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome
    const originalFetch = globalThis.fetch

    await fs.writeFile(
      path.join(dataHome, 'auth.json'),
      JSON.stringify(
        {
          'rightcode-openai': { type: 'api', key: 'rc-key' },
        },
        null,
        2,
      ),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = async (
      input,
    ) => {
      const url = String(input)
      if (url.includes('www.right.codes/account/summary')) {
        return new Response(
          JSON.stringify({
            balance: 248.4,
            subscriptions: [
              {
                name: 'Codex Plan',
                total_quota: 60,
                remaining_quota: 45,
                reset_today: true,
                expired_at: new Date(
                  Date.now() + 2 * 24 * 60 * 60 * 1000,
                ).toISOString(),
                available_prefixes: ['/codex'],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('{}', { status: 404 })
    }

    try {
      let title = 'Expiry Reminder Session'
      const toasts: string[] = []
      const session = {
        id: 's-expiry',
        title,
        time: { created: Date.now() - 10_000 },
      }
      const msg = {
        id: 'm-expiry',
        role: 'assistant',
        providerID: 'rightcode-openai',
        modelID: 'gpt-5',
        sessionID: 's-expiry',
        time: { created: Date.now() - 1000, completed: Date.now() - 900 },
        tokens: {
          input: 100,
          output: 20,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0.01,
      }

      const providerListData = {
        all: [
          {
            id: 'rightcode-openai',
            name: 'RightCode OpenAI',
            env: [],
            npm: [],
            options: { baseURL: 'https://www.right.codes/codex/v1' },
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
        connected: ['rightcode-openai'],
      }

      const hooks = await QuotaSidebarPlugin({
        directory: projectDir,
        worktree: projectDir,
        client: {
          session: {
            get: async () => ({ data: session }),
            update: async (args: { body: { title: string } }) => {
              title = args.body.title
              return { data: { ok: true } }
            },
            messages: async () => ({ data: [{ info: msg }] }),
            list: async () => ({ data: [{ id: session.id }] }),
          },
          tui: {
            showToast: async (args: { body: { message: string } }) => {
              toasts.push(args.body.message)
              return { data: { ok: true } }
            },
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
        event: { type: 'session.created', properties: { info: session } },
      } as never)

      await emitAssistantLifecycle(hooks, msg)

      await waitFor(() => toasts.some((item) => item.includes('Expiry Soon')))
      assert.equal(
        toasts.filter((item) => item.includes('Expiry Soon')).length,
        1,
      )
      assert.match(toasts[0] || '', /RC-openai Exp \d{2}-\d{2} \d{2}:\d{2}/)

      await emitAssistantLifecycle(hooks, msg)

      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(
        toasts.filter((item) => item.includes('Expiry Soon')).length,
        1,
      )
      void title
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
      ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
    }
  })

  it('works with current runtime-style client discovery when server auth env is present', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    await fs.writeFile(
      path.join(projectDir, 'quota-sidebar.config.json'),
      JSON.stringify(
        { sidebar: { titleMode: 'multiline', multilineTitle: true } },
        null,
        2,
      ),
    )

    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    const previousPassword = process.env.OPENCODE_SERVER_PASSWORD
    const previousUsername = process.env.OPENCODE_SERVER_USERNAME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome
    process.env.OPENCODE_SERVER_PASSWORD = 'test-password'
    process.env.OPENCODE_SERVER_USERNAME = 'tester'

    try {
      let title = 'Runtime-shaped session'
      const updates: string[] = []

      const msg = {
        id: 'm-runtime',
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5',
        sessionID: 's-runtime',
        time: { created: Date.now() - 1000, completed: Date.now() - 900 },
        tokens: {
          input: 420,
          output: 84,
          reasoning: 0,
          cache: { read: 21, write: 0 },
        },
        cost: 0.01,
      }

      const hooks = await QuotaSidebarPlugin({
        directory: projectDir,
        worktree: projectDir,
        client: {
          session: {
            get: async () => ({
              data: {
                id: 's-runtime',
                title,
                time: { created: Date.now() - 10_000 },
              },
            }),
            update: async (args: { body: { title: string } }) => {
              title = args.body.title
              updates.push(title)
              return { data: { ok: true } }
            },
            messages: async () => ({ data: [{ info: msg }] }),
            list: async () => ({ data: [{ id: 's-runtime' }] }),
          },
          tui: {
            showToast: async () => ({ data: { ok: true } }),
          },
          auth: {
            set: async () => ({ data: { ok: true } }),
          },
          config: {
            providers: async () => ({
              data: {
                providers: [
                  {
                    id: 'openai',
                    options: {},
                  },
                ],
              },
            }),
          },
        },
      } as never)

      await emitAssistantLifecycle(hooks, msg)

      await waitFor(() => updates.length > 0)

      assert.ok(updates.length > 0)
      assert.match(title, /R1 I420 O84/)
      assert.match(title, /Cd5%|Cd 5%/)
      assert.match(title, /OAI unavailable/)
      assert.doesNotMatch(title, /\u001b/)
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
      process.env.OPENCODE_SERVER_PASSWORD = previousPassword
      process.env.OPENCODE_SERVER_USERNAME = previousUsername
    }
  })

  it('includes descendant subagent usage and quota providers in parent summary without rewriting parent title', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    await fs.writeFile(
      path.join(projectDir, 'quota-sidebar.config.json'),
      JSON.stringify(
        { sidebar: { titleMode: 'multiline', multilineTitle: true } },
        null,
        2,
      ),
    )
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

      const tool = (hooks.tool as any).quota_summary
      const markdown = await tool.execute(
        { period: 'session', toast: false, includeChildren: true },
        { sessionID: 'p1' },
      )

      assert.match(markdown, /- Sessions: 2/)
      assert.match(markdown, /- Requests: 2/)
      assert.match(markdown, /Tokens: input 300, output 50/)
      assert.match(markdown, /OpenAI/)
      assert.match(markdown, /Copilot/)
      assert.equal(
        updates.some((item) => item.id === 'p1'),
        false,
      )
    } finally {
      ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('includes child long-context API cost in parent summary without rewriting parent title', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    await fs.writeFile(
      path.join(projectDir, 'quota-sidebar.config.json'),
      JSON.stringify(
        {
          sidebar: {
            titleMode: 'multiline',
            multilineTitle: true,
            showQuota: false,
          },
        },
        null,
        2,
      ),
    )
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome

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
          input: 100_000,
          output: 10_000,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0,
      }

      const childMessage = {
        id: 'm-child',
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5',
        sessionID: 'c1',
        time: { created: Date.now() - 2_000, completed: Date.now() - 1_900 },
        tokens: {
          input: 250_000,
          output: 15_000,
          reasoning: 5_000,
          cache: { read: 20_000, write: 0 },
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
                  context_over_200k: {
                    input: 3,
                    output: 6,
                    cache_read: 1.5,
                    cache_write: 0,
                  },
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

      const tool = (hooks.tool as any).quota_summary
      const markdown = await tool.execute(
        { period: 'session', toast: false, includeChildren: true },
        { sessionID: 'p1' },
      )

      assert.match(markdown, /- Sessions: 2/)
      assert.match(markdown, /350\.0k/)
      assert.match(markdown, /30\.0k/)
      assert.match(markdown, /5\.4%/)
      assert.match(markdown, /\$1\.02/)
      assert.equal(
        updates.some((item) => item.id === 'p1'),
        false,
      )
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })
})
