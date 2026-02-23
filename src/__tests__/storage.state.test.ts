import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  dateKeyFromTimestamp,
  defaultState,
  evictOldSessions,
  loadState,
  saveState,
  scanSessionsByCreatedRange,
  stateFilePath,
} from '../storage.js'
import type { QuotaSidebarState, SessionState } from '../types.js'

const tmpDirs: string[] = []

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-sidebar-test-'))
  tmpDirs.push(dir)
  return dir
}

function makeSession(createdAt: number, baseTitle = 'Session'): SessionState {
  return {
    createdAt,
    baseTitle,
    lastAppliedTitle: undefined,
  }
}

afterEach(async () => {
  await Promise.all(
    tmpDirs
      .splice(0, tmpDirs.length)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  )
})

describe('storage state persistence', () => {
  it('round-trips quotaCache windows through saveState/loadState', async () => {
    const dir = await makeTempDir()
    const statePath = stateFilePath(dir)
    const state = defaultState()

    state.quotaCache.openai = {
      providerID: 'openai',
      label: 'OpenAI Codex',
      status: 'ok',
      checkedAt: Date.now(),
      remainingPercent: 80,
      windows: [
        { label: '5h', remainingPercent: 80, usedPercent: 20 },
        { label: 'Weekly', remainingPercent: 70 },
      ],
    }

    await saveState(statePath, state, { writeAll: true })
    const loaded = await loadState(statePath)

    assert.ok(loaded.quotaCache.openai)
    assert.equal(loaded.quotaCache.openai.status, 'ok')
    assert.ok(loaded.quotaCache.openai.windows)
    assert.equal(loaded.quotaCache.openai.windows!.length, 2)
    assert.equal(loaded.quotaCache.openai.windows![0].label, '5h')
    assert.equal(loaded.quotaCache.openai.windows![1].label, 'Weekly')
  })

  it('skipChunks path does not write day chunk files', async () => {
    const dir = await makeTempDir()
    const statePath = stateFilePath(dir)
    const state = defaultState()

    const createdAt = Date.now()
    const dateKey = dateKeyFromTimestamp(createdAt)
    state.sessions.s1 = makeSession(createdAt, 'S1')
    state.sessionDateMap.s1 = dateKey

    await saveState(statePath, state, { dirtyDateKeys: [] })

    const chunkPath = path.join(
      dir,
      'quota-sidebar-sessions',
      dateKey.slice(0, 4),
      dateKey.slice(5, 7),
      `${dateKey.slice(8, 10)}.json`,
    )
    const stat = await fs.stat(chunkPath).catch(() => undefined)
    assert.equal(stat, undefined)
  })

  it('scanSessionsByCreatedRange combines memory and disk correctly', async () => {
    const dir = await makeTempDir()
    const statePath = stateFilePath(dir)

    const day1 = new Date(2026, 1, 20).getTime()
    const day2 = new Date(2026, 1, 21).getTime()

    const fullState: QuotaSidebarState = defaultState()
    fullState.sessions.s1 = makeSession(day1, 'S1')
    fullState.sessionDateMap.s1 = dateKeyFromTimestamp(day1)
    fullState.sessions.s2 = makeSession(day2, 'S2')
    fullState.sessionDateMap.s2 = dateKeyFromTimestamp(day2)

    await saveState(statePath, fullState, { writeAll: true })

    const memoryOnly = defaultState()
    memoryOnly.sessions.s1 = makeSession(day1, 'S1-memory')
    memoryOnly.sessionDateMap.s1 = dateKeyFromTimestamp(day1)

    const scanned = await scanSessionsByCreatedRange(
      statePath,
      new Date(2026, 1, 19).getTime(),
      new Date(2026, 1, 22).getTime(),
      memoryOnly,
    )

    const ids = scanned.map((item) => item.sessionID).sort()
    assert.deepEqual(ids, ['s1', 's2'])
    const s1 = scanned.find((item) => item.sessionID === 's1')
    assert.equal(s1?.state.baseTitle, 'S1-memory')
  })

  it('evictOldSessions removes sessions older than retention cutoff', () => {
    const state = defaultState()
    const now = Date.now()
    const oldCreatedAt = now - 800 * 24 * 60 * 60 * 1000
    const newCreatedAt = now - 10 * 24 * 60 * 60 * 1000

    state.sessions.old = makeSession(oldCreatedAt, 'old')
    state.sessionDateMap.old = dateKeyFromTimestamp(oldCreatedAt)
    state.sessions.new = makeSession(newCreatedAt, 'new')
    state.sessionDateMap.new = dateKeyFromTimestamp(newCreatedAt)

    const evicted = evictOldSessions(state, 730)
    assert.equal(evicted, 1)
    assert.equal(state.sessions.old, undefined)
    assert.ok(state.sessions.new)
  })
})
