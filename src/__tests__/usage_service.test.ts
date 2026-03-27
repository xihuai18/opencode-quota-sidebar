import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createUsageService } from '../usage_service.js'
import {
  USAGE_BILLING_CACHE_VERSION,
  getCacheCoverageMetrics,
} from '../usage.js'
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
    deletedSessionDateMap: {},
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
                        cache: { read: 50, write: 0 },
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
                      cache: { read: 25, write: 25 },
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
                        cache_read: 0.00025,
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
    assert.equal(usage.total, 285)
    assert.equal(usage.sessionCount, 2)
    assert.equal(usage.cost, 1.25)
    assert.equal(usage.providers.openai.cost, 1.25)
    assert.ok(Math.abs(usage.apiCost - 0.12875) < 1e-9)
    assert.ok(Math.abs(usage.providers.openai.apiCost - 0.12875) < 1e-9)

    const metrics = getCacheCoverageMetrics(usage)
    assert.ok(Math.abs((metrics.cachedRatio || 0) - 0.3333333333333333) < 1e-9)
  })

  it('schedules save for refreshed root usage even when includeChildren has no descendants', async () => {
    const state = makeState()
    const config = makeConfig()
    config.sidebar.includeChildren = true
    const sessionID = 'solo'

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1_000,
      baseTitle: 'Solo',
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: undefined,
      cursor: undefined,
    }
    state.sessionDateMap[sessionID] = '2026-01-01'

    let saveCalls = 0
    const service = createUsageService({
      state,
      config,
      statePath: 'ignored',
      client: {
        session: {
          messages: async () => ({ data: [entry(sessionID, 'm1', 10)] }),
        },
        provider: {
          list: async () => ({ data: { all: [] } }),
        },
      } as any,
      directory: 'ignored',
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {
          saveCalls++
        },
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    })

    const usage = await service.summarizeSessionUsageForDisplay(sessionID, true)

    assert.equal(usage.input, 10)
    assert.equal(saveCalls, 1)
    assert.ok(state.sessions[sessionID].usage)
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

  it('prefers explicit read-only providers over claude model heuristic', async () => {
    const state = makeState()
    const config = makeConfig()
    const sessionID = 's1'
    const completedAt = Date.now() - 100

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: 'Session',
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
                  id: 'm1',
                  sessionID,
                  role: 'assistant',
                  providerID: 'openrouter',
                  modelID: 'claude-3.7-sonnet',
                  time: { created: completedAt - 10, completed: completedAt },
                  tokens: {
                    input: 100,
                    output: 10,
                    reasoning: 0,
                    cache: { read: 50, write: 0 },
                  },
                  cost: 0.2,
                },
              },
            ],
          }),
        },
        provider: {
          list: async () => ({ data: { all: [] } }),
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
    const metrics = getCacheCoverageMetrics(usage)

    assert.equal(metrics.cachedRatio, 50 / 150)
  })

  it('recomputes stale-version cached usage when apiCost was previously zero', async () => {
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
        billingVersion: USAGE_BILLING_CACHE_VERSION - 1,
        input: 100,
        output: 20,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 120,
        cost: 0,
        apiCost: 0,
        assistantMessages: 1,
        providers: {
          openai: {
            input: 100,
            output: 20,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 120,
            cost: 0,
            apiCost: 0,
            assistantMessages: 1,
          },
        },
      },
      cursor: {
        lastMessageId: 'old',
        lastMessageTime: completedAt,
        lastMessageIdsAtTime: ['old'],
      },
    }
    state.sessionDateMap[sessionID] = '2026-01-01'

    let messageCalls = 0
    const service = createUsageService({
      state,
      config,
      statePath: 'ignored',
      client: {
        session: {
          messages: async () => {
            messageCalls++
            return {
              data: [
                {
                  info: {
                    id: 'old',
                    sessionID,
                    role: 'assistant',
                    providerID: 'openai',
                    modelID: 'gpt-5',
                    time: { created: completedAt - 10, completed: completedAt },
                    tokens: {
                      input: 100,
                      output: 20,
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
                        cache_read: 0.00025,
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

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    )

    assert.equal(messageCalls, 1)
    assert.ok(usage.apiCost > 0)
    assert.ok(state.sessions[sessionID].usage?.apiCost)
  })

  it('matches anthropic api cost when message and pricing use different claude IDs', async () => {
    const state = makeState()
    const config = makeConfig()
    const sessionID = 'anthropic-session'
    const completedAt = Date.now() - 100

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: 'Anthropic Session',
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
                  id: 'm-anthropic',
                  sessionID,
                  role: 'assistant',
                  providerID: 'anthropic',
                  modelID: 'claude-3.7-sonnet',
                  time: { created: completedAt - 10, completed: completedAt },
                  tokens: {
                    input: 100_000,
                    output: 20_000,
                    reasoning: 5_000,
                    cache: { read: 50_000, write: 10_000 },
                  },
                  cost: 0,
                },
              },
            ],
          }),
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: 'anthropic',
                  models: {
                    'claude-3-7-sonnet-20250219': {
                      id: 'claude-3-7-sonnet-20250219',
                      cost: {
                        input: 3,
                        output: 15,
                        cache_read: 0.3,
                        cache_write: 3.75,
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

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    )

    assert.equal(usage.providers.anthropic?.assistantMessages, 1)
    assert.ok(Math.abs(usage.apiCost - 0.7275) < 1e-9)
    assert.ok(
      Math.abs((usage.providers.anthropic?.apiCost || 0) - 0.7275) < 1e-9,
    )
  })

  it('matches current opencode anthropic names with prefix and thinking suffix', async () => {
    const state = makeState()
    const config = makeConfig()
    const sessionID = 'anthropic-current'
    const completedAt = Date.now() - 100

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: 'Anthropic Current',
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
                  id: 'm-anthropic-current',
                  sessionID,
                  role: 'assistant',
                  providerID: 'anthropic',
                  modelID: 'anthropic/claude-sonnet-4-5-20250929-thinking',
                  time: { created: completedAt - 10, completed: completedAt },
                  tokens: {
                    input: 100_000,
                    output: 20_000,
                    reasoning: 5_000,
                    cache: { read: 50_000, write: 10_000 },
                  },
                  cost: 0,
                },
              },
            ],
          }),
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: 'anthropic',
                  models: {
                    'claude-sonnet-4-5': {
                      id: 'claude-sonnet-4-5',
                      cost: {
                        input: 3,
                        output: 15,
                        cache_read: 0.3,
                        cache_write: 3.75,
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

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    )

    assert.equal(usage.providers.anthropic?.assistantMessages, 1)
    assert.ok(Math.abs(usage.apiCost - 0.7275) < 1e-9)
    assert.ok(
      Math.abs((usage.providers.anthropic?.apiCost || 0) - 0.7275) < 1e-9,
    )
  })

  it('matches current opencode anthropic vertex and bedrock style IDs', async () => {
    const state = makeState()
    const config = makeConfig()
    const sessionID = 'anthropic-platforms'
    const completedAt = Date.now() - 100

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: 'Anthropic Platforms',
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
                  id: 'm-vertex',
                  sessionID,
                  role: 'assistant',
                  providerID: 'anthropic',
                  modelID: 'claude-sonnet-4-5@20250929',
                  time: {
                    created: completedAt - 20,
                    completed: completedAt - 10,
                  },
                  tokens: {
                    input: 100_000,
                    output: 20_000,
                    reasoning: 5_000,
                    cache: { read: 50_000, write: 10_000 },
                  },
                  cost: 0,
                },
              },
              {
                info: {
                  id: 'm-bedrock',
                  sessionID,
                  role: 'assistant',
                  providerID: 'anthropic',
                  modelID: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
                  time: { created: completedAt - 9, completed: completedAt },
                  tokens: {
                    input: 100_000,
                    output: 20_000,
                    reasoning: 5_000,
                    cache: { read: 50_000, write: 10_000 },
                  },
                  cost: 0,
                },
              },
            ],
          }),
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: 'anthropic',
                  models: {
                    'claude-sonnet-4-5': {
                      id: 'claude-sonnet-4-5',
                      cost: {
                        input: 3,
                        output: 15,
                        cache_read: 0.3,
                        cache_write: 3.75,
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

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    )

    assert.equal(usage.providers.anthropic?.assistantMessages, 2)
    assert.ok(Math.abs(usage.apiCost - 1.455) < 1e-9)
    assert.ok(
      Math.abs((usage.providers.anthropic?.apiCost || 0) - 1.455) < 1e-9,
    )
  })

  it('maps kimi-for-coding k2p5 usage to moonshotai-cn kimi-k2.5 pricing', async () => {
    const state = makeState()
    const config = makeConfig()
    const sessionID = 'kimi-session'
    const completedAt = Date.now() - 100

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: 'Kimi Session',
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
                  id: 'm-kimi',
                  sessionID,
                  role: 'assistant',
                  providerID: 'kimi-for-coding',
                  modelID: 'k2p5',
                  time: { created: completedAt - 10, completed: completedAt },
                  tokens: {
                    input: 100_000,
                    output: 20_000,
                    reasoning: 5_000,
                    cache: { read: 50_000, write: 0 },
                  },
                  cost: 0,
                },
              },
            ],
          }),
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: 'moonshotai-cn',
                  models: {
                    'kimi-k2.5': {
                      id: 'kimi-k2.5',
                      cost: {
                        input: 0.6,
                        output: 3,
                        cache_read: 0.1,
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

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    )
    const kimiUsage = usage.providers['kimi-for-coding']

    assert.ok(kimiUsage)
    assert.equal(usage.cost, 0)
    assert.equal(kimiUsage.cost, 0)
    assert.ok(Math.abs(usage.apiCost - 0.14) < 1e-9)
    assert.ok(Math.abs(kimiUsage.apiCost - 0.14) < 1e-9)

    const metrics = getCacheCoverageMetrics(usage)
    assert.equal(metrics.cachedRatio, 1 / 3)
  })

  it('recomputes stale kimi-for-coding usage when pricing is available via alias', async () => {
    const state = makeState()
    const config = makeConfig()
    const sessionID = 'kimi-stale'
    const completedAt = Date.now() - 100

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: 'Kimi stale',
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: {
        billingVersion: USAGE_BILLING_CACHE_VERSION - 1,
        input: 100_000,
        output: 25_000,
        reasoning: 0,
        cacheRead: 50_000,
        cacheWrite: 0,
        total: 175_000,
        cost: 0,
        apiCost: 0,
        assistantMessages: 1,
        providers: {
          'kimi-for-coding': {
            input: 100_000,
            output: 25_000,
            reasoning: 0,
            cacheRead: 50_000,
            cacheWrite: 0,
            total: 175_000,
            cost: 0,
            apiCost: 0,
            assistantMessages: 1,
          },
        },
      },
      cursor: {
        lastMessageId: 'old-kimi',
        lastMessageTime: completedAt,
        lastMessageIdsAtTime: ['old-kimi'],
      },
    }
    state.sessionDateMap[sessionID] = '2026-01-01'

    let messageCalls = 0
    const service = createUsageService({
      state,
      config,
      statePath: 'ignored',
      client: {
        session: {
          messages: async () => {
            messageCalls++
            return {
              data: [
                {
                  info: {
                    id: 'old-kimi',
                    sessionID,
                    role: 'assistant',
                    providerID: 'kimi-for-coding',
                    modelID: 'k2p5',
                    time: { created: completedAt - 10, completed: completedAt },
                    tokens: {
                      input: 100_000,
                      output: 20_000,
                      reasoning: 5_000,
                      cache: { read: 50_000, write: 0 },
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
            data: {
              all: [
                {
                  id: 'moonshotai-cn',
                  models: {
                    'kimi-k2.5': {
                      id: 'kimi-k2.5',
                      cost: {
                        input: 0.6,
                        output: 3,
                        cache_read: 0.1,
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

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    )

    assert.equal(messageCalls, 1)
    assert.ok(Math.abs(usage.apiCost - 0.14) < 1e-9)
    assert.ok(
      Math.abs(usage.providers['kimi-for-coding'].apiCost - 0.14) < 1e-9,
    )
  })

  it('fails session-only tool summary when messages cannot load and no cache exists', async () => {
    const state = makeState()
    const config = makeConfig()
    const sessionID = 's1'

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1_000,
      baseTitle: 'Session',
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
          messages: async () => {
            throw new Error('load failed')
          },
        },
        provider: {
          list: async () => ({ data: { all: [] } }),
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

    await assert.rejects(
      service.summarizeForTool('session', sessionID, false),
      /session usage unavailable: failed to load messages for s1/,
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
})
