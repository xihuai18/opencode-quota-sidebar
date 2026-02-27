import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { afterEach } from 'node:test'

import { createQuotaService } from '../quota_service.js'
import { defaultState } from '../storage.js'
import type { QuotaSidebarConfig, QuotaSnapshot } from '../types.js'

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
      wrapQuotaLines: true,
      includeChildren: true,
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

describe('quota service', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    await Promise.all(
      tmpDirs
        .splice(0, tmpDirs.length)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    )
  })

  it('dedupes in-flight quota fetches by cacheKey', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const state = defaultState()
    const config = makeConfig()

    let calls = 0
    const quotaRuntime = {
      normalizeProviderID: (id: string) => id,
      resolveQuotaAdapter: (_id: string) => ({ id: 'openai' }),
      quotaCacheKey: (id: string) => id,
      fetchQuotaSnapshot: async (providerID: string) => {
        calls++
        await delay(50)
        const snapshot: QuotaSnapshot = {
          providerID,
          adapterID: 'openai',
          label: 'OpenAI Codex',
          shortLabel: 'OpenAI',
          sortOrder: 10,
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: 80 }],
        }
        return snapshot
      },
    }

    const service = createQuotaService({
      quotaRuntime,
      config,
      state,
      authPath,
      client: {
        auth: {
          set: async () => ({ data: { ok: true } }) as any,
        },
      } as any,
      directory: tmp,
      scheduleSave: () => {},
    })

    const [left, right] = await Promise.all([
      service.getQuotaSnapshots(['openai']),
      service.getQuotaSnapshots(['openai']),
    ])

    assert.equal(calls, 1)
    assert.equal(left.length, 1)
    assert.equal(right.length, 1)
    assert.equal(left[0].providerID, 'openai')
    assert.equal(right[0].providerID, 'openai')
  })

  it('only schedules save when quota cache changes', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const state = defaultState()
    const config = makeConfig()

    let scheduled = 0
    let calls = 0
    const quotaRuntime = {
      normalizeProviderID: (id: string) => id,
      resolveQuotaAdapter: (_id: string) => ({ id: 'openai' }),
      quotaCacheKey: (id: string) => id,
      fetchQuotaSnapshot: async (providerID: string) => {
        calls++
        const snapshot: QuotaSnapshot = {
          providerID,
          adapterID: 'openai',
          label: 'OpenAI Codex',
          shortLabel: 'OpenAI',
          sortOrder: 10,
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: 80 }],
        }
        return snapshot
      },
    }

    const service = createQuotaService({
      quotaRuntime,
      config,
      state,
      authPath,
      client: {
        auth: {
          set: async () => ({ data: { ok: true } }) as any,
        },
      } as any,
      directory: tmp,
      scheduleSave: () => {
        scheduled++
      },
    })

    const fresh: QuotaSnapshot = {
      providerID: 'openai',
      adapterID: 'openai',
      label: 'OpenAI Codex',
      shortLabel: 'OpenAI',
      sortOrder: 10,
      status: 'ok',
      checkedAt: Date.now(),
      windows: [{ label: '5h', remainingPercent: 80 }],
    }

    state.quotaCache['openai#none'] = fresh
    await service.getQuotaSnapshots(['openai'])
    assert.equal(calls, 0)
    assert.equal(scheduled, 0)

    const stale: QuotaSnapshot = { ...fresh, checkedAt: 0 }
    state.quotaCache['openai#none'] = stale
    await service.getQuotaSnapshots(['openai'])
    assert.equal(calls, 1)
    assert.equal(scheduled, 1)
  })
})
