import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createTitleRefreshScheduler } from '../title_refresh.js'

describe('title refresh scheduler', () => {
  it('flushes scheduled refreshes before waiting for idle', async () => {
    const applied: string[] = []
    const scheduler = createTitleRefreshScheduler({
      apply: async (sessionID: string) => {
        applied.push(sessionID)
      },
    })

    scheduler.schedule('s1', 10_000)
    await scheduler.flushScheduled()
    await scheduler.waitForIdle()

    assert.deepEqual(applied, ['s1'])
  })
})
