import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

type PackageExports = Record<
  string,
  {
    types?: string
    default?: string
  }
>

describe('package manifest compatibility', () => {
  it('ships explicit server and tui entrypoints for OpenCode', async () => {
    const file = path.resolve(process.cwd(), 'package.json')
    const pkg = JSON.parse(await fs.readFile(file, 'utf8')) as {
      main?: string
      exports?: PackageExports
      'oc-plugin'?: string[]
    }

    assert.equal(pkg.main, './dist/index.js')
    assert.deepEqual(pkg['oc-plugin'], ['server', 'tui'])
    assert.deepEqual(pkg.exports?.['./server'], {
      types: './dist/index.d.ts',
      default: './dist/index.js',
    })
    assert.deepEqual(pkg.exports?.['./tui'], {
      types: './dist/tui.d.ts',
      default: './dist/tui.tsx',
    })
  })
})
