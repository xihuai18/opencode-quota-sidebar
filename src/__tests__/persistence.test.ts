import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createPersistenceScheduler } from '../persistence.js'

describe('persistence scheduler', () => {
  it('persists state even when no date keys are dirty', async () => {
    const calls: Array<{ dirtyDateKeys: string[] }> = []
    const state = { value: 1 }

    const scheduler = createPersistenceScheduler({
      statePath: '/tmp/state.json',
      state,
      saveState: async (_path, _state, options) => {
        calls.push({ dirtyDateKeys: options.dirtyDateKeys })
      },
    })

    scheduler.scheduleSave()
    await scheduler.flushSave()

    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].dirtyDateKeys, [])
  })

  it('captures dirty date keys and passes them to saveState', async () => {
    const calls: Array<{ dirtyDateKeys: string[] }> = []
    const state = { value: 1 }

    const scheduler = createPersistenceScheduler({
      statePath: '/tmp/state.json',
      state,
      saveState: async (_path, _state, options) => {
        calls.push({ dirtyDateKeys: options.dirtyDateKeys })
      },
    })

    scheduler.markDirty('2026-02-25')
    scheduler.scheduleSave()
    await scheduler.flushSave()

    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].dirtyDateKeys, ['2026-02-25'])
  })
})
