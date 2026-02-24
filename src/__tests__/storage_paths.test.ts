import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { resolveOpencodeDataDir } from '../storage_paths.js'

type EnvSnapshot = {
  OPENCODE_QUOTA_DATA_HOME?: string
  XDG_DATA_HOME?: string
}

const envStack: EnvSnapshot[] = []

function pushEnv() {
  envStack.push({
    OPENCODE_QUOTA_DATA_HOME: process.env.OPENCODE_QUOTA_DATA_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  })
}

function popEnv() {
  const prev = envStack.pop() || {}
  process.env.OPENCODE_QUOTA_DATA_HOME = prev.OPENCODE_QUOTA_DATA_HOME
  process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME
}

afterEach(() => {
  while (envStack.length) popEnv()
})

describe('resolveOpencodeDataDir', () => {
  it('trims OPENCODE_QUOTA_DATA_HOME and takes precedence', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-data-'))
    pushEnv()
    process.env.XDG_DATA_HOME = `  ${path.join(dir, 'xdg')}  `
    process.env.OPENCODE_QUOTA_DATA_HOME = `  ${dir}  `
    assert.equal(resolveOpencodeDataDir(), path.resolve(dir))
  })

  it('trims XDG_DATA_HOME when override is absent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-xdg-'))
    pushEnv()
    delete process.env.OPENCODE_QUOTA_DATA_HOME
    process.env.XDG_DATA_HOME = `  ${dir}  `
    assert.equal(
      resolveOpencodeDataDir(),
      path.join(path.resolve(dir), 'opencode'),
    )
  })
})
