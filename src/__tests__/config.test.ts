import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { defaultConfig, loadConfig } from '../storage.js'

const tmpDirs: string[] = []

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-config-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(
    tmpDirs
      .splice(0, tmpDirs.length)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  )
})

describe('loadConfig', () => {
  it('returns defaults when no config exists', async () => {
    const dir = await makeTempDir()
    const config = await loadConfig([path.join(dir, 'missing.json')])
    assert.deepEqual(config, defaultConfig)
    assert.equal(config.sidebar.includeChildren, true)
    assert.equal(config.sidebar.titleMode, 'auto')
  })

  it('clamps width into safe range', async () => {
    const dir = await makeTempDir()
    const filePath = path.join(dir, 'quota-sidebar.config.json')
    await fs.writeFile(
      filePath,
      JSON.stringify({
        sidebar: {
          width: 999,
        },
      }),
    )

    const config = await loadConfig([filePath])
    assert.equal(config.sidebar.width, 60)
  })

  it('enforces minimum values and parses booleans', async () => {
    const dir = await makeTempDir()
    const filePath = path.join(dir, 'quota-sidebar.config.json')
    await fs.writeFile(
      filePath,
      JSON.stringify({
        sidebar: {
          enabled: false,
          width: 1,
          titleMode: 'weird',
          showCost: false,
          showQuota: false,
          wrapQuotaLines: true,
          includeChildren: false,
          childrenMaxDepth: 0,
          childrenMaxSessions: -1,
          childrenConcurrency: 999,
          desktopCompact: {
            recentRequests: 0,
            recentMinutes: 5000,
          },
        },
        quota: {
          refreshMs: 100,
          requestTimeoutMs: 100,
          includeOpenAI: false,
          includeCopilot: false,
          includeAnthropic: false,
          providers: {
            rightcode: {
              enabled: false,
            },
          },
          refreshAccessToken: true,
        },
      }),
    )

    const config = await loadConfig([filePath])
    assert.equal(config.sidebar.enabled, false)
    assert.equal(config.sidebar.width, 20)
    assert.equal(config.sidebar.titleMode, 'auto')
    assert.equal(config.sidebar.showCost, false)
    assert.equal(config.sidebar.showQuota, false)
    assert.equal(config.sidebar.wrapQuotaLines, true)
    assert.equal(config.sidebar.includeChildren, false)
    assert.equal(config.sidebar.childrenMaxDepth, 1)
    assert.equal(config.sidebar.childrenMaxSessions, 0)
    assert.equal(config.sidebar.childrenConcurrency, 10)
    assert.equal(config.sidebar.desktopCompact?.recentRequests, 1)
    assert.equal(config.sidebar.desktopCompact?.recentMinutes, 24 * 60)
    assert.equal(config.quota.refreshMs, 30_000)
    assert.equal(config.quota.requestTimeoutMs, 1_000)
    assert.equal(config.quota.includeOpenAI, false)
    assert.equal(config.quota.includeCopilot, false)
    assert.equal(config.quota.includeAnthropic, false)
    assert.equal(config.quota.providers?.rightcode?.enabled, false)
    assert.equal(config.quota.refreshAccessToken, true)
  })

  it('merges global base with project override in order', async () => {
    const dir = await makeTempDir()
    const globalPath = path.join(dir, 'global.json')
    const projectPath = path.join(dir, 'project.json')

    await fs.writeFile(
      globalPath,
      JSON.stringify({
        sidebar: {
          showCost: false,
          width: 30,
        },
        quota: {
          includeOpenAI: false,
          providers: {
            rightcode: { enabled: false },
          },
        },
      }),
    )

    await fs.writeFile(
      projectPath,
      JSON.stringify({
        sidebar: {
          width: 48,
          showQuota: false,
        },
        quota: {
          providers: {
            rightcode: { enabled: true },
          },
        },
      }),
    )

    const config = await loadConfig([globalPath, projectPath])
    assert.equal(config.sidebar.showCost, false)
    assert.equal(config.sidebar.showQuota, false)
    assert.equal(config.sidebar.width, 48)
    assert.equal(config.quota.includeOpenAI, false)
    assert.equal(config.quota.providers?.rightcode?.enabled, true)
  })

  it('accepts explicit compact or multiline title modes', async () => {
    const dir = await makeTempDir()
    const compactPath = path.join(dir, 'compact.json')
    const multilinePath = path.join(dir, 'multiline.json')

    await fs.writeFile(
      compactPath,
      JSON.stringify({ sidebar: { titleMode: 'compact' } }),
    )
    await fs.writeFile(
      multilinePath,
      JSON.stringify({ sidebar: { titleMode: 'multiline' } }),
    )

    const compact = await loadConfig([compactPath])
    const multiline = await loadConfig([multilinePath])

    assert.equal(compact.sidebar.titleMode, 'compact')
    assert.equal(multiline.sidebar.titleMode, 'multiline')
  })

  it('preserves provider-specific login config fields', async () => {
    const dir = await makeTempDir()
    const filePath = path.join(dir, 'quota-sidebar.config.json')

    await fs.writeFile(
      filePath,
      JSON.stringify({
        quota: {
          providers: {
            'xyai-vibe': {
              enabled: true,
              baseURL: 'https://new.xychatai.com',
              serviceType: 'codex',
              login: {
                username: 'user@example.com',
                password: 'secret',
              },
            },
          },
        },
      }),
    )

    const config = await loadConfig([filePath])
    assert.equal(config.quota.providers?.['xyai-vibe']?.enabled, true)
    assert.equal(
      config.quota.providers?.['xyai-vibe']?.baseURL,
      'https://new.xychatai.com',
    )
    assert.equal(config.quota.providers?.['xyai-vibe']?.serviceType, 'codex')
    assert.deepEqual(config.quota.providers?.['xyai-vibe']?.login, {
      username: 'user@example.com',
      password: 'secret',
    })
  })

  it('deep-merges nested provider login config across layers', async () => {
    const dir = await makeTempDir()
    const globalPath = path.join(dir, 'global.json')
    const projectPath = path.join(dir, 'project.json')

    await fs.writeFile(
      globalPath,
      JSON.stringify({
        quota: {
          providers: {
            'xyai-vibe': {
              enabled: true,
              login: {
                username: 'user@example.com',
                password: 'secret',
              },
            },
          },
        },
      }),
    )

    await fs.writeFile(
      projectPath,
      JSON.stringify({
        quota: {
          providers: {
            'xyai-vibe': {
              login: {
                username: 'project@example.com',
              },
            },
          },
        },
      }),
    )

    const config = await loadConfig([globalPath, projectPath])
    assert.equal(config.quota.providers?.['xyai-vibe']?.enabled, true)
    assert.deepEqual(config.quota.providers?.['xyai-vibe']?.login, {
      username: 'project@example.com',
      password: 'secret',
    })
  })

  it('deduplicates repeated config paths', async () => {
    const dir = await makeTempDir()
    const filePath = path.join(dir, 'quota-sidebar.config.json')

    await fs.writeFile(
      filePath,
      JSON.stringify({
        sidebar: {
          width: 42,
        },
      }),
    )

    const config = await loadConfig([filePath, filePath])
    assert.equal(config.sidebar.width, 42)
  })
})
