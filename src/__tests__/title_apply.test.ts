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
      quotaRuntime: { normalizeProviderID: (id: string) => id },
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
      quotaRuntime: { normalizeProviderID: (id: string) => id },
      getQuotaSnapshots: async () => [],
      summarizeSessionUsageForDisplay: async () => makeUsage(),
      scheduleParentRefreshIfSafe: () => {},
      restoreConcurrency: 1,
    })

    await applicator.applyTitle(sessionID)
    assert.equal(state.sessions[sessionID].lastAppliedTitle, normalized)
    assert.equal(dirtyKey, dateKey)
  })
})
