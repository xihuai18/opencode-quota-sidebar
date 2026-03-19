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

    const snapshots = await service.getQuotaSnapshots([], { allowDefault: true })

    assert.equal(snapshots.length, 2)
    assert.deepEqual(calls.sort(), ['rc-a:key-a', 'rc-b:key-b'])
    const matchingKeys = Object.keys(state.quotaCache).filter((key) =>
      key.startsWith('rightcode@https://www.right.codes/codex/v1#options@'),
    )
    assert.equal(matchingKeys.length, 2)
  })
})
