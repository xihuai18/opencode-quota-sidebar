import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createQuotaSidebarTools } from '../tools.js'

describe('quota_show tool', () => {
  it('redecorates visible titles when OFF rollback keeps display enabled', async () => {
    let titleEnabled = true
    let refreshVisibleCalls = 0
    const toolset = createQuotaSidebarTools({
      getTitleEnabled: () => titleEnabled,
      setTitleEnabled: (enabled) => {
        titleEnabled = enabled
      },
      scheduleSave: () => {},
      flushSave: async () => {},
      refreshSessionTitle: () => {},
      cancelAllTitleRefreshes: () => {},
      flushScheduledTitleRefreshes: async () => {},
      waitForTitleRefreshIdle: async () => {},
      restoreAllVisibleTitles: async () => ({
        attempted: 2,
        restored: 1,
        listFailed: false,
      }),
      refreshAllTouchedTitles: async () => {},
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
    assert.match(result, /remains ON/)
  })
})
