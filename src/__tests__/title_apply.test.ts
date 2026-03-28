import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createTitleApplicator } from '../title_apply.js'
import { defaultState, dateKeyFromTimestamp } from '../storage.js'
import type { QuotaSidebarConfig, SessionState } from '../types.js'
import type { UsageSummary } from '../usage.js'

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
      refreshAccessToken: false,
      requestTimeoutMs: 8_000,
    },
    toast: { durationMs: 12_000 },
    retentionDays: 730,
  }
}

function makeUsage(): UsageSummary {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
    apiCost: 0,
    assistantMessages: 0,
    sessionCount: 1,
    providers: {},
  }
}

function makeCompactUsage(): UsageSummary {
  return {
    ...makeUsage(),
    assistantMessages: 3,
    providers: {
      openai: {
        providerID: 'openai',
        input: 10,
        output: 20,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 30,
        cost: 0,
        apiCost: 0,
        assistantMessages: 2,
      },
      anthropic: {
        providerID: 'anthropic',
        input: 5,
        output: 10,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 15,
        cost: 0,
        apiCost: 0,
        assistantMessages: 1,
      },
    },
    recentProviders: [
      { providerID: 'openai', completedAt: Date.now() - 1_000 },
    ],
  }
}

describe('title apply', () => {
  it('keeps lastAppliedTitle in sync when server normalizes decorated titles', async () => {
    const config = makeConfig()
    const state = defaultState()
    state.titleEnabled = true

    const createdAt = Date.now()
    const sessionID = 's1'
    const dateKey = dateKeyFromTimestamp(createdAt)

    const applied = `Session\n\nInput 10  Output 20`
    const normalized = `Session\n\nInput 10 Output 20`

    state.sessions[sessionID] = {
      createdAt,
      baseTitle: 'Session',
      lastAppliedTitle: applied,
    }
    state.sessionDateMap[sessionID] = dateKey

    const ensureSessionState = (
      id: string,
      title: string,
      created: number,
      _parentID?: string | null,
    ): SessionState => {
      const existing = state.sessions[id]
      if (existing) return existing
      const createdState: SessionState = {
        createdAt: created,
        baseTitle: title,
        lastAppliedTitle: undefined,
      }
      state.sessions[id] = createdState
      state.sessionDateMap[id] = dateKeyFromTimestamp(created)
      return createdState
    }

    const applicator = createTitleApplicator({
      state,
      config,
      directory: '/tmp',
      client: {
        session: {
          get: async () =>
            ({
              data: {
                id: sessionID,
                title: normalized,
                time: { created: createdAt },
                parentID: undefined,
              },
            }) as any,
          update: async () => {
            throw new Error('unexpected session.update')
          },
          list: async () => ({ data: [] }) as any,
        },
      } as any,
      ensureSessionState,
      markDirty: () => {},
      scheduleSave: () => {},
      renderSidebarTitle: () => normalized,
      getQuotaSnapshots: async () => [],
      summarizeSessionUsageForDisplay: async () => makeUsage(),
      scheduleParentRefreshIfSafe: () => {},
      restoreConcurrency: 1,
    })

    await applicator.applyTitle(sessionID)
    assert.equal(state.sessions[sessionID].lastAppliedTitle, normalized)
  })

  it('marks day chunk dirty when lastAppliedTitle changes but no update is needed', async () => {
    const config = makeConfig()
    const state = defaultState()
    state.titleEnabled = true

    const createdAt = Date.now()
    const sessionID = 's1'
    const dateKey = dateKeyFromTimestamp(createdAt)

    const applied = `Session\n\nInput 10  Output 20`
    const normalized = `Session\n\nInput 10 Output 20`

    state.sessions[sessionID] = {
      createdAt,
      baseTitle: 'Session',
      lastAppliedTitle: applied,
    }
    state.sessionDateMap[sessionID] = dateKey

    let dirtyKey: string | undefined

    const applicator = createTitleApplicator({
      state,
      config,
      directory: '/tmp',
      client: {
        session: {
          get: async () =>
            ({
              data: {
                id: sessionID,
                title: normalized,
                time: { created: createdAt },
                parentID: undefined,
              },
            }) as any,
          update: async () => {
            throw new Error('unexpected session.update')
          },
          list: async () => ({ data: [] }) as any,
        },
      } as any,
      ensureSessionState: (_id, _title, _created) => state.sessions[sessionID],
      markDirty: (key) => {
        dirtyKey = key
      },
      scheduleSave: () => {},
      renderSidebarTitle: () => normalized,
      getQuotaSnapshots: async () => [],
      summarizeSessionUsageForDisplay: async () => makeUsage(),
      scheduleParentRefreshIfSafe: () => {},
      restoreConcurrency: 1,
    })

    await applicator.applyTitle(sessionID)
    assert.equal(state.sessions[sessionID].lastAppliedTitle, normalized)
    assert.equal(dirtyKey, dateKey)
  })

  it('uses compact-provider selection when title view is compact', async () => {
    const config = makeConfig()
    const state = defaultState()
    state.titleEnabled = true

    const createdAt = Date.now()
    const sessionID = 's1'
    const dateKey = dateKeyFromTimestamp(createdAt)

    state.sessions[sessionID] = {
      createdAt,
      baseTitle: 'Session',
      lastAppliedTitle: undefined,
    }
    state.sessionDateMap[sessionID] = dateKey

    let seen: string[] = []

    const applicator = createTitleApplicator({
      state,
      config,
      directory: '/tmp',
      client: {
        session: {
          get: async () =>
            ({
              data: {
                id: sessionID,
                title: 'Session',
                time: { created: createdAt },
                parentID: undefined,
              },
            }) as any,
          update: async () => ({ data: { ok: true } }) as any,
          list: async () => ({ data: [] }) as any,
        },
      } as any,
      ensureSessionState: (_id, _title, _created) => state.sessions[sessionID],
      markDirty: () => {},
      scheduleSave: () => {},
      renderSidebarTitle: () => 'Session | Cd0%',
      getTitleView: () => 'compact',
      getQuotaSnapshots: async (providerIDs) => {
        seen = providerIDs
        return []
      },
      summarizeSessionUsageForDisplay: async () => makeCompactUsage(),
      scheduleParentRefreshIfSafe: () => {},
      restoreConcurrency: 1,
    })

    await applicator.applyTitle(sessionID)

    assert.deepEqual(seen, ['openai'])
  })

  it('accepts user titles that mention cache coverage as plain text', async () => {
    const config = makeConfig()
    const state = defaultState()
    state.titleEnabled = true

    const createdAt = Date.now()
    const sessionID = 's1'
    const dateKey = dateKeyFromTimestamp(createdAt)
    const incomingTitle = 'Project notes\nCache Coverage plan'

    state.sessions[sessionID] = {
      createdAt,
      baseTitle: 'Old title',
      lastAppliedTitle: undefined,
    }
    state.sessionDateMap[sessionID] = dateKey

    let refreshSessionID: string | undefined

    const applicator = createTitleApplicator({
      state,
      config,
      directory: '/tmp',
      client: {
        session: {
          get: async () =>
            ({
              data: {
                id: sessionID,
                title: incomingTitle,
                time: { created: createdAt },
                parentID: undefined,
              },
            }) as any,
          update: async () => {
            throw new Error('unexpected session.update')
          },
          list: async () => ({ data: [] }) as any,
        },
      } as any,
      ensureSessionState: (_id, _title, _created) => state.sessions[sessionID],
      markDirty: () => {},
      scheduleSave: () => {},
      renderSidebarTitle: () => incomingTitle,
      getQuotaSnapshots: async () => [],
      summarizeSessionUsageForDisplay: async () => makeUsage(),
      scheduleParentRefreshIfSafe: () => {},
      restoreConcurrency: 1,
    })

    await applicator.handleSessionUpdatedTitle({
      sessionID,
      incomingTitle,
      sessionState: state.sessions[sessionID],
      scheduleRefresh: (id) => {
        refreshSessionID = id
      },
    })

    assert.equal(
      state.sessions[sessionID].baseTitle,
      'Project notes\nCache Coverage plan',
    )
    assert.equal(state.sessions[sessionID].lastAppliedTitle, undefined)
    assert.equal(refreshSessionID, sessionID)
  })

  it('ignores untracked decorated cache coverage echoes instead of promoting them to baseTitle', async () => {
    const config = makeConfig()
    const state = defaultState()
    state.titleEnabled = true

    const createdAt = Date.now()
    const sessionID = 's1'
    const dateKey = dateKeyFromTimestamp(createdAt)
    const incomingTitle = 'Session\nInput 10  Output 20\nCache Coverage 60%'

    state.sessions[sessionID] = {
      createdAt,
      baseTitle: 'Session',
      lastAppliedTitle: undefined,
    }
    state.sessionDateMap[sessionID] = dateKey

    let refreshCalled = false

    const applicator = createTitleApplicator({
      state,
      config,
      directory: '/tmp',
      client: {
        session: {
          get: async () =>
            ({
              data: {
                id: sessionID,
                title: incomingTitle,
                time: { created: createdAt },
                parentID: undefined,
              },
            }) as any,
          update: async () => {
            throw new Error('unexpected session.update')
          },
          list: async () => ({ data: [] }) as any,
        },
      } as any,
      ensureSessionState: (_id, _title, _created) => state.sessions[sessionID],
      markDirty: () => {
        throw new Error('unexpected markDirty')
      },
      scheduleSave: () => {
        throw new Error('unexpected scheduleSave')
      },
      renderSidebarTitle: () => incomingTitle,
      getQuotaSnapshots: async () => [],
      summarizeSessionUsageForDisplay: async () => makeUsage(),
      scheduleParentRefreshIfSafe: () => {},
      restoreConcurrency: 1,
    })

    await applicator.handleSessionUpdatedTitle({
      sessionID,
      incomingTitle,
      sessionState: state.sessions[sessionID],
      scheduleRefresh: () => {
        refreshCalled = true
      },
    })

    assert.equal(state.sessions[sessionID].baseTitle, 'Session')
    assert.equal(state.sessions[sessionID].lastAppliedTitle, undefined)
    assert.equal(refreshCalled, false)
  })

  it('accepts user titles that contain quota-like plain text', async () => {
    const config = makeConfig()
    const state = defaultState()
    state.titleEnabled = true

    const createdAt = Date.now()
    const sessionID = 's1'
    const dateKey = dateKeyFromTimestamp(createdAt)
    const incomingTitle = 'Project rollout\nOpenAI 50% complete'

    state.sessions[sessionID] = {
      createdAt,
      baseTitle: 'Old title',
      lastAppliedTitle: undefined,
    }
    state.sessionDateMap[sessionID] = dateKey

    let refreshSessionID: string | undefined

    const applicator = createTitleApplicator({
      state,
      config,
      directory: '/tmp',
      client: {
        session: {
          get: async () =>
            ({
              data: {
                id: sessionID,
                title: incomingTitle,
                time: { created: createdAt },
                parentID: undefined,
              },
            }) as any,
          update: async () => {
            throw new Error('unexpected session.update')
          },
          list: async () => ({ data: [] }) as any,
        },
      } as any,
      ensureSessionState: (_id, _title, _created) => state.sessions[sessionID],
      markDirty: () => {},
      scheduleSave: () => {},
      renderSidebarTitle: () => incomingTitle,
      getQuotaSnapshots: async () => [],
      summarizeSessionUsageForDisplay: async () => makeUsage(),
      scheduleParentRefreshIfSafe: () => {},
      restoreConcurrency: 1,
    })

    await applicator.handleSessionUpdatedTitle({
      sessionID,
      incomingTitle,
      sessionState: state.sessions[sessionID],
      scheduleRefresh: (id) => {
        refreshSessionID = id
      },
    })

    assert.equal(
      state.sessions[sessionID].baseTitle,
      'Project rollout\nOpenAI 50% complete',
    )
    assert.equal(state.sessions[sessionID].lastAppliedTitle, undefined)
    assert.equal(refreshSessionID, sessionID)
  })

  it('does not replace base title with truncated single-line decorated echo', async () => {
    const config = makeConfig()
    config.sidebar.multilineTitle = false
    config.sidebar.width = 20

    const state = defaultState()
    state.titleEnabled = true

    const createdAt = Date.now()
    const sessionID = 's1'
    const dateKey = dateKeyFromTimestamp(createdAt)
    const incomingTitle = 'Greetin~ | Input 1.~'

    state.sessions[sessionID] = {
      createdAt,
      baseTitle: 'Greeting and quick check-in',
      lastAppliedTitle: undefined,
    }
    state.sessionDateMap[sessionID] = dateKey

    const applicator = createTitleApplicator({
      state,
      config,
      directory: '/tmp',
      client: {
        session: {
          get: async () =>
            ({
              data: {
                id: sessionID,
                title: incomingTitle,
                time: { created: createdAt },
                parentID: undefined,
              },
            }) as any,
          update: async () => {
            throw new Error('unexpected session.update')
          },
          list: async () => ({ data: [] }) as any,
        },
      } as any,
      ensureSessionState: (_id, _title, _created) => state.sessions[sessionID],
      markDirty: () => {},
      scheduleSave: () => {},
      renderSidebarTitle: () => incomingTitle,
      getQuotaSnapshots: async () => [],
      summarizeSessionUsageForDisplay: async () => makeUsage(),
      scheduleParentRefreshIfSafe: () => {},
      restoreConcurrency: 1,
    })

    await applicator.applyTitle(sessionID)

    assert.equal(
      state.sessions[sessionID].baseTitle,
      'Greeting and quick check-in',
    )
  })

  it('keeps natural pipe-delimited titles intact in single-line mode', async () => {
    const config = makeConfig()
    config.sidebar.multilineTitle = false
    config.sidebar.width = 24

    const state = defaultState()
    state.titleEnabled = true

    const createdAt = Date.now()
    const sessionID = 's1'
    const dateKey = dateKeyFromTimestamp(createdAt)
    const incomingTitle = 'Notes | OpenAI migration plan'

    state.sessions[sessionID] = {
      createdAt,
      baseTitle: 'Old title',
      lastAppliedTitle: undefined,
    }
    state.sessionDateMap[sessionID] = dateKey

    let refreshSessionID: string | undefined

    const applicator = createTitleApplicator({
      state,
      config,
      directory: '/tmp',
      client: {
        session: {
          get: async () =>
            ({
              data: {
                id: sessionID,
                title: incomingTitle,
                time: { created: createdAt },
                parentID: undefined,
              },
            }) as any,
          update: async () => {
            throw new Error('unexpected session.update')
          },
          list: async () => ({ data: [] }) as any,
        },
      } as any,
      ensureSessionState: (_id, _title, _created) => state.sessions[sessionID],
      markDirty: () => {},
      scheduleSave: () => {},
      renderSidebarTitle: () => incomingTitle,
      getQuotaSnapshots: async () => [],
      summarizeSessionUsageForDisplay: async () => makeUsage(),
      scheduleParentRefreshIfSafe: () => {},
      restoreConcurrency: 1,
    })

    await applicator.handleSessionUpdatedTitle({
      sessionID,
      incomingTitle,
      sessionState: state.sessions[sessionID],
      scheduleRefresh: (id) => {
        refreshSessionID = id
      },
    })

    assert.equal(state.sessions[sessionID].baseTitle, incomingTitle)
    assert.equal(state.sessions[sessionID].lastAppliedTitle, undefined)
    assert.equal(refreshSessionID, sessionID)
  })

  it('keeps lastAppliedTitle when restoreSessionTitle update fails', async () => {
    const config = makeConfig()
    const state = defaultState()
    state.titleEnabled = true

    const createdAt = Date.now()
    const sessionID = 's1'
    const dateKey = dateKeyFromTimestamp(createdAt)

    state.sessions[sessionID] = {
      createdAt,
      baseTitle: 'Session',
      lastAppliedTitle: 'Session\nInput 10  Output 20',
    }
    state.sessionDateMap[sessionID] = dateKey

    const applicator = createTitleApplicator({
      state,
      config,
      directory: '/tmp',
      client: {
        session: {
          get: async () =>
            ({
              data: {
                id: sessionID,
                title: 'Session\nInput 10  Output 20',
                time: { created: createdAt },
                parentID: undefined,
              },
            }) as any,
          update: async () => {
            throw new Error('boom')
          },
          list: async () => ({ data: [] }) as any,
        },
      } as any,
      ensureSessionState: (_id, _title, _created) => state.sessions[sessionID],
      markDirty: () => {},
      scheduleSave: () => {},
      renderSidebarTitle: () => 'ignored',
      getQuotaSnapshots: async () => [],
      summarizeSessionUsageForDisplay: async () => makeUsage(),
      scheduleParentRefreshIfSafe: () => {},
      restoreConcurrency: 1,
    })

    await applicator.restoreSessionTitle(sessionID)
    assert.equal(
      state.sessions[sessionID].lastAppliedTitle,
      'Session\nInput 10  Output 20',
    )
  })

  it('accepts a manual cost-related rename even when lastAppliedTitle exists', async () => {
    const config = makeConfig()
    const state = defaultState()
    state.titleEnabled = true

    const createdAt = Date.now()
    const sessionID = 's1'
    const dateKey = dateKeyFromTimestamp(createdAt)
    const incomingTitle = 'Budget\n$1.23 as API cost target'

    state.sessions[sessionID] = {
      createdAt,
      baseTitle: 'Old title',
      lastAppliedTitle: 'Old title\nInput 10  Output 20',
    }
    state.sessionDateMap[sessionID] = dateKey

    let refreshSessionID: string | undefined

    const applicator = createTitleApplicator({
      state,
      config,
      directory: '/tmp',
      client: {
        session: {
          get: async () =>
            ({
              data: {
                id: sessionID,
                title: incomingTitle,
                time: { created: createdAt },
                parentID: undefined,
              },
            }) as any,
          update: async () => {
            throw new Error('unexpected session.update')
          },
          list: async () => ({ data: [] }) as any,
        },
      } as any,
      ensureSessionState: (_id, _title, _created) => state.sessions[sessionID],
      markDirty: () => {},
      scheduleSave: () => {},
      renderSidebarTitle: () => incomingTitle,
      getQuotaSnapshots: async () => [],
      summarizeSessionUsageForDisplay: async () => makeUsage(),
      scheduleParentRefreshIfSafe: () => {},
      restoreConcurrency: 1,
    })

    await applicator.handleSessionUpdatedTitle({
      sessionID,
      incomingTitle,
      sessionState: state.sessions[sessionID],
      scheduleRefresh: (id) => {
        refreshSessionID = id
      },
    })

    assert.equal(state.sessions[sessionID].baseTitle, incomingTitle)
    assert.equal(state.sessions[sessionID].lastAppliedTitle, undefined)
    assert.equal(refreshSessionID, sessionID)
  })

  it('ignores delayed decorated echo after restore even if titles are re-enabled', async () => {
    const config = makeConfig()
    const state = defaultState()
    state.titleEnabled = true

    const createdAt = Date.now()
    const sessionID = 's1'
    const dateKey = dateKeyFromTimestamp(createdAt)
    const decorated = 'Session\nInput 10  Output 20'

    state.sessions[sessionID] = {
      createdAt,
      baseTitle: 'Session',
      lastAppliedTitle: decorated,
    }
    state.sessionDateMap[sessionID] = dateKey

    let currentTitle = decorated

    const applicator = createTitleApplicator({
      state,
      config,
      directory: '/tmp',
      client: {
        session: {
          get: async () =>
            ({
              data: {
                id: sessionID,
                title: currentTitle,
                time: { created: createdAt },
                parentID: undefined,
              },
            }) as any,
          update: async (args: any) => {
            currentTitle = args.body.title
            return { data: { ok: true } }
          },
          list: async () => ({ data: [] }) as any,
        },
      } as any,
      ensureSessionState: (_id, _title, _created) => state.sessions[sessionID],
      markDirty: () => {},
      scheduleSave: () => {},
      renderSidebarTitle: () => decorated,
      getQuotaSnapshots: async () => [],
      summarizeSessionUsageForDisplay: async () => makeUsage(),
      scheduleParentRefreshIfSafe: () => {},
      restoreConcurrency: 1,
    })

    await applicator.restoreSessionTitle(sessionID)
    state.titleEnabled = true

    let scheduled = false
    await applicator.handleSessionUpdatedTitle({
      sessionID,
      incomingTitle: decorated,
      sessionState: state.sessions[sessionID],
      scheduleRefresh: () => {
        scheduled = true
      },
    })

    assert.equal(state.sessions[sessionID].baseTitle, 'Session')
    assert.equal(state.sessions[sessionID].lastAppliedTitle, undefined)
    assert.equal(scheduled, false)
  })
})
