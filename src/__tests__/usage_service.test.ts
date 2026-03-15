import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createUsageService } from '../usage_service.js'
import { USAGE_BILLING_CACHE_VERSION } from '../usage.js'
import type { QuotaSidebarConfig, QuotaSidebarState } from '../types.js'

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeConfig(): QuotaSidebarConfig {
  return {
    sidebar: {
      enabled: true,
      width: 36,
      showCost: true,
      showQuota: true,
      wrapQuotaLines: true,
      includeChildren: false,
      childrenMaxDepth: 6,
      childrenMaxSessions: 128,
      childrenConcurrency: 5,
    },
    quota: {
      refreshMs: 300_000,
      includeOpenAI: true,
      includeCopilot: true,
      includeAnthropic: true,
      providers: {},
      refreshAccessToken: false,
      requestTimeoutMs: 8_000,
    },
    toast: { durationMs: 12_000 },
    retentionDays: 730,
  }
}

function makeState(): QuotaSidebarState {
  return {
    version: 2,
    titleEnabled: true,
    sessionDateMap: {},
    sessions: {},
    quotaCache: {},
  }
}

function entry(sessionID: string, messageID: string, input: number) {
  const now = Date.now()
  return {
    info: {
      id: messageID,
      sessionID,
      role: 'assistant',
      providerID: 'openai',
      modelID: 'gpt-5',
      time: { created: now - 10, completed: now },
      tokens: {
        input,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
    },
  }
}

describe('usage service', () => {
  it('keeps session measured cost root-only while apiCost includes children', async () => {
    const state = makeState()
    const config = makeConfig()
    config.sidebar.includeChildren = true

    state.sessions.root = {
      createdAt: Date.now() - 2_000,
      baseTitle: 'Root',
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: undefined,
      cursor: undefined,
    }
    state.sessions.child = {
      createdAt: Date.now() - 1_000,
      baseTitle: 'Child',
      lastAppliedTitle: undefined,
      parentID: 'root',
      usage: undefined,
      cursor: undefined,
    }
    state.sessionDateMap.root = '2026-01-01'
    state.sessionDateMap.child = '2026-01-01'

    const now = Date.now()
    const service = createUsageService({
      state,
      config,
      statePath: 'ignored',
      client: {
        session: {
          messages: async (args: { path: { id: string } }) => {
            if (args.path.id === 'root') {
              return {
                data: [
                  {
                    info: {
                      id: 'm-root',
                      sessionID: 'root',
                      role: 'assistant',
                      providerID: 'openai',
                      modelID: 'gpt-5',
                      time: { created: now - 100, completed: now - 90 },
                      tokens: {
                        input: 100,
                        output: 20,
                        reasoning: 0,
                        cache: { read: 0, write: 0 },
                      },
                      cost: 1.25,
                    },
                  },
                ],
              }
            }
            return {
              data: [
                {
                  info: {
                    id: 'm-child',
                    sessionID: 'child',
                    role: 'assistant',
                    providerID: 'openai',
                    modelID: 'gpt-5',
                    time: { created: now - 50, completed: now - 40 },
                    tokens: {
                      input: 50,
                      output: 10,
                      reasoning: 5,
                      cache: { read: 0, write: 0 },
                    },
                    cost: 9.99,
                  },
                },
              ],
            }
          },
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: 'openai',
                  models: {
                    'gpt-5': {
                      id: 'gpt-5',
                      cost: {
                        input: 0.0005,
                        output: 0.001,
                        cache_read: 0,
                        cache_write: 0,
                      },
                    },
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: 'ignored',
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => ['child'],
      },
    })

    const usage = await service.summarizeSessionUsageForDisplay('root', true)

    assert.equal(usage.input, 150)
    assert.equal(usage.output, 35)
    assert.equal(usage.total, 185)
    assert.equal(usage.sessionCount, 2)
    assert.equal(usage.cost, 1.25)
    assert.equal(usage.providers.openai.cost, 1.25)
    assert.ok(Math.abs(usage.apiCost - 0.11) < 1e-9)
    assert.ok(Math.abs(usage.providers.openai.apiCost - 0.11) < 1e-9)
  })

  it('forces a full rescan when cached billing version is stale', async () => {
    const state = makeState()
    const config = makeConfig()
    const sessionID = 's1'
    const completedAt = Date.now() - 100

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: 'Session',
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: {
        billingVersion: 0,
        input: 999,
        output: 999,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 1998,
        cost: 99,
        apiCost: 0,
        assistantMessages: 1,
        providers: {
          openai: {
            input: 999,
            output: 999,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 1998,
            cost: 99,
            apiCost: 0,
            assistantMessages: 1,
          },
        },
      },
      cursor: {
        lastMessageId: 'm1',
        lastMessageTime: completedAt,
        lastMessageIdsAtTime: ['m1'],
      },
    }
    state.sessionDateMap[sessionID] = '2026-01-01'

    const service = createUsageService({
      state,
      config,
      statePath: 'ignored',
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: {
                  id: 'm1',
                  sessionID,
                  role: 'assistant',
                  providerID: 'openai',
                  modelID: 'gpt-5',
                  time: { created: completedAt - 10, completed: completedAt },
                  tokens: {
                    input: 10,
                    output: 5,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                  cost: 0.2,
                },
              },
            ],
          }),
        },
      } as any,
      directory: 'ignored',
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    })

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    )

    assert.equal(usage.input, 10)
    assert.equal(usage.output, 5)
    assert.equal(usage.cost, 0.2)
    assert.equal(
      state.sessions[sessionID].usage?.billingVersion,
      USAGE_BILLING_CACHE_VERSION,
    )
  })

  it('does not reuse an in-flight computation after session becomes dirty', async () => {
    const state = makeState()
    const config = makeConfig()
    const sessionID = 's1'
    const createdAt = Date.now() - 1000
    state.sessions[sessionID] = {
      createdAt,
      baseTitle: 'Session',
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: undefined,
      cursor: undefined,
    }
    state.sessionDateMap[sessionID] = '2026-01-01'

    let calls = 0
    let unblockFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => {
      unblockFirst = resolve
    })

    const service = createUsageService({
      state,
      config,
      statePath: 'ignored',
      client: {
        session: {
          messages: async () => {
            calls++
            if (calls === 1) {
              await firstBlocked
              return { data: [entry(sessionID, 'm1', 10)] }
            }
            return { data: [entry(sessionID, 'm2', 20)] }
          },
        },
      } as any,
      directory: 'ignored',
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    })

    const p1 = service.summarizeSessionUsageForDisplay(sessionID, false)
    await delay(10)
    assert.equal(calls, 1)

    service.markSessionDirty(sessionID)
    const u2 = await service.summarizeSessionUsageForDisplay(sessionID, false)
    assert.equal(u2.input, 20)

    unblockFirst?.()
    await p1
  })

  it('doubles apiCost for priority-tier GPT messages from part metadata', async () => {
    const state = makeState()
    const config = makeConfig()
    const sessionID = 's-priority'
    const now = Date.now()

    state.sessions[sessionID] = {
      createdAt: now - 1_000,
      baseTitle: 'Priority',
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: undefined,
      cursor: undefined,
    }
    state.sessionDateMap[sessionID] = '2026-01-01'

    const service = createUsageService({
      state,
      config,
      statePath: 'ignored',
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: {
                  id: 'm-priority',
                  sessionID,
                  role: 'assistant',
                  providerID: 'openai',
                  modelID: 'gpt-5',
                  time: { created: now - 100, completed: now - 90 },
                  tokens: {
                    input: 100,
                    output: 20,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                  cost: 0,
                },
                parts: [
                  {
                    id: 'prt-1',
                    sessionID,
                    messageID: 'm-priority',
                    type: 'text',
                    text: 'ok',
                    metadata: {
                      openai: {
                        serviceTier: 'priority',
                      },
                    },
                  },
                ],
              },
            ],
          }),
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: 'openai',
                  models: {
                    'gpt-5': {
                      id: 'gpt-5',
                      cost: {
                        input: 0.0005,
                        output: 0.001,
                        cache_read: 0,
                        cache_write: 0,
                      },
                    },
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: 'ignored',
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    })

    const usage = await service.summarizeSessionUsageForDisplay(sessionID, false)

    assert.ok(Math.abs(usage.apiCost - 0.14) < 1e-12)
    assert.ok(Math.abs(usage.providers.openai.apiCost - 0.14) < 1e-12)
  })
})
