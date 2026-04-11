import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createQuotaSidebarTools } from '../tools.js'

function emptyUsage() {
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
    sessionCount: 0,
    providers: {},
  }
}

function emptyHistory(period: 'day' | 'week' | 'month', since: string) {
  const precision = since.length === 7 ? ('month' as const) : ('day' as const)
  return {
    period,
    since: {
      raw: since,
      precision,
      startAt: 0,
    },
    rows: [],
    total: emptyUsage(),
  }
}

describe('quota_summary tool', () => {
  it('supports week period with toast enabled', async () => {
    const calls: Array<{
      type: string
      period?: string
      includeChildren?: boolean
    }> = []
    const toolset = createQuotaSidebarTools({
      getTitleEnabled: () => true,
      setTitleEnabled: () => {},
      scheduleSave: () => {},
      flushSave: async () => {},
      waitForStartupTitleWork: async () => {},
      refreshSessionTitle: () => {},
      cancelAllTitleRefreshes: () => {},
      flushScheduledTitleRefreshes: async () => {},
      waitForTitleRefreshIdle: async () => {},
      waitForTitleRefreshQuiescence: async () => {},
      showToast: async (period) => {
        calls.push({ type: 'toast', period })
      },
      summarizeForTool: async (period, _sessionID, includeChildren) => {
        calls.push({ type: 'summary', period, includeChildren })
        return emptyUsage()
      },
      getQuotaSnapshots: async () => [],
      renderMarkdownReport: (period) => `markdown:${period}`,
      renderToastMessage: (period) => `toast:${period}`,
      summarizeHistoryForTool: async (period, since) =>
        emptyHistory(period, since),
      renderHistoryMarkdownReport: () => '',
      config: {
        sidebar: { showCost: true, width: 36, includeChildren: true },
        sidebarEnabled: true,
      },
    })

    const result = await toolset.quota_summary.execute(
      { period: 'week', toast: true },
      { sessionID: 's1' } as never,
    )

    assert.equal(result, 'markdown:week')
    assert.deepEqual(calls, [
      { type: 'summary', period: 'week', includeChildren: false },
      { type: 'toast', period: 'week' },
    ])
  })

  it('supports month period with toast enabled', async () => {
    const calls: Array<{
      type: string
      period?: string
      includeChildren?: boolean
    }> = []
    const toolset = createQuotaSidebarTools({
      getTitleEnabled: () => true,
      setTitleEnabled: () => {},
      scheduleSave: () => {},
      flushSave: async () => {},
      waitForStartupTitleWork: async () => {},
      refreshSessionTitle: () => {},
      cancelAllTitleRefreshes: () => {},
      flushScheduledTitleRefreshes: async () => {},
      waitForTitleRefreshIdle: async () => {},
      waitForTitleRefreshQuiescence: async () => {},
      showToast: async (period) => {
        calls.push({ type: 'toast', period })
      },
      summarizeForTool: async (period, _sessionID, includeChildren) => {
        calls.push({ type: 'summary', period, includeChildren })
        return emptyUsage()
      },
      getQuotaSnapshots: async () => [],
      renderMarkdownReport: (period) => `markdown:${period}`,
      renderToastMessage: (period) => `toast:${period}`,
      summarizeHistoryForTool: async (period, since) =>
        emptyHistory(period, since),
      renderHistoryMarkdownReport: () => '',
      config: {
        sidebar: { showCost: true, width: 36, includeChildren: true },
        sidebarEnabled: true,
      },
    })

    const result = await toolset.quota_summary.execute(
      { period: 'month', toast: true },
      { sessionID: 's1' } as never,
    )

    assert.equal(result, 'markdown:month')
    assert.deepEqual(calls, [
      { type: 'summary', period: 'month', includeChildren: false },
      { type: 'toast', period: 'month' },
    ])
  })

  it('uses history summary and skips toast by default when since is provided', async () => {
    const calls: Array<Record<string, unknown>> = []
    const toolset = createQuotaSidebarTools({
      getTitleEnabled: () => true,
      setTitleEnabled: () => {},
      scheduleSave: () => {},
      flushSave: async () => {},
      waitForStartupTitleWork: async () => {},
      refreshSessionTitle: () => {},
      cancelAllTitleRefreshes: () => {},
      flushScheduledTitleRefreshes: async () => {},
      waitForTitleRefreshIdle: async () => {},
      waitForTitleRefreshQuiescence: async () => {},
      showToast: async (period) => {
        calls.push({ type: 'toast', period })
      },
      summarizeForTool: async () => {
        calls.push({ type: 'summary' })
        return emptyUsage()
      },
      summarizeHistoryForTool: async (period, since) => {
        calls.push({ type: 'history', period, since })
        return emptyHistory(period, since)
      },
      getQuotaSnapshots: async () => [],
      renderMarkdownReport: () => 'unexpected',
      renderToastMessage: () => 'toast',
      renderHistoryMarkdownReport: () => 'history:month:2026-01',
      config: {
        sidebar: { showCost: true, width: 36, includeChildren: true },
        sidebarEnabled: true,
      },
    })

    const result = await toolset.quota_summary.execute(
      { period: 'month', since: '2026-01' },
      { sessionID: 's1' } as never,
    )

    assert.equal(result, 'history:month:2026-01')
    assert.deepEqual(calls, [
      { type: 'history', period: 'month', since: '2026-01' },
    ])
  })

  it('defaults since-only history requests to month period', async () => {
    const calls: Array<Record<string, unknown>> = []
    const toolset = createQuotaSidebarTools({
      getTitleEnabled: () => true,
      setTitleEnabled: () => {},
      scheduleSave: () => {},
      flushSave: async () => {},
      waitForStartupTitleWork: async () => {},
      refreshSessionTitle: () => {},
      cancelAllTitleRefreshes: () => {},
      flushScheduledTitleRefreshes: async () => {},
      waitForTitleRefreshIdle: async () => {},
      waitForTitleRefreshQuiescence: async () => {},
      showToast: async () => {},
      summarizeForTool: async () => emptyUsage(),
      summarizeHistoryForTool: async (period, since) => {
        calls.push({ period, since })
        return emptyHistory(period, since)
      },
      getQuotaSnapshots: async () => [],
      renderMarkdownReport: () => '',
      renderToastMessage: () => '',
      renderHistoryMarkdownReport: () => 'history:month:2026-01',
      config: {
        sidebar: { showCost: true, width: 36, includeChildren: true },
        sidebarEnabled: true,
      },
    })

    const result = await toolset.quota_summary.execute({ since: '2026-01' }, {
      sessionID: 's1',
    } as never)

    assert.equal(result, 'history:month:2026-01')
    assert.deepEqual(calls, [{ period: 'month', since: '2026-01' }])
  })

  it('rejects since for session period', async () => {
    const toolset = createQuotaSidebarTools({
      getTitleEnabled: () => true,
      setTitleEnabled: () => {},
      scheduleSave: () => {},
      flushSave: async () => {},
      waitForStartupTitleWork: async () => {},
      refreshSessionTitle: () => {},
      cancelAllTitleRefreshes: () => {},
      flushScheduledTitleRefreshes: async () => {},
      waitForTitleRefreshIdle: async () => {},
      waitForTitleRefreshQuiescence: async () => {},
      showToast: async () => {},
      summarizeForTool: async () => emptyUsage(),
      summarizeHistoryForTool: async (period, since) =>
        emptyHistory(period, since),
      getQuotaSnapshots: async () => [],
      renderMarkdownReport: () => '',
      renderToastMessage: () => '',
      renderHistoryMarkdownReport: () => '',
      config: {
        sidebar: { showCost: true, width: 36, includeChildren: true },
        sidebarEnabled: true,
      },
    })

    await assert.rejects(
      toolset.quota_summary.execute({ period: 'session', since: '2026-01' }, {
        sessionID: 's1',
      } as never),
      /`since` is not supported when `period=session`/,
    )
  })
})

describe('quota_show tool', () => {
  it('does not bulk-restore historical titles when OFF rollback keeps display enabled', async () => {
    let titleEnabled = true
    let refreshVisibleCalls = 0
    let refreshTouchedCalls = 0
    const toolset = createQuotaSidebarTools({
      getTitleEnabled: () => titleEnabled,
      setTitleEnabled: (enabled) => {
        titleEnabled = enabled
      },
      scheduleSave: () => {},
      flushSave: async () => {},
      waitForStartupTitleWork: async () => {},
      refreshSessionTitle: () => {},
      cancelAllTitleRefreshes: () => {},
      flushScheduledTitleRefreshes: async () => {},
      waitForTitleRefreshIdle: async () => {},
      waitForTitleRefreshQuiescence: async () => {},
      restoreSessionTitle: async () => false,
      showToast: async () => {},
      summarizeForTool: async () => ({
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        apiCost: 0,
        assistantMessages: 0,
        sessionCount: 0,
        providers: {},
      }),
      getQuotaSnapshots: async () => [],
      renderMarkdownReport: () => '',
      renderToastMessage: () => '',
      summarizeHistoryForTool: async (period, since) =>
        emptyHistory(period, since),
      renderHistoryMarkdownReport: () => '',
      config: {
        sidebar: { showCost: true, width: 36, includeChildren: true },
        sidebarEnabled: true,
      },
    })

    const result = await toolset.quota_show.execute({ enabled: false }, {
      sessionID: 's1',
    } as never)

    assert.equal(titleEnabled, true)
    assert.equal(refreshVisibleCalls, 0)
    assert.equal(refreshTouchedCalls, 0)
    assert.match(result, /remains ON/)
  })

  it('waits for startup title work before turning display on', async () => {
    const order: string[] = []
    let titleEnabled = false
    const toolset = createQuotaSidebarTools({
      getTitleEnabled: () => titleEnabled,
      setTitleEnabled: (enabled) => {
        titleEnabled = enabled
        order.push(`set:${enabled ? 'on' : 'off'}`)
      },
      scheduleSave: () => order.push('scheduleSave'),
      flushSave: async () => {
        order.push('flushSave')
      },
      waitForStartupTitleWork: async () => {
        order.push('startupWait')
      },
      refreshSessionTitle: () => order.push('refreshSessionTitle'),
      cancelAllTitleRefreshes: () => {},
      flushScheduledTitleRefreshes: async () => {},
      waitForTitleRefreshIdle: async () => {},
      waitForTitleRefreshQuiescence: async () => {},
      restoreSessionTitle: async () => false,
      showToast: async () => {
        order.push('toast')
      },
      summarizeForTool: async () => ({
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        apiCost: 0,
        assistantMessages: 0,
        sessionCount: 0,
        providers: {},
      }),
      getQuotaSnapshots: async () => [],
      renderMarkdownReport: () => '',
      renderToastMessage: () => '',
      summarizeHistoryForTool: async (period, since) =>
        emptyHistory(period, since),
      renderHistoryMarkdownReport: () => '',
      config: {
        sidebar: { showCost: true, width: 36, includeChildren: true },
        sidebarEnabled: true,
      },
    })

    await toolset.quota_show.execute({ enabled: true }, {
      sessionID: 's1',
    } as never)

    assert.ok(order.indexOf('startupWait') < order.indexOf('set:on'))
    assert.deepEqual(order, [
      'startupWait',
      'set:on',
      'scheduleSave',
      'flushSave',
      'refreshSessionTitle',
      'toast',
    ])
  })

  it('marks the current session active before refreshing on enable', async () => {
    const order: string[] = []
    let titleEnabled = false
    const toolset = createQuotaSidebarTools({
      getTitleEnabled: () => titleEnabled,
      setTitleEnabled: (enabled) => {
        titleEnabled = enabled
      },
      scheduleSave: () => {},
      flushSave: async () => {},
      waitForStartupTitleWork: async () => {},
      markSessionActive: (sessionID) => {
        order.push(`active:${sessionID}`)
      },
      refreshSessionTitle: (sessionID) => {
        order.push(`refresh:${sessionID}`)
      },
      cancelAllTitleRefreshes: () => {},
      flushScheduledTitleRefreshes: async () => {},
      waitForTitleRefreshIdle: async () => {},
      waitForTitleRefreshQuiescence: async () => {},
      restoreSessionTitle: async () => false,
      showToast: async () => {},
      summarizeForTool: async () => ({
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        apiCost: 0,
        assistantMessages: 0,
        sessionCount: 0,
        providers: {},
      }),
      getQuotaSnapshots: async () => [],
      renderMarkdownReport: () => '',
      renderToastMessage: () => '',
      summarizeHistoryForTool: async (period, since) =>
        emptyHistory(period, since),
      renderHistoryMarkdownReport: () => '',
      config: {
        sidebar: { showCost: true, width: 36, includeChildren: true },
        sidebarEnabled: true,
      },
    })

    await toolset.quota_show.execute({ enabled: true }, {
      sessionID: 's1',
    } as never)

    assert.deepEqual(order, ['active:s1', 'refresh:s1'])
  })

  it('does not block forever on hung startup title work', async () => {
    let titleEnabled = false
    const started = Date.now()
    const toolset = createQuotaSidebarTools({
      getTitleEnabled: () => titleEnabled,
      setTitleEnabled: (enabled) => {
        titleEnabled = enabled
      },
      scheduleSave: () => {},
      flushSave: async () => {},
      waitForStartupTitleWork: async () => {
        await new Promise(() => {})
      },
      refreshSessionTitle: () => {},
      cancelAllTitleRefreshes: () => {},
      flushScheduledTitleRefreshes: async () => {},
      waitForTitleRefreshIdle: async () => {},
      waitForTitleRefreshQuiescence: async () => {},
      restoreSessionTitle: async () => false,
      showToast: async () => {},
      summarizeForTool: async () => ({
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        apiCost: 0,
        assistantMessages: 0,
        sessionCount: 0,
        providers: {},
      }),
      getQuotaSnapshots: async () => [],
      renderMarkdownReport: () => '',
      renderToastMessage: () => '',
      summarizeHistoryForTool: async (period, since) =>
        emptyHistory(period, since),
      renderHistoryMarkdownReport: () => '',
      config: {
        sidebar: { showCost: true, width: 36, includeChildren: true },
        sidebarEnabled: true,
      },
    })

    const result = await toolset.quota_show.execute({ enabled: true }, {
      sessionID: 's1',
    } as never)

    assert.equal(titleEnabled, true)
    assert.match(result, /now ON/)
    assert.ok(Date.now() - started < 3500)
  })

  it('restores only the current session when turning display off', async () => {
    let titleEnabled = true
    const order: string[] = []
    const toolset = createQuotaSidebarTools({
      getTitleEnabled: () => titleEnabled,
      setTitleEnabled: (enabled) => {
        titleEnabled = enabled
      },
      scheduleSave: () => order.push('scheduleSave'),
      flushSave: async () => {
        order.push('flushSave')
      },
      waitForStartupTitleWork: async () => {},
      refreshSessionTitle: () => {
        order.push('refreshSessionTitle')
      },
      cancelAllTitleRefreshes: () => {
        order.push('cancelAll')
      },
      flushScheduledTitleRefreshes: async () => {},
      waitForTitleRefreshIdle: async () => {},
      waitForTitleRefreshQuiescence: async () => {
        order.push('quiescence')
      },
      restoreSessionTitle: async (sessionID) => {
        order.push(`restore:${sessionID}`)
        return true
      },
      showToast: async () => {
        order.push('toast')
      },
      summarizeForTool: async () => ({
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        apiCost: 0,
        assistantMessages: 0,
        sessionCount: 0,
        providers: {},
      }),
      getQuotaSnapshots: async () => [],
      renderMarkdownReport: () => '',
      renderToastMessage: () => '',
      summarizeHistoryForTool: async (period, since) =>
        emptyHistory(period, since),
      renderHistoryMarkdownReport: () => '',
      config: {
        sidebar: { showCost: true, width: 36, includeChildren: true },
        sidebarEnabled: true,
      },
    })

    const result = await toolset.quota_show.execute({ enabled: false }, {
      sessionID: 's1',
    } as never)

    assert.equal(titleEnabled, false)
    assert.match(result, /current session title was restored/i)
    assert.deepEqual(order, [
      'scheduleSave',
      'flushSave',
      'cancelAll',
      'quiescence',
      'restore:s1',
      'toast',
    ])
  })

  it('redecorates current session after OFF rollback keeps display enabled', async () => {
    let titleEnabled = true
    let currentRefreshCalls = 0
    const toolset = createQuotaSidebarTools({
      getTitleEnabled: () => titleEnabled,
      setTitleEnabled: (enabled) => {
        titleEnabled = enabled
      },
      scheduleSave: () => {},
      flushSave: async () => {},
      waitForStartupTitleWork: async () => {},
      refreshSessionTitle: () => {
        currentRefreshCalls++
      },
      cancelAllTitleRefreshes: () => {},
      flushScheduledTitleRefreshes: async () => {},
      waitForTitleRefreshIdle: async () => {},
      waitForTitleRefreshQuiescence: async () => {},
      restoreSessionTitle: async () => false,
      showToast: async () => {},
      summarizeForTool: async () => ({
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        apiCost: 0,
        assistantMessages: 0,
        sessionCount: 0,
        providers: {},
      }),
      getQuotaSnapshots: async () => [],
      renderMarkdownReport: () => '',
      renderToastMessage: () => '',
      summarizeHistoryForTool: async (period, since) =>
        emptyHistory(period, since),
      renderHistoryMarkdownReport: () => '',
      config: {
        sidebar: { showCost: true, width: 36, includeChildren: true },
        sidebarEnabled: true,
      },
    })

    await toolset.quota_show.execute({ enabled: false }, {
      sessionID: 's1',
    } as never)

    assert.equal(titleEnabled, true)
    assert.equal(currentRefreshCalls, 1)
  })

  it('refuses to enable display when sidebar feature is disabled in config', async () => {
    let titleEnabled = false
    const toolset = createQuotaSidebarTools({
      getTitleEnabled: () => titleEnabled,
      setTitleEnabled: (enabled) => {
        titleEnabled = enabled
      },
      scheduleSave: () => {},
      flushSave: async () => {},
      waitForStartupTitleWork: async () => {},
      refreshSessionTitle: () => {
        throw new Error('unexpected refreshSessionTitle')
      },
      cancelAllTitleRefreshes: () => {},
      flushScheduledTitleRefreshes: async () => {},
      waitForTitleRefreshIdle: async () => {},
      waitForTitleRefreshQuiescence: async () => {},
      restoreSessionTitle: async () => false,
      showToast: async () => {},
      summarizeForTool: async () => ({
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        apiCost: 0,
        assistantMessages: 0,
        sessionCount: 0,
        providers: {},
      }),
      getQuotaSnapshots: async () => [],
      renderMarkdownReport: () => '',
      renderToastMessage: () => '',
      summarizeHistoryForTool: async (period, since) =>
        emptyHistory(period, since),
      renderHistoryMarkdownReport: () => '',
      config: {
        sidebar: { showCost: true, width: 36, includeChildren: true },
        sidebarEnabled: false,
      },
    })

    const result = await toolset.quota_show.execute({ enabled: true }, {
      sessionID: 's1',
    } as never)

    assert.equal(titleEnabled, false)
    assert.match(result, /cannot be enabled/i)
  })
})
