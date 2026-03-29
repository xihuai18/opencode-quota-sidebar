import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const sourcePath = path.join(rootDir, 'src', 'tui.tsx')
const distSourcePath = path.join(rootDir, 'dist', 'tui.tsx')
const distJsxPath = path.join(rootDir, 'dist', 'tui.jsx')

await fs.copyFile(sourcePath, distSourcePath)
await fs.rm(distJsxPath, { force: true })
