import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { debug, isRecord, swallow } from './helpers.js'
import { isDateKey } from './storage_dates.js'
import { parseSessionState } from './storage_parse.js'
import { chunkFilePath } from './storage_paths.js'
import type { SessionDayChunk, SessionState } from './types.js'

async function mkdirpNoSymlink(rootPath: string, dirPath: string) {
  const rel = path.relative(rootPath, dirPath)
  if (!rel || rel === '.') return
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing to mkdir outside root: ${dirPath}`)
  }

  let current = rootPath
  const parts = rel.split(path.sep).filter(Boolean)
  for (const part of parts) {
    current = path.join(current, part)
    const stat = await fs.lstat(current).catch(() => undefined)
    if (stat) {
      if (stat.isSymbolicLink()) {
        throw new Error(`refusing to write through symlink dir: ${current}`)
      }
      if (!stat.isDirectory()) {
        throw new Error(`expected directory at ${current}`)
      }
      continue
    }
    await fs.mkdir(current).catch((error) => {
      const code = (error as { code?: string }).code
      if (code === 'EEXIST') return
      throw error
    })
    const created = await fs.lstat(current).catch(() => undefined)
    if (!created || created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error(`unsafe directory created at ${current}`)
    }
  }
}

/** P2: Simple LRU cache for loaded chunks. */
class ChunkCache {
  private cache = new Map<
    string,
    { sessions: Record<string, SessionState>; accessedAt: number }
  >()
  private maxSize: number

  constructor(maxSize = 64) {
    this.maxSize = maxSize
  }

  get(dateKey: string): Record<string, SessionState> | undefined {
    const entry = this.cache.get(dateKey)
    if (!entry) return undefined
    entry.accessedAt = Date.now()
    return entry.sessions
  }

  set(dateKey: string, sessions: Record<string, SessionState>) {
    if (this.cache.size >= this.maxSize) {
      // Evict least recently accessed
      let oldestKey: string | undefined
      let oldestTime = Infinity
      for (const [key, entry] of this.cache) {
        if (entry.accessedAt < oldestTime) {
          oldestTime = entry.accessedAt
          oldestKey = key
        }
      }
      if (oldestKey) this.cache.delete(oldestKey)
    }
    this.cache.set(dateKey, { sessions, accessedAt: Date.now() })
  }

  invalidate(dateKey: string) {
    this.cache.delete(dateKey)
  }
}

const chunkCache = new ChunkCache()

export async function readDayChunk(
  rootPath: string,
  dateKey: string,
): Promise<Record<string, SessionState>> {
  if (!isDateKey(dateKey)) return {}
  const cached = chunkCache.get(dateKey)
  if (cached) return cached

  const filePath = chunkFilePath(rootPath, dateKey)
  const stat = await fs.lstat(filePath).catch(() => undefined)
  if (stat?.isSymbolicLink()) {
    debug(`refusing to read symlink chunk: ${filePath}`)
    return {}
  }
  const parsed = await fs
    .readFile(filePath, 'utf8')
    .then((value) => JSON.parse(value) as unknown)
    .catch(swallow('readDayChunk'))
  if (!isRecord(parsed)) return {}
  if (parsed.version !== 1) return {}

  const sessionsRaw = isRecord(parsed.sessions) ? parsed.sessions : {}
  const sessions = Object.entries(sessionsRaw).reduce<
    Record<string, SessionState>
  >((acc, [sessionID, value]) => {
    const parsedSession = parseSessionState(value)
    if (!parsedSession) return acc
    acc[sessionID] = parsedSession
    return acc
  }, {})

  chunkCache.set(dateKey, sessions)
  return sessions
}

/**
 * S3 fix: check for symlink before writing.
 * M4 fix: write to temp file then rename for atomicity.
 */
export async function safeWriteFile(filePath: string, content: string) {
  // S3: refuse to write through symlinks
  const stat = await fs.lstat(filePath).catch(() => undefined)
  if (stat?.isSymbolicLink()) {
    const message = `refusing to write through symlink: ${filePath}`
    debug(message)
    throw new Error(message)
  }

  const dirStat = await fs.lstat(path.dirname(filePath)).catch(() => undefined)
  if (dirStat?.isSymbolicLink()) {
    const message = `refusing to write through symlink dir: ${path.dirname(filePath)}`
    debug(message)
    throw new Error(message)
  }

  // M4: atomic write via temp + rename
  const dir = path.dirname(filePath)
  const name = path.basename(filePath)
  const maxAttempts = 5

  let lastError: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const suffix = randomBytes(4).toString('hex')
    const tmpPath = path.join(dir, `${name}.tmp.${process.pid}.${suffix}`)

    try {
      await fs.writeFile(tmpPath, content, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'EEXIST') {
        lastError = error
        continue
      }
      throw error
    }

    try {
      await fs.rename(tmpPath, filePath)
      return
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`safeWriteFile failed for ${filePath}`)
}

export async function writeDayChunk(
  rootPath: string,
  dateKey: string,
  sessions: Record<string, SessionState>,
) {
  if (!isDateKey(dateKey)) {
    throw new Error(`invalid dateKey: ${dateKey}`)
  }
  const filePath = chunkFilePath(rootPath, dateKey)

  const rootStat = await fs.lstat(rootPath).catch(() => undefined)
  if (rootStat?.isSymbolicLink()) {
    throw new Error(`refusing to write through symlink dir: ${rootPath}`)
  }
  if (rootStat && !rootStat.isDirectory()) {
    throw new Error(`expected directory at ${rootPath}`)
  }

  await fs.mkdir(rootPath, { recursive: true })
  const createdRoot = await fs.lstat(rootPath).catch(() => undefined)
  if (
    !createdRoot ||
    createdRoot.isSymbolicLink() ||
    !createdRoot.isDirectory()
  ) {
    throw new Error(`unsafe chunk root at ${rootPath}`)
  }
  await mkdirpNoSymlink(rootPath, path.dirname(filePath))
  const chunk: SessionDayChunk = {
    version: 1,
    dateKey,
    sessions,
  }
  await safeWriteFile(filePath, `${JSON.stringify(chunk, null, 2)}\n`)
  chunkCache.invalidate(dateKey)
}

export async function discoverChunks(rootPath: string): Promise<string[]> {
  const years = await fs.readdir(rootPath).catch(() => [])
  const dateKeys: string[] = []

  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue
    const yearPath = path.join(rootPath, year)
    const yearStat = await fs.lstat(yearPath).catch(() => undefined)
    if (!yearStat || yearStat.isSymbolicLink() || !yearStat.isDirectory()) {
      continue
    }
    const months = await fs.readdir(yearPath).catch(() => [])
    for (const month of months) {
      if (!/^\d{2}$/.test(month)) continue
      const monthPath = path.join(yearPath, month)
      const monthStat = await fs.lstat(monthPath).catch(() => undefined)
      if (
        !monthStat ||
        monthStat.isSymbolicLink() ||
        !monthStat.isDirectory()
      ) {
        continue
      }
      const days = await fs.readdir(monthPath).catch(() => [])
      for (const dayFile of days) {
        const match = dayFile.match(/^(\d{2})\.json$/)
        if (!match) continue
        const day = match[1]
        const key = `${year}-${month}-${day}`
        if (isDateKey(key)) dateKeys.push(key)
      }
    }
  }

  return Array.from(new Set(dateKeys)).sort()
}
