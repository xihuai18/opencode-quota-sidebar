import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createUsageService } from '../usage_service.js'
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
