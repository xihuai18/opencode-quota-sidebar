import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { computeHistoryUsage } from '../history_usage.js'
import { toCachedSessionUsage } from '../usage.js'

function assistantMessage(
  sessionID: string,
  messageID: string,
  completedAt: number,
  input: number,
) {
  return {
    info: {
      id: messageID,
      parentID: 'u1',
      sessionID,
      role: 'assistant' as const,
      mode: 'build',
      providerID: 'openai',
      modelID: 'gpt-5',
      path: { cwd: 'ignored', root: 'ignored' },
      time: { created: completedAt - 10, completed: completedAt },
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

describe('computeHistoryUsage', () => {
  it('splits assistant messages across multiple day rows', async () => {
    const dayOne = new Date(2026, 3, 10, 12).getTime()
    const dayTwo = new Date(2026, 3, 11, 12).getTime()
    const realNow = Date.now
    Date.now = () => new Date(2026, 3, 11, 23, 59, 59).getTime()

    try {
      const result = await computeHistoryUsage(
        {
          sessions: [
            {
              sessionID: 's1',
              dateKey: '2026-04-10',
              state: {
                createdAt: dayOne,
                cursor: { lastMessageTime: dayTwo },
              },
            },
          ],
          loadMessagesPage: async () => ({
            status: 'ok',
            entries: [
              assistantMessage('s1', 'm1', dayOne, 100),
              assistantMessage('s1', 'm2', dayTwo, 200),
            ],
          }),
          getModelCostMap: async () => ({}),
          calcApiCost: () => 0,
          classifyCacheMode: () => 'none',
          hasResolvableApiCostMessages: () => false,
          shouldTrackFullUsage: () => false,
          shouldRecomputeUsageCache: () => false,
        },
        'day',
        '2026-04-10',
      )

      assert.equal(result.rows.length, 2)
      assert.equal(result.rows[0].range.label, '2026-04-10')
      assert.equal(result.rows[0].usage.input, 100)
      assert.equal(result.rows[1].range.label, '2026-04-11')
      assert.equal(result.rows[1].usage.input, 200)
      assert.equal(result.total.input, 300)
      assert.equal(result.total.assistantMessages, 2)
      assert.equal(result.total.sessionCount, 1)
    } finally {
      Date.now = realNow
    }
  })

  it('returns persistence hints when caller tracks full usage', async () => {
    const completedAt = new Date(2026, 3, 12, 12).getTime()
    const realNow = Date.now
    Date.now = () => new Date(2026, 3, 12, 23, 59, 59).getTime()

    try {
      const result = await computeHistoryUsage(
        {
          sessions: [
            {
              sessionID: 's1',
              dateKey: '2026-04-12',
              state: {
                createdAt: completedAt,
                cursor: { lastMessageTime: completedAt },
              },
            },
          ],
          loadMessagesPage: async () => ({
            status: 'ok',
            entries: [assistantMessage('s1', 'm1', completedAt, 50)],
          }),
          getModelCostMap: async () => ({}),
          calcApiCost: () => 0,
          classifyCacheMode: () => 'none',
          hasResolvableApiCostMessages: () => true,
          shouldTrackFullUsage: () => true,
          shouldRecomputeUsageCache: () => true,
        },
        'day',
        '2026-04-12',
      )

      const hints = result.persistenceHints
      assert.ok(hints)
      assert.equal(hints?.length, 1)
      assert.equal(hints?.[0].sessionID, 's1')
      assert.equal(hints?.[0].persist, true)
      assert.equal(hints?.[0].fullUsage?.input, 50)
    } finally {
      Date.now = realNow
    }
  })

  it('reuses current billing cache for a single-bucket session without loading messages', async () => {
    const completedAt = new Date(2026, 3, 12, 12).getTime()
    const realNow = Date.now
    Date.now = () => new Date(2026, 3, 12, 23, 59, 59).getTime()

    let loadCalls = 0

    try {
      const result = await computeHistoryUsage(
        {
          sessions: [
            {
              sessionID: 's1',
              dateKey: '2026-04-12',
              state: {
                createdAt: completedAt - 1000,
                cursor: { lastMessageTime: completedAt },
                usage: toCachedSessionUsage({
                  input: 123,
                  output: 0,
                  reasoning: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 123,
                  cost: 0,
                  apiCost: 0,
                  assistantMessages: 1,
                  sessionCount: 1,
                  providers: {},
                } as any),
              },
            },
          ],
          loadMessagesPage: async () => {
            loadCalls += 1
            return { status: 'ok', entries: [] }
          },
          getModelCostMap: async () => ({}),
          calcApiCost: () => 0,
          classifyCacheMode: () => 'none',
          hasResolvableApiCostMessages: () => false,
          shouldTrackFullUsage: () => false,
          shouldRecomputeUsageCache: () => false,
        },
        'day',
        '2026-04-12',
      )

      assert.equal(loadCalls, 0)
      assert.equal(result.total.input, 123)
      assert.equal(result.total.assistantMessages, 1)
      assert.equal(result.rows[0].usage.input, 123)
    } finally {
      Date.now = realNow
    }
  })

  it('stops paging once the newest entry in a page is older than the requested range', async () => {
    const now = new Date(2026, 3, 12, 23, 59, 59).getTime()
    const todayHit = new Date(2026, 3, 12, 10).getTime()
    const oldHit = new Date(2026, 3, 10, 10).getTime()
    const realNow = Date.now
    Date.now = () => now

    const calls: string[] = []

    try {
      const result = await computeHistoryUsage(
        {
          sessions: [
            {
              sessionID: 's1',
              dateKey: '2026-04-01',
              state: {
                createdAt: new Date(2026, 3, 1).getTime(),
                cursor: { lastMessageTime: todayHit },
              },
            },
          ],
          loadMessagesPage: async (_sessionID, before) => {
            calls.push(before || 'first')
            if (!before) {
              return {
                status: 'ok',
                entries: [assistantMessage('s1', 'm1', todayHit, 50)],
                nextBefore: 'older',
              }
            }
            if (before === 'older') {
              return {
                status: 'ok',
                entries: [assistantMessage('s1', 'm2', oldHit, 999)],
                nextBefore: 'too-old-to-need',
              }
            }
            return {
              status: 'ok',
              entries: [assistantMessage('s1', 'm3', oldHit - 1000, 999)],
            }
          },
          getModelCostMap: async () => ({}),
          calcApiCost: () => 0,
          classifyCacheMode: () => 'none',
          hasResolvableApiCostMessages: () => false,
          shouldTrackFullUsage: () => false,
          shouldRecomputeUsageCache: () => false,
          throwOnLoadFailure: false,
        },
        'day',
        '2026-04-12',
      )

      assert.deepEqual(calls, ['first', 'older'])
      assert.equal(result.total.input, 50)
      assert.equal(result.rows.length, 1)
      assert.equal(result.rows[0].usage.input, 50)
    } finally {
      Date.now = realNow
    }
  })
})
