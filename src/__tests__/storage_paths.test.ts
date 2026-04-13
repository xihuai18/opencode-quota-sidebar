import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  opencodeConfigPaths,
  resolveOpencodeConfigDir,
  resolveOpencodeDataDir,
} from '../storage_paths.js'

type EnvSnapshot = {
  OPENCODE_QUOTA_CONFIG_HOME?: string
  OPENCODE_QUOTA_DATA_HOME?: string
  XDG_CONFIG_HOME?: string
  XDG_DATA_HOME?: string
}

const envStack: EnvSnapshot[] = []

function pushEnv() {
  envStack.push({
    OPENCODE_QUOTA_CONFIG_HOME: process.env.OPENCODE_QUOTA_CONFIG_HOME,
    OPENCODE_QUOTA_DATA_HOME: process.env.OPENCODE_QUOTA_DATA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  })
}

function popEnv() {
  const prev = envStack.pop() || {}
  process.env.OPENCODE_QUOTA_CONFIG_HOME = prev.OPENCODE_QUOTA_CONFIG_HOME
  process.env.OPENCODE_QUOTA_DATA_HOME = prev.OPENCODE_QUOTA_DATA_HOME
  process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME
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

describe('resolveOpencodeConfigDir', () => {
  it('trims OPENCODE_QUOTA_CONFIG_HOME and takes precedence', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-config-home-'))
    pushEnv()
    process.env.XDG_CONFIG_HOME = `  ${path.join(dir, 'xdg')}  `
    process.env.OPENCODE_QUOTA_CONFIG_HOME = `  ${dir}  `
    assert.equal(resolveOpencodeConfigDir(), path.resolve(dir))
  })

  it('trims XDG_CONFIG_HOME when override is absent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-xdg-config-'))
    pushEnv()
    delete process.env.OPENCODE_QUOTA_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = `  ${dir}  `
    assert.equal(
      resolveOpencodeConfigDir(),
      path.join(path.resolve(dir), 'opencode'),
    )
  })
})

describe('opencodeConfigPaths', () => {
  it('lists global, project, directory, and local override candidates in order', () => {
    const worktree = path.join(path.sep, 'worktree')
    const directory = path.join(worktree, 'subdir')

    assert.deepEqual(opencodeConfigPaths(worktree, directory), [
      path.join(resolveOpencodeConfigDir(), 'opencode.jsonc'),
      path.join(resolveOpencodeConfigDir(), 'opencode.json'),
      path.join(worktree, 'opencode.jsonc'),
      path.join(worktree, 'opencode.json'),
      path.join(directory, 'opencode.jsonc'),
      path.join(directory, 'opencode.json'),
      path.join(worktree, '.opencode', 'opencode.jsonc'),
      path.join(worktree, '.opencode', 'opencode.json'),
      path.join(directory, '.opencode', 'opencode.jsonc'),
      path.join(directory, '.opencode', 'opencode.json'),
    ])
  })
})
