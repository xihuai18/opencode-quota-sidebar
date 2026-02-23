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
  })

  it('clamps width and maxQuotaProviders into safe range', async () => {
    const dir = await makeTempDir()
    const filePath = path.join(dir, 'quota-sidebar.config.json')
    await fs.writeFile(
      filePath,
      JSON.stringify({
        sidebar: {
          width: 999,
          maxQuotaProviders: 999,
        },
      }),
    )

    const config = await loadConfig([filePath])
    assert.equal(config.sidebar.width, 60)
    assert.equal(config.sidebar.maxQuotaProviders, 4)
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
          showCost: false,
          showQuota: false,
          maxQuotaProviders: 0,
        },
        quota: {
          refreshMs: 100,
          requestTimeoutMs: 100,
          includeOpenAI: false,
          includeCopilot: false,
          includeAnthropic: false,
          refreshAccessToken: true,
        },
      }),
    )

    const config = await loadConfig([filePath])
    assert.equal(config.sidebar.enabled, false)
    assert.equal(config.sidebar.width, 20)
    assert.equal(config.sidebar.showCost, false)
    assert.equal(config.sidebar.showQuota, false)
    assert.equal(config.sidebar.maxQuotaProviders, 1)
    assert.equal(config.quota.refreshMs, 30_000)
    assert.equal(config.quota.requestTimeoutMs, 1_000)
    assert.equal(config.quota.includeOpenAI, false)
    assert.equal(config.quota.includeCopilot, false)
    assert.equal(config.quota.includeAnthropic, false)
    assert.equal(config.quota.refreshAccessToken, true)
  })
})
