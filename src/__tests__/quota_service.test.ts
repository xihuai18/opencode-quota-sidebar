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

function makeConfig(
  overrides: Partial<QuotaSidebarConfig['quota']> = {},
): QuotaSidebarConfig {
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
      ...overrides,
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

  it('keeps zero-quota cache only for a short ttl', async () => {
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
        const snapshot: QuotaSnapshot = {
          providerID,
          adapterID: 'openai',
          label: 'OpenAI Codex',
          shortLabel: 'OpenAI',
          sortOrder: 10,
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: 42 }],
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

    state.quotaCache['openai#none'] = {
      providerID: 'openai',
      adapterID: 'openai',
      label: 'OpenAI Codex',
      shortLabel: 'OpenAI',
      sortOrder: 10,
      status: 'ok',
      checkedAt: Date.now() - 20_000,
      windows: [{ label: '5h', remainingPercent: 0 }],
    }

    const snapshots = await service.getQuotaSnapshots(['openai'])

    assert.equal(calls, 1)
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0].windows?.[0]?.remainingPercent, 42)
  })

  it('refreshes quota cache immediately after reset time passes', async () => {
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
        const snapshot: QuotaSnapshot = {
          providerID,
          adapterID: 'openai',
          label: 'OpenAI Codex',
          shortLabel: 'OpenAI',
          sortOrder: 10,
          status: 'ok',
          checkedAt: Date.now(),
          windows: [
            {
              label: '5h',
              remainingPercent: 65,
              resetAt: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
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

    state.quotaCache['openai#none'] = {
      providerID: 'openai',
      adapterID: 'openai',
      label: 'OpenAI Codex',
      shortLabel: 'OpenAI',
      sortOrder: 10,
      status: 'ok',
      checkedAt: Date.now(),
      windows: [
        {
          label: '5h',
          remainingPercent: 0,
          resetAt: new Date(Date.now() - 1_000).toISOString(),
        },
      ],
    }

    const snapshots = await service.getQuotaSnapshots(['openai'])

    assert.equal(calls, 1)
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0].windows?.[0]?.remainingPercent, 65)
  })

  it('does not reuse cache when reset has passed even at zero age', async () => {
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
        const snapshot: QuotaSnapshot = {
          providerID,
          adapterID: 'openai',
          label: 'OpenAI Codex',
          shortLabel: 'OpenAI',
          sortOrder: 10,
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: 70 }],
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

    const fixedNow = Date.now()
    state.quotaCache['openai#none'] = {
      providerID: 'openai',
      adapterID: 'openai',
      label: 'OpenAI Codex',
      shortLabel: 'OpenAI',
      sortOrder: 10,
      status: 'ok',
      checkedAt: fixedNow,
      windows: [
        {
          label: '5h',
          remainingPercent: 0,
          resetAt: new Date(fixedNow - 1_000).toISOString(),
        },
      ],
    }

    const realNow = Date.now
    Date.now = () => fixedNow
    try {
      const snapshots = await service.getQuotaSnapshots(['openai'])
      assert.equal(calls, 1)
      assert.equal(snapshots.length, 1)
      assert.equal(snapshots[0].windows?.[0]?.remainingPercent, 70)
    } finally {
      Date.now = realNow
    }
  })

  it('refreshes error snapshots on a short ttl instead of full quota ttl', async () => {
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
        const snapshot: QuotaSnapshot = {
          providerID,
          adapterID: 'openai',
          label: 'OpenAI Codex',
          shortLabel: 'OpenAI',
          sortOrder: 10,
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: 77 }],
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

    state.quotaCache['openai#none'] = {
      providerID: 'openai',
      adapterID: 'openai',
      label: 'OpenAI Codex',
      shortLabel: 'OpenAI',
      sortOrder: 10,
      status: 'error',
      checkedAt: Date.now() - 31_000,
      note: 'network request failed',
    }

    const snapshots = await service.getQuotaSnapshots(['openai'])

    assert.equal(calls, 1)
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0].status, 'ok')
  })

  it('reuses a recent ok snapshot as stale after a transient quota error', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const state = defaultState()
    const config = makeConfig({ refreshMs: 60_000 })

    let scheduled = 0
    const quotaRuntime = {
      normalizeProviderID: (id: string) => id,
      resolveQuotaAdapter: (_id: string) => ({ id: 'anthropic' }),
      quotaCacheKey: (id: string) => id,
      fetchQuotaSnapshot: async (providerID: string) => {
        const snapshot: QuotaSnapshot = {
          providerID,
          adapterID: 'anthropic',
          label: 'Anthropic',
          shortLabel: 'Anthropic',
          sortOrder: 30,
          status: 'error',
          checkedAt: Date.now(),
          note: 'timeout',
        }
        return snapshot
      },
    }

    state.quotaCache['anthropic#none'] = {
      providerID: 'anthropic',
      adapterID: 'anthropic',
      label: 'Anthropic',
      shortLabel: 'Anthropic',
      sortOrder: 30,
      status: 'ok',
      checkedAt: Date.now() - 70_000,
      windows: [{ label: '5h', remainingPercent: 81 }],
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

    const snapshots = await service.getQuotaSnapshots(['anthropic'])

    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0].status, 'ok')
    assert.equal(snapshots[0].windows?.[0]?.remainingPercent, 81)
    assert.equal(snapshots[0].stale?.staleReason, 'timeout')
    assert.equal(snapshots[0].stale?.staleReasonKind, 'timeout')
    assert.equal(scheduled, 1)
  })

  it('does not reuse stale quota for auth failures', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const state = defaultState()
    const config = makeConfig({ refreshMs: 60_000 })

    const quotaRuntime = {
      normalizeProviderID: (id: string) => id,
      resolveQuotaAdapter: (_id: string) => ({ id: 'anthropic' }),
      quotaCacheKey: (id: string) => id,
      fetchQuotaSnapshot: async (providerID: string) => {
        const snapshot: QuotaSnapshot = {
          providerID,
          adapterID: 'anthropic',
          label: 'Anthropic',
          shortLabel: 'Anthropic',
          sortOrder: 30,
          status: 'error',
          checkedAt: Date.now(),
          note: 'http 401',
        }
        return snapshot
      },
    }

    state.quotaCache['anthropic#none'] = {
      providerID: 'anthropic',
      adapterID: 'anthropic',
      label: 'Anthropic',
      shortLabel: 'Anthropic',
      sortOrder: 30,
      status: 'ok',
      checkedAt: Date.now() - 70_000,
      windows: [{ label: '5h', remainingPercent: 81 }],
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

    const snapshots = await service.getQuotaSnapshots(['anthropic'])

    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0].status, 'error')
    assert.equal(snapshots[0].stale, undefined)
    assert.equal(snapshots[0].note, 'http 401')
  })

  it('uses tighter ttl tiers when quota is low', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const config = makeConfig({ refreshMs: 60_000 })

    let calls = 0
    const quotaRuntime = {
      normalizeProviderID: (id: string) => id,
      resolveQuotaAdapter: (_id: string) => ({ id: 'openai' }),
      quotaCacheKey: (id: string) => id,
      fetchQuotaSnapshot: async (providerID: string) => {
        calls++
        return {
          providerID,
          adapterID: 'openai',
          label: 'OpenAI Codex',
          shortLabel: 'OpenAI',
          sortOrder: 10,
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: 50 }],
        } satisfies QuotaSnapshot
      },
    }

    const lowState = defaultState()
    lowState.quotaCache['openai#none'] = {
      providerID: 'openai',
      adapterID: 'openai',
      label: 'OpenAI Codex',
      shortLabel: 'OpenAI',
      sortOrder: 10,
      status: 'ok',
      checkedAt: Date.now() - 21_000,
      windows: [{ label: '5h', remainingPercent: 4 }],
    }

    const lowService = createQuotaService({
      quotaRuntime,
      config,
      state: lowState,
      authPath,
      client: {
        auth: {
          set: async () => ({ data: { ok: true } }) as any,
        },
      } as any,
      directory: tmp,
      scheduleSave: () => {},
    })

    await lowService.getQuotaSnapshots(['openai'])
    assert.equal(calls, 1)

    const moderateState = defaultState()
    moderateState.quotaCache['openai#none'] = {
      providerID: 'openai',
      adapterID: 'openai',
      label: 'OpenAI Codex',
      shortLabel: 'OpenAI',
      sortOrder: 10,
      status: 'ok',
      checkedAt: Date.now() - 46_000,
      windows: [{ label: '5h', remainingPercent: 25 }],
    }

    const moderateService = createQuotaService({
      quotaRuntime,
      config,
      state: moderateState,
      authPath,
      client: {
        auth: {
          set: async () => ({ data: { ok: true } }) as any,
        },
      } as any,
      directory: tmp,
      scheduleSave: () => {},
    })

    await moderateService.getQuotaSnapshots(['openai'])
    assert.equal(calls, 2)
  })

  it('invalidates matching provider cache entries after usage updates', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const state = defaultState()
    const config = makeConfig({ refreshMs: 60_000 })

    let calls = 0
    const quotaRuntime = {
      normalizeProviderID: (id: string) => id,
      resolveQuotaAdapter: (_id: string) => ({ id: 'anthropic' }),
      quotaCacheKey: (id: string) => id,
      fetchQuotaSnapshot: async (providerID: string) => {
        calls++
        return {
          providerID,
          adapterID: 'anthropic',
          label: 'Anthropic',
          shortLabel: 'Anthropic',
          sortOrder: 30,
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: 67 }],
        } satisfies QuotaSnapshot
      },
    }

    state.quotaCache['anthropic#none'] = {
      providerID: 'anthropic',
      adapterID: 'anthropic',
      label: 'Anthropic',
      shortLabel: 'Anthropic',
      sortOrder: 30,
      status: 'ok',
      checkedAt: Date.now(),
      windows: [{ label: '5h', remainingPercent: 81 }],
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

    const before = await service.getQuotaSnapshots(['anthropic'])
    assert.equal(before[0].windows?.[0]?.remainingPercent, 81)
    assert.equal(calls, 0)

    service.invalidateForProvider('anthropic')
    const after = await service.getQuotaSnapshots(['anthropic'])

    assert.equal(calls, 1)
    assert.equal(after[0].windows?.[0]?.remainingPercent, 67)
  })

  it('uses staleAt to throttle retries for stale snapshots', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const state = defaultState()
    const config = makeConfig({ refreshMs: 60_000 })

    let calls = 0
    const quotaRuntime = {
      normalizeProviderID: (id: string) => id,
      resolveQuotaAdapter: (_id: string) => ({ id: 'anthropic' }),
      quotaCacheKey: (id: string) => id,
      fetchQuotaSnapshot: async (providerID: string) => {
        calls++
        return {
          providerID,
          adapterID: 'anthropic',
          label: 'Anthropic',
          shortLabel: 'Anthropic',
          sortOrder: 30,
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: 67 }],
        } satisfies QuotaSnapshot
      },
    }

    state.quotaCache['anthropic#none'] = {
      providerID: 'anthropic',
      adapterID: 'anthropic',
      label: 'Anthropic',
      shortLabel: 'Anthropic',
      sortOrder: 30,
      status: 'ok',
      checkedAt: Date.now() - 70_000,
      stale: {
        staleAt: Date.now() - 5_000,
        staleReason: 'timeout',
        staleReasonKind: 'timeout',
      },
      windows: [{ label: '5h', remainingPercent: 81 }],
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

    const snapshots = await service.getQuotaSnapshots(['anthropic'])

    assert.equal(calls, 0)
    assert.equal(snapshots[0].windows?.[0]?.remainingPercent, 81)
    assert.equal(snapshots[0].stale?.staleReason, 'timeout')
  })

  it('refreshes staleAt after a new transient fallback so retries stay throttled', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const state = defaultState()
    const config = makeConfig({ refreshMs: 60_000 })

    let calls = 0
    const quotaRuntime = {
      normalizeProviderID: (id: string) => id,
      resolveQuotaAdapter: (_id: string) => ({ id: 'anthropic' }),
      quotaCacheKey: (id: string) => id,
      fetchQuotaSnapshot: async (providerID: string) => {
        calls++
        return {
          providerID,
          adapterID: 'anthropic',
          label: 'Anthropic',
          shortLabel: 'Anthropic',
          sortOrder: 30,
          status: 'error',
          checkedAt: Date.now(),
          note: 'timeout',
        } satisfies QuotaSnapshot
      },
    }

    state.quotaCache['anthropic#none'] = {
      providerID: 'anthropic',
      adapterID: 'anthropic',
      label: 'Anthropic',
      shortLabel: 'Anthropic',
      sortOrder: 30,
      status: 'ok',
      checkedAt: Date.now() - 70_000,
      stale: {
        staleAt: Date.now() - 16_000,
        staleReason: 'timeout',
        staleReasonKind: 'timeout',
      },
      windows: [{ label: '5h', remainingPercent: 81 }],
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

    const first = await service.getQuotaSnapshots(['anthropic'])
    const refreshedStaleAt = first[0].stale?.staleAt
    assert.equal(calls, 1)
    assert.ok(typeof refreshedStaleAt === 'number')

    const second = await service.getQuotaSnapshots(['anthropic'])

    assert.equal(calls, 1)
    assert.equal(second[0].stale?.staleAt, refreshedStaleAt)
  })

  it('starts a fresh fetch when invalidation lands during an older in-flight request', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const state = defaultState()
    const config = makeConfig({ refreshMs: 60_000 })

    let calls = 0
    const quotaRuntime = {
      normalizeProviderID: (id: string) => id,
      resolveQuotaAdapter: (_id: string) => ({ id: 'anthropic' }),
      quotaCacheKey: (id: string) => id,
      fetchQuotaSnapshot: async (providerID: string) => {
        const attempt = ++calls
        await delay(80)
        return {
          providerID,
          adapterID: 'anthropic',
          label: 'Anthropic',
          shortLabel: 'Anthropic',
          sortOrder: 30,
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: attempt === 1 ? 80 : 67 }],
        } satisfies QuotaSnapshot
      },
    }

    state.quotaCache['anthropic#none'] = {
      providerID: 'anthropic',
      adapterID: 'anthropic',
      label: 'Anthropic',
      shortLabel: 'Anthropic',
      sortOrder: 30,
      status: 'ok',
      checkedAt: Date.now() - 70_000,
      windows: [{ label: '5h', remainingPercent: 81 }],
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

    const first = service.getQuotaSnapshots(['anthropic'])
    await delay(20)
    service.invalidateForProvider('anthropic')
    const second = service.getQuotaSnapshots(['anthropic'])

    const [firstSnapshots, secondSnapshots] = await Promise.all([first, second])

    assert.equal(calls, 2)
    assert.equal(firstSnapshots[0].windows?.[0]?.remainingPercent, 80)
    assert.equal(secondSnapshots[0].windows?.[0]?.remainingPercent, 67)
  })

  it('records invalidation for providers that only exist in flight', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const config = makeConfig({ refreshMs: 60_000 })

    let calls = 0
    const quotaRuntime = {
      normalizeProviderID: (id: string) => id,
      resolveQuotaAdapter: (_id: string) => ({ id: 'anthropic' }),
      quotaCacheKey: (id: string) => id,
      fetchQuotaSnapshot: async (providerID: string) => {
        const attempt = ++calls
        await delay(80)
        return {
          providerID,
          adapterID: 'anthropic',
          label: 'Anthropic',
          shortLabel: 'Anthropic',
          sortOrder: 30,
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: attempt === 1 ? 80 : 67 }],
        } satisfies QuotaSnapshot
      },
    }

    const service = createQuotaService({
      quotaRuntime,
      config,
      state: defaultState(),
      authPath,
      client: {
        auth: {
          set: async () => ({ data: { ok: true } }) as any,
        },
      } as any,
      directory: tmp,
      scheduleSave: () => {},
    })

    const first = service.getQuotaSnapshots(['anthropic'])
    await delay(20)
    service.invalidateForProvider('anthropic')
    const second = service.getQuotaSnapshots(['anthropic'])

    const [firstSnapshots, secondSnapshots] = await Promise.all([first, second])

    assert.equal(calls, 2)
    assert.equal(firstSnapshots[0].windows?.[0]?.remainingPercent, 80)
    assert.equal(secondSnapshots[0].windows?.[0]?.remainingPercent, 67)
  })

  it('does not let an invalidated in-flight fetch overwrite cache before replacement starts', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const state = defaultState()
    const config = makeConfig({ refreshMs: 60_000 })

    let calls = 0
    const quotaRuntime = {
      normalizeProviderID: (id: string) => id,
      resolveQuotaAdapter: (_id: string) => ({ id: 'anthropic' }),
      quotaCacheKey: (id: string) => id,
      fetchQuotaSnapshot: async (providerID: string) => {
        const attempt = ++calls
        await delay(80)
        return {
          providerID,
          adapterID: 'anthropic',
          label: 'Anthropic',
          shortLabel: 'Anthropic',
          sortOrder: 30,
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: attempt === 1 ? 80 : 67 }],
        } satisfies QuotaSnapshot
      },
    }

    state.quotaCache['anthropic#none'] = {
      providerID: 'anthropic',
      adapterID: 'anthropic',
      label: 'Anthropic',
      shortLabel: 'Anthropic',
      sortOrder: 30,
      status: 'ok',
      checkedAt: Date.now() - 70_000,
      windows: [{ label: '5h', remainingPercent: 81 }],
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

    const first = service.getQuotaSnapshots(['anthropic'])
    await delay(20)
    service.invalidateForProvider('anthropic')

    const firstSnapshots = await first

    assert.equal(calls, 1)
    assert.equal(firstSnapshots[0].windows?.[0]?.remainingPercent, 80)
    assert.equal(
      state.quotaCache['anthropic#none']?.windows?.[0]?.remainingPercent,
      81,
    )

    const secondSnapshots = await service.getQuotaSnapshots(['anthropic'])

    assert.equal(calls, 2)
    assert.equal(secondSnapshots[0].windows?.[0]?.remainingPercent, 67)
    assert.equal(
      state.quotaCache['anthropic#none']?.windows?.[0]?.remainingPercent,
      67,
    )
  })

  it('invalidates legacy anthropic unsupported cache entries', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(
      authPath,
      JSON.stringify({ anthropic: { type: 'oauth', access: 'token' } }),
      'utf8',
    )

    const state = defaultState()
    const config = makeConfig()

    let calls = 0
    let scheduled = 0
    const quotaRuntime = {
      normalizeProviderID: (id: string) => id,
      resolveQuotaAdapter: (_id: string) => ({ id: 'anthropic' }),
      quotaCacheKey: (id: string) => id,
      fetchQuotaSnapshot: async (providerID: string) => {
        calls++
        const snapshot: QuotaSnapshot = {
          providerID,
          adapterID: 'anthropic',
          label: 'Anthropic',
          shortLabel: 'Anthropic',
          sortOrder: 30,
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: 80 }],
        }
        return snapshot
      },
    }

    state.quotaCache['anthropic#anthropic'] = {
      providerID: 'anthropic',
      adapterID: 'anthropic',
      label: 'Anthropic',
      shortLabel: 'Anthropic',
      sortOrder: 30,
      status: 'unsupported',
      checkedAt: Date.now(),
      note: 'oauth quota endpoint is not publicly documented',
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

    const snapshots = await service.getQuotaSnapshots(['anthropic'])

    assert.equal(calls, 1)
    assert.equal(scheduled, 1)
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0].status, 'ok')
  })

  it('falls back to provider.list when config.providers is unavailable', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const state = defaultState()
    const config = makeConfig()

    let calls = 0
    const quotaRuntime = {
      normalizeProviderID: (id: string) => id,
      resolveQuotaAdapter: (_id: string, opts?: Record<string, unknown>) =>
        typeof opts?.baseURL === 'string' ? { id: 'rightcode' } : undefined,
      quotaCacheKey: (id: string, opts?: Record<string, unknown>) =>
        `${id}@${String(opts?.baseURL || '')}`,
      fetchQuotaSnapshot: async (providerID: string) => {
        calls++
        const snapshot: QuotaSnapshot = {
          providerID,
          adapterID: 'rightcode',
          label: 'RightCode',
          shortLabel: 'RC',
          sortOrder: 30,
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: 'Daily', remainingPercent: 80 }],
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
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: 'rightcode-openai',
                  options: {
                    baseURL: 'https://www.right.codes/codex/v1',
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: tmp,
      scheduleSave: () => {},
    })

    const snapshots = await service.getQuotaSnapshots([], {
      allowDefault: true,
    })

    assert.equal(calls, 1)
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0].providerID, 'rightcode-openai')
  })

  it('prefers config.providers when both provider discovery clients exist', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const state = defaultState()
    const config = makeConfig()

    let calls = 0
    let providerListCalls = 0
    const quotaRuntime = {
      normalizeProviderID: (id: string) => id,
      resolveQuotaAdapter: (_id: string, opts?: Record<string, unknown>) =>
        typeof opts?.baseURL === 'string' ? { id: 'rightcode' } : undefined,
      quotaCacheKey: (id: string, opts?: Record<string, unknown>) =>
        `${id}@${String(opts?.baseURL || '')}`,
      fetchQuotaSnapshot: async (providerID: string) => {
        calls++
        const snapshot: QuotaSnapshot = {
          providerID,
          adapterID: 'rightcode',
          label: 'RightCode',
          shortLabel: 'RC',
          sortOrder: 30,
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: 'Daily', remainingPercent: 80 }],
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
        config: {
          providers: async () => ({
            data: {
              providers: [
                {
                  id: 'rightcode-openai',
                  options: {
                    baseURL: 'https://www.right.codes/codex/v1',
                  },
                },
              ],
            },
          }),
        },
        provider: {
          list: async () => {
            providerListCalls++
            return { data: { all: [] } }
          },
        },
      } as any,
      directory: tmp,
      scheduleSave: () => {},
    })

    const snapshots = await service.getQuotaSnapshots([], {
      allowDefault: true,
    })

    assert.equal(calls, 1)
    assert.equal(providerListCalls, 0)
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0].providerID, 'rightcode-openai')
  })

  it('falls back to provider.list when config.providers exists but fails', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const state = defaultState()
    const config = makeConfig()

    let providerListCalls = 0
    let fetchCalls = 0
    const service = createQuotaService({
      quotaRuntime: {
        normalizeProviderID: (id: string) => id,
        resolveQuotaAdapter: (_id: string, opts?: Record<string, unknown>) =>
          opts?.baseURL ? { id: 'rightcode' } : undefined,
        quotaCacheKey: (id: string) => id,
        fetchQuotaSnapshot: async (providerID: string) => {
          fetchCalls++
          return {
            providerID,
            adapterID: 'rightcode',
            label: 'RightCode',
            shortLabel: 'RC',
            sortOrder: 10,
            status: 'ok',
            checkedAt: Date.now(),
            balance: { amount: 1, currency: '$' },
          }
        },
      },
      config,
      state,
      authPath,
      client: {
        auth: { set: async () => ({ data: { ok: true } }) as any },
        config: {
          providers: async () => {
            throw new Error('config.providers failed')
          },
        },
        provider: {
          list: async () => {
            providerListCalls++
            return {
              data: {
                all: [
                  {
                    id: 'rightcode-openai',
                    options: { baseURL: 'https://www.right.codes/codex/v1' },
                  },
                ],
              },
            }
          },
        },
      } as any,
      directory: tmp,
      scheduleSave: () => {},
    })

    const snapshots = await service.getQuotaSnapshots([], {
      allowDefault: true,
    })

    assert.equal(providerListCalls, 1)
    assert.equal(fetchCalls, 1)
    assert.equal(snapshots.length, 1)
  })

  it('falls back to provider.list when config.providers returns malformed data', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const state = defaultState()
    const config = makeConfig()

    let providerListCalls = 0
    let fetchCalls = 0
    const service = createQuotaService({
      quotaRuntime: {
        normalizeProviderID: (id: string) => id,
        resolveQuotaAdapter: (_id: string, opts?: Record<string, unknown>) =>
          opts?.baseURL ? { id: 'rightcode' } : undefined,
        quotaCacheKey: (id: string) => id,
        fetchQuotaSnapshot: async (providerID: string) => {
          fetchCalls++
          return {
            providerID,
            adapterID: 'rightcode',
            label: 'RightCode',
            shortLabel: 'RC',
            sortOrder: 10,
            status: 'ok',
            checkedAt: Date.now(),
            balance: { amount: 1, currency: '$' },
          }
        },
      },
      config,
      state,
      authPath,
      client: {
        auth: { set: async () => ({ data: { ok: true } }) as any },
        config: {
          providers: async () => ({ data: {} }),
        },
        provider: {
          list: async () => {
            providerListCalls++
            return {
              data: {
                all: [
                  {
                    id: 'rightcode-openai',
                    options: { baseURL: 'https://www.right.codes/codex/v1' },
                  },
                ],
              },
            }
          },
        },
      } as any,
      directory: tmp,
      scheduleSave: () => {},
    })

    const snapshots = await service.getQuotaSnapshots([], {
      allowDefault: true,
    })

    assert.equal(providerListCalls, 1)
    assert.equal(fetchCalls, 1)
    assert.equal(snapshots.length, 1)
  })

  it('does not dedupe distinct provider options that share a base quota key', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const state = defaultState()
    const config = makeConfig()

    const calls: string[] = []
    const quotaRuntime = {
      normalizeProviderID: (id: string) => id,
      resolveQuotaAdapter: (id: string, _opts?: Record<string, unknown>) =>
        id.startsWith('rc-') ? { id: 'rightcode' } : undefined,
      quotaCacheKey: (_id: string, opts?: Record<string, unknown>) =>
        `rightcode@${String(opts?.baseURL || '')}`,
      fetchQuotaSnapshot: async (
        providerID: string,
        _authMap: Record<string, unknown>,
        _cfg: unknown,
        _updateAuth: unknown,
        providerOptions?: Record<string, unknown>,
      ) => {
        calls.push(`${providerID}:${String(providerOptions?.apiKey || '')}`)
        const snapshot: QuotaSnapshot = {
          providerID,
          adapterID: 'rightcode',
          label: providerID,
          shortLabel: providerID,
          sortOrder: 30,
          status: 'ok',
          checkedAt: Date.now(),
          balance: { amount: 1, currency: 'USD' },
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
        config: {
          providers: async () => ({
            data: {
              providers: [
                {
                  id: 'rc-a',
                  options: {
                    baseURL: 'https://www.right.codes/codex/v1',
                    apiKey: 'key-a',
                  },
                },
                {
                  id: 'rc-b',
                  options: {
                    baseURL: 'https://www.right.codes/codex/v1',
                    apiKey: 'key-b',
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: tmp,
      scheduleSave: () => {},
    })

    const snapshots = await service.getQuotaSnapshots([], {
      allowDefault: true,
    })

    assert.equal(snapshots.length, 2)
    assert.deepEqual(calls.sort(), ['rc-a:key-a', 'rc-b:key-b'])
    const matchingKeys = Object.keys(state.quotaCache).filter((key) =>
      key.startsWith('rightcode@https://www.right.codes/codex/v1#options@'),
    )
    assert.equal(matchingKeys.length, 2)
  })

  it('does not cache provider discovery failures as empty options', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const state = defaultState()
    const config = makeConfig()

    let providerCalls = 0
    let fetchCalls = 0
    const service = createQuotaService({
      quotaRuntime: {
        normalizeProviderID: (id: string) => id,
        resolveQuotaAdapter: (_id: string, opts?: Record<string, unknown>) =>
          opts?.baseURL ? { id: 'rightcode' } : undefined,
        quotaCacheKey: (id: string) => id,
        fetchQuotaSnapshot: async (providerID: string) => {
          fetchCalls++
          return {
            providerID,
            adapterID: 'rightcode',
            label: 'RightCode',
            shortLabel: 'RC',
            sortOrder: 10,
            status: 'ok',
            checkedAt: Date.now(),
            balance: { amount: 1, currency: '$' },
          }
        },
      },
      config,
      state,
      authPath,
      client: {
        auth: {
          set: async () => ({ data: { ok: true } }) as any,
        },
        config: {
          providers: async () => {
            providerCalls++
            if (providerCalls === 1)
              throw new Error('temporary discovery failure')
            return {
              data: {
                providers: [
                  {
                    id: 'rightcode-openai',
                    options: { baseURL: 'https://www.right.codes/codex/v1' },
                  },
                ],
              },
            }
          },
        },
      } as any,
      directory: tmp,
      scheduleSave: () => {},
    })

    const first = await service.getQuotaSnapshots([], { allowDefault: true })
    await new Promise((resolve) => setTimeout(resolve, 5_100))
    const second = await service.getQuotaSnapshots([], { allowDefault: true })

    assert.equal(first.length, 0)
    assert.equal(second.length, 1)
    assert.equal(fetchCalls, 1)
  })

  it('reuses last successful provider options when later discovery returns no data field', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const state = defaultState()
    const config = makeConfig()

    let configCalls = 0
    let fetchCalls = 0
    const service = createQuotaService({
      quotaRuntime: {
        normalizeProviderID: (id: string) => id,
        resolveQuotaAdapter: (_id: string, opts?: Record<string, unknown>) =>
          opts?.baseURL ? { id: 'rightcode' } : undefined,
        quotaCacheKey: (id: string) => id,
        fetchQuotaSnapshot: async (providerID: string) => {
          fetchCalls++
          return {
            providerID,
            adapterID: 'rightcode',
            label: 'RightCode',
            shortLabel: 'RC',
            sortOrder: 10,
            status: 'ok',
            checkedAt: Date.now(),
            balance: { amount: 1, currency: '$' },
          }
        },
      },
      config,
      state,
      authPath,
      client: {
        auth: { set: async () => ({ data: { ok: true } }) as any },
        config: {
          providers: async () => {
            configCalls++
            if (configCalls === 1) {
              return {
                data: {
                  providers: [
                    {
                      id: 'rightcode-openai',
                      options: { baseURL: 'https://www.right.codes/codex/v1' },
                    },
                  ],
                },
              }
            }
            return {} as any
          },
        },
      } as any,
      directory: tmp,
      scheduleSave: () => {},
    })

    const first = await service.getQuotaSnapshots([], { allowDefault: true })
    const second = await service.getQuotaSnapshots([], { allowDefault: true })

    assert.equal(first.length, 1)
    assert.equal(second.length, 1)
    assert.ok(fetchCalls >= 1)
  })

  it('accepts provider discovery responses where data itself is an array', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const state = defaultState()
    const config = makeConfig()

    let fetchCalls = 0
    const service = createQuotaService({
      quotaRuntime: {
        normalizeProviderID: (id: string) => id,
        resolveQuotaAdapter: (_id: string, opts?: Record<string, unknown>) =>
          opts?.baseURL ? { id: 'rightcode' } : undefined,
        quotaCacheKey: (id: string) => id,
        fetchQuotaSnapshot: async (providerID: string) => {
          fetchCalls++
          return {
            providerID,
            adapterID: 'rightcode',
            label: 'RightCode',
            shortLabel: 'RC',
            sortOrder: 10,
            status: 'ok',
            checkedAt: Date.now(),
            balance: { amount: 1, currency: '$' },
          }
        },
      },
      config,
      state,
      authPath,
      client: {
        auth: {
          set: async () => ({ data: { ok: true } }) as any,
        },
        provider: {
          list: async () => ({
            data: [
              {
                id: 'rightcode-openai',
                options: { baseURL: 'https://www.right.codes/codex/v1' },
              },
            ],
          }),
        },
      } as any,
      directory: tmp,
      scheduleSave: () => {},
    })

    const snapshots = await service.getQuotaSnapshots([], {
      allowDefault: true,
    })

    assert.equal(snapshots.length, 1)
    assert.equal(fetchCalls, 1)
  })

  it('injects provider key into providerOptions for env-backed built-in providers', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-service-'))
    tmpDirs.push(tmp)
    const authPath = path.join(tmp, 'auth.json')
    await fs.writeFile(authPath, '{}\n', 'utf8')

    const state = defaultState()
    const config = makeConfig()
    const calls: Array<Record<string, unknown> | undefined> = []
    const quotaRuntime = {
      normalizeProviderID: (id: string) => id,
      resolveQuotaAdapter: (id: string) =>
        id === 'kimi-for-coding' ? { id: 'kimi-for-coding' } : undefined,
      quotaCacheKey: (id: string) => id,
      fetchQuotaSnapshot: async (
        providerID: string,
        _authMap: unknown,
        _config: unknown,
        _updateAuth: unknown,
        providerOptions?: Record<string, unknown>,
      ) => {
        calls.push(providerOptions)
        return {
          providerID,
          adapterID: 'kimi-for-coding',
          label: 'Kimi For Coding',
          shortLabel: 'Kimi',
          sortOrder: 15,
          status: 'ok',
          checkedAt: Date.now(),
          windows: [{ label: '5h', remainingPercent: 80 }],
        } satisfies QuotaSnapshot
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
        config: {
          providers: async () => ({
            data: {
              providers: [
                {
                  id: 'kimi-for-coding',
                  key: 'env-kimi-key',
                  options: {},
                },
              ],
            },
          }),
        },
      } as any,
      directory: tmp,
      scheduleSave: () => {},
    })

    const snapshots = await service.getQuotaSnapshots(['kimi-for-coding'])
    assert.equal(snapshots.length, 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.apiKey, 'env-kimi-key')
  })
})
