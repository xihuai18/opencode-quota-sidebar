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

async function waitFor(check: () => boolean, timeoutMs = 6000) {
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

describe('subagent aggregation integration', () => {
  it('does not propagate child usage into parent when includeChildren=false', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome

    await fs.writeFile(
      path.join(projectDir, 'quota-sidebar.config.json'),
      JSON.stringify(
        { sidebar: { includeChildren: false, wrapQuotaLines: true } },
        null,
        2,
      ),
    )

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
                cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
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
                cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
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

      await waitFor(() => updates.some((u) => u.id === 'c1'))

      assert.ok(updates.some((u) => u.id === 'c1'))
      assert.ok(!updates.some((u) => u.id === 'p1'))
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('quota_summary can override includeChildren per call', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome

    // Disable quota lookups for this test (usage-only assertions).
    await fs.writeFile(
      path.join(projectDir, 'quota-sidebar.config.json'),
      JSON.stringify(
        {
          sidebar: { includeChildren: true, wrapQuotaLines: true },
          quota: {
            includeOpenAI: false,
            includeCopilot: false,
            includeAnthropic: false,
          },
        },
        null,
        2,
      ),
    )

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
                cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
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
                cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
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
            update: async () => ({ data: { ok: true } }),
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

      const tool = (hooks.tool as any).quota_summary
      assert.ok(tool)

      const mdNoChildren = await tool.execute(
        { period: 'session', toast: false, includeChildren: false },
        { sessionID: 'p1' },
      )
      assert.match(mdNoChildren, /- Sessions: 1/)
      assert.match(mdNoChildren, /Tokens: input 100, output 20/)

      const mdWithChildren = await tool.execute(
        { period: 'session', toast: false, includeChildren: true },
        { sessionID: 'p1' },
      )
      assert.match(mdWithChildren, /- Sessions: 2/)
      assert.match(mdWithChildren, /Tokens: input 300, output 50/)
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('includes grandchild session usage in the root parent aggregation', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome

    await fs.writeFile(
      path.join(projectDir, 'quota-sidebar.config.json'),
      JSON.stringify(
        {
          sidebar: { includeChildren: true, showQuota: false, wrapQuotaLines: true },
          quota: {
            includeOpenAI: false,
            includeCopilot: false,
            includeAnthropic: false,
          },
        },
        null,
        2,
      ),
    )

    try {
      const sessions = {
        p1: {
          id: 'p1',
          title: 'Parent',
          parentID: undefined as string | undefined,
          time: { created: Date.now() - 30_000 },
        },
        c1: {
          id: 'c1',
          title: 'Child',
          parentID: 'p1',
          time: { created: Date.now() - 20_000 },
        },
        g1: {
          id: 'g1',
          title: 'Grandchild',
          parentID: 'c1',
          time: { created: Date.now() - 10_000 },
        },
      }

      const updates: Array<{ id: string; title: string }> = []

      const parentMessage = {
        id: 'm-p1',
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5',
        sessionID: 'p1',
        time: { created: Date.now() - 9_000, completed: Date.now() - 8_900 },
        tokens: {
          input: 1,
          output: 1,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0,
      }

      const childMessage = {
        id: 'm-c1',
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5',
        sessionID: 'c1',
        time: { created: Date.now() - 4_000, completed: Date.now() - 3_900 },
        tokens: {
          input: 10,
          output: 2,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0,
      }

      const grandchildMessage = {
        id: 'm-g1',
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5',
        sessionID: 'g1',
        time: { created: Date.now() - 2_000, completed: Date.now() - 1_900 },
        tokens: {
          input: 100,
          output: 3,
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
                cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
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
              data: sessions[args.path.id as 'p1' | 'c1' | 'g1'],
            }),
            update: async (args: {
              path: { id: string }
              body: { title: string }
            }) => {
              const id = args.path.id as 'p1' | 'c1' | 'g1'
              sessions[id].title = args.body.title
              updates.push({ id, title: args.body.title })
              return { data: { ok: true } }
            },
            messages: async (args: { path: { id: string } }) => {
              const id = args.path.id
              if (id === 'p1') return { data: [{ info: parentMessage }] }
              if (id === 'c1') return { data: [{ info: childMessage }] }
              if (id === 'g1') return { data: [{ info: grandchildMessage }] }
              return { data: [] }
            },
            children: async (args: { path: { id: string } }) => {
              const id = args.path.id
              if (id === 'p1') return { data: [sessions.c1] }
              if (id === 'c1') return { data: [sessions.g1] }
              return { data: [] }
            },
            list: async () => ({
              data: [{ id: 'p1' }, { id: 'c1' }, { id: 'g1' }],
            }),
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
          type: 'message.updated',
          properties: { info: grandchildMessage },
        },
      } as never)

      await waitFor(() => updates.some((u) => u.id === 'p1'))

      const latestP1 = [...updates].reverse().find((u) => u.id === 'p1')
      assert.ok(latestP1)
      assert.match(latestP1!.title, /Input 111\s+Output 6/)
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('refreshes old and new parents when a child session is re-parented', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome

    // Disable quota lookups for this test (usage-only assertions).
    await fs.writeFile(
      path.join(projectDir, 'quota-sidebar.config.json'),
      JSON.stringify(
        {
          sidebar: { includeChildren: true, showQuota: false, wrapQuotaLines: true },
          quota: {
            includeOpenAI: false,
            includeCopilot: false,
            includeAnthropic: false,
          },
        },
        null,
        2,
      ),
    )

    try {
      const sessions = {
        p1: {
          id: 'p1',
          title: 'Parent1',
          parentID: undefined as string | undefined,
          time: { created: Date.now() - 30_000 },
        },
        p2: {
          id: 'p2',
          title: 'Parent2',
          parentID: undefined as string | undefined,
          time: { created: Date.now() - 30_000 },
        },
        c1: {
          id: 'c1',
          title: 'Child',
          parentID: 'p1',
          time: { created: Date.now() - 10_000 },
        },
      }

      const updates: Array<{ id: string; title: string }> = []

      const parent1Message = {
        id: 'm-p1',
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5',
        sessionID: 'p1',
        time: { created: Date.now() - 9_000, completed: Date.now() - 8_900 },
        tokens: {
          input: 10,
          output: 1,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0,
      }

      const parent2Message = {
        id: 'm-p2',
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5',
        sessionID: 'p2',
        time: { created: Date.now() - 9_000, completed: Date.now() - 8_900 },
        tokens: {
          input: 20,
          output: 2,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0,
      }

      const childMessage = {
        id: 'm-c1',
        role: 'assistant',
        providerID: 'github-copilot',
        modelID: 'gpt-4.1',
        sessionID: 'c1',
        time: { created: Date.now() - 2_000, completed: Date.now() - 1_900 },
        tokens: {
          input: 100,
          output: 10,
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
                cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
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
                cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
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
              data: sessions[args.path.id as 'p1' | 'p2' | 'c1'],
            }),
            update: async (args: {
              path: { id: string }
              body: { title: string }
            }) => {
              const id = args.path.id as 'p1' | 'p2' | 'c1'
              sessions[id].title = args.body.title
              updates.push({ id, title: args.body.title })
              return { data: { ok: true } }
            },
            messages: async (args: { path: { id: string } }) => {
              const id = args.path.id
              if (id === 'p1') return { data: [{ info: parent1Message }] }
              if (id === 'p2') return { data: [{ info: parent2Message }] }
              if (id === 'c1') return { data: [{ info: childMessage }] }
              return { data: [] }
            },
            children: async (args: { path: { id: string } }) => {
              const id = args.path.id
              const children = Object.values(sessions).filter(
                (s) => s.parentID === id,
              )
              return { data: children as any }
            },
            list: async () => ({
              data: [{ id: 'p1' }, { id: 'p2' }, { id: 'c1' }],
            }),
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

      // Initial child activity should aggregate into p1.
      await hooks.event!({
        event: { type: 'message.updated', properties: { info: childMessage } },
      } as never)

      await waitFor(() => updates.some((u) => u.id === 'p1'))

      const latestP1 = [...updates].reverse().find((u) => u.id === 'p1')
      assert.ok(latestP1)
      assert.match(latestP1!.title, /Input 110\s+Output 11/)

      // Re-parent c1 from p1 -> p2. Use decorated title echo to ensure the
      // parent refresh logic is not skipped by title echo handling.
      sessions.c1.parentID = 'p2'
      await hooks.event!({
        event: {
          type: 'session.updated',
          properties: { info: { ...sessions.c1, title: sessions.c1.title } },
        },
      } as never)

      await waitFor(() => updates.some((u) => u.id === 'p2'))

      const latestP2 = [...updates].reverse().find((u) => u.id === 'p2')
      assert.ok(latestP2)
      assert.match(latestP2!.title, /Input 120\s+Output 12/)

      const latestP1After = [...updates].reverse().find((u) => u.id === 'p1')
      assert.ok(latestP1After)
      // After re-parent, p1 should no longer include child usage.
      assert.match(latestP1After!.title, /Input 10\s+Output 1/)
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })

  it('recomputes parent aggregation after child message.removed', async () => {
    const dataHome = await makeTempDir()
    const projectDir = await makeTempDir()
    const previousDataHome = process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.OPENCODE_QUOTA_DATA_HOME = dataHome

    await fs.writeFile(
      path.join(projectDir, 'quota-sidebar.config.json'),
      JSON.stringify(
        {
          sidebar: { includeChildren: true, showQuota: false, wrapQuotaLines: true },
          quota: {
            includeOpenAI: false,
            includeCopilot: false,
            includeAnthropic: false,
          },
        },
        null,
        2,
      ),
    )

    try {
      const sessions = {
        p1: {
          id: 'p1',
          title: 'Parent',
          parentID: undefined as string | undefined,
          time: { created: Date.now() - 30_000 },
        },
        c1: {
          id: 'c1',
          title: 'Child',
          parentID: 'p1',
          time: { created: Date.now() - 10_000 },
        },
      }

      const updates: Array<{ id: string; title: string }> = []

      const parentMessage = {
        id: 'm-p1',
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5',
        sessionID: 'p1',
        time: { created: Date.now() - 9_000, completed: Date.now() - 8_900 },
        tokens: {
          input: 10,
          output: 1,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0,
      }

      const childMessage = {
        id: 'm-c1',
        role: 'assistant',
        providerID: 'github-copilot',
        modelID: 'gpt-4.1',
        sessionID: 'c1',
        time: { created: Date.now() - 2_000, completed: Date.now() - 1_900 },
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0,
      }

      let childEntries: Array<{ info: typeof childMessage }> = [
        { info: childMessage },
      ]

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
                cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
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
                cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
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
              if (id === 'c1') return { data: childEntries }
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

      await waitFor(() =>
        updates.some(
          (u) => u.id === 'p1' && /Input 110\s+Output 11\b/.test(u.title),
        ),
      )

      childEntries = []
      await hooks.event!({
        event: { type: 'message.removed', properties: { sessionID: 'c1' } },
      } as never)

      await waitFor(() =>
        updates.some(
          (u) => u.id === 'p1' && /Input 10\s+Output 1\b/.test(u.title),
        ),
      )

      const latestP1 = [...updates].reverse().find((u) => u.id === 'p1')
      assert.ok(latestP1)
      assert.match(latestP1!.title, /Input 10\s+Output 1\b/)
    } finally {
      process.env.OPENCODE_QUOTA_DATA_HOME = previousDataHome
    }
  })
})
