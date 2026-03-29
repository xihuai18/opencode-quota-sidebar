import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

describe('tui dist packaging', () => {
  it('ships the raw tsx TUI entry and removes the jsx artifact', async () => {
    const distDir = path.resolve(process.cwd(), 'dist')
    const sourcePath = path.join(distDir, 'tui.tsx')
    const jsxPath = path.join(distDir, 'tui.jsx')

    const source = await fs.readFile(sourcePath, 'utf8')

    assert.match(source, /const plugin: TuiPluginModule & \{ id: string \} =/)
    assert.match(source, /<SectionHeading api=\{props\.api\} value="Usage" \/>/)
    assert.match(source, /value="Quota"/)
    assert.doesNotMatch(source, /['"]TITLE['"]/)
    await assert.rejects(fs.access(jsxPath))
  })
})
