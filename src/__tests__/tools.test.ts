import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createQuotaSidebarTools } from '../tools.js'

describe('quota_show tool', () => {
  it('redecorates visible titles when OFF rollback keeps display enabled', async () => {
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
      restoreAllVisibleTitles: async () => ({
        attempted: 2,
        restored: 1,
        listFailed: false,
      }),
      refreshAllTouchedTitles: async () => {
        refreshTouchedCalls++
      },
      refreshAllVisibleTitles: async () => {
        refreshVisibleCalls++
        return { attempted: 2, refreshed: 2, listFailed: false }
      },
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
      config: { sidebar: { showCost: true, width: 36, includeChildren: true } },
    })

    const result = await toolset.quota_show.execute(
      { enabled: false },
      { sessionID: 's1' } as never,
    )

    assert.equal(titleEnabled, true)
    assert.equal(refreshVisibleCalls, 1)
    assert.equal(refreshTouchedCalls, 1)
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
      restoreAllVisibleTitles: async () => ({ attempted: 0, restored: 0, listFailed: false }),
      refreshAllTouchedTitles: async () => {
        order.push('refreshTouched')
      },
      refreshAllVisibleTitles: async () => {
        order.push('refreshVisible')
        return { attempted: 0, refreshed: 0, listFailed: false }
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
      config: { sidebar: { showCost: true, width: 36, includeChildren: true } },
    })

    await toolset.quota_show.execute({ enabled: true }, { sessionID: 's1' } as never)

    assert.ok(order.indexOf('startupWait') < order.indexOf('set:on'))
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
      restoreAllVisibleTitles: async () => ({ attempted: 0, restored: 0, listFailed: false }),
      refreshAllTouchedTitles: async () => {},
      refreshAllVisibleTitles: async () => ({ attempted: 0, refreshed: 0, listFailed: false }),
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
      config: { sidebar: { showCost: true, width: 36, includeChildren: true } },
    })

    const result = await toolset.quota_show.execute({ enabled: true }, { sessionID: 's1' } as never)

    assert.equal(titleEnabled, true)
    assert.match(result, /now ON/)
    assert.ok(Date.now() - started < 3500)
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
      restoreAllVisibleTitles: async () => ({ attempted: 1, restored: 0, listFailed: false }),
      refreshAllTouchedTitles: async () => {},
      refreshAllVisibleTitles: async () => ({ attempted: 1, refreshed: 1, listFailed: false }),
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
      config: { sidebar: { showCost: true, width: 36, includeChildren: true } },
    })

    await toolset.quota_show.execute({ enabled: false }, { sessionID: 's1' } as never)

    assert.equal(titleEnabled, true)
    assert.equal(currentRefreshCalls, 1)
  })
})
