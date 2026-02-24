import fs from 'node:fs/promises'
import path from 'node:path'

import {
  asBoolean,
  asNumber,
  debug,
  isRecord,
  mapConcurrent,
  swallow,
} from './helpers.js'
import {
  discoverChunks,
  readDayChunk,
  safeWriteFile,
  writeDayChunk,
} from './storage_chunks.js'
import {
  dateKeyFromTimestamp,
  dateKeysInRange,
  dateStartFromKey,
  isDateKey,
  normalizeTimestampMs,
} from './storage_dates.js'
import { parseQuotaCache } from './storage_parse.js'
import {
  authFilePath,
  chunkRootPathFromStateFile,
  resolveOpencodeDataDir,
  stateFilePath,
} from './storage_paths.js'
import type {
  QuotaSidebarConfig,
  QuotaSidebarState,
  SessionState,
} from './types.js'

export {
  authFilePath,
  dateKeyFromTimestamp,
  normalizeTimestampMs,
  resolveOpencodeDataDir,
  stateFilePath,
}

// ─── Default config ──────────────────────────────────────────────────────────

export const defaultConfig: QuotaSidebarConfig = {
  sidebar: {
    enabled: true,
    width: 36,
    showCost: true,
    showQuota: true,
    includeChildren: true,
    childrenMaxDepth: 6,
    childrenMaxSessions: 128,
    childrenConcurrency: 5,
  },
  quota: {
    refreshMs: 5 * 60 * 1000,
    includeOpenAI: true,
    includeCopilot: true,
    includeAnthropic: true,
    providers: {},
    refreshAccessToken: false,
    requestTimeoutMs: 8_000,
  },
  toast: {
    durationMs: 12_000,
  },
  retentionDays: 730,
}

export function defaultState(): QuotaSidebarState {
  return {
    version: 2,
    titleEnabled: true,
    sessionDateMap: {},
    sessions: {},
    quotaCache: {},
  }
}

// ─── Config loading ──────────────────────────────────────────────────────────

export async function loadConfig(paths: string[]) {
  const existing = await Promise.all(
    paths.map(async (filePath) => {
      const stat = await fs.stat(filePath).catch(swallow('loadConfig:stat'))
      if (!stat || !stat.isFile()) return undefined
      return filePath
    }),
  )

  const selected = existing.find((value) => value)
  if (!selected) return defaultConfig

  const parsed = await fs
    .readFile(selected, 'utf8')
    .then((value) => JSON.parse(value) as unknown)
    .catch(swallow('loadConfig:read'))

  if (!isRecord(parsed)) return defaultConfig

  const sidebar = isRecord(parsed.sidebar) ? parsed.sidebar : {}
  const quota = isRecord(parsed.quota) ? parsed.quota : {}
  const toast = isRecord(parsed.toast) ? parsed.toast : {}
  const providers = isRecord(quota.providers) ? quota.providers : {}

  return {
    sidebar: {
      enabled: asBoolean(sidebar.enabled, defaultConfig.sidebar.enabled),
      width: Math.max(
        20,
        Math.min(60, asNumber(sidebar.width, defaultConfig.sidebar.width)),
      ),
      showCost: asBoolean(sidebar.showCost, defaultConfig.sidebar.showCost),
      showQuota: asBoolean(sidebar.showQuota, defaultConfig.sidebar.showQuota),
      includeChildren: asBoolean(
        sidebar.includeChildren,
        defaultConfig.sidebar.includeChildren,
      ),
      childrenMaxDepth: Math.max(
        1,
        Math.min(
          32,
          Math.floor(
            asNumber(
              sidebar.childrenMaxDepth,
              defaultConfig.sidebar.childrenMaxDepth,
            ),
          ),
        ),
      ),
      childrenMaxSessions: Math.max(
        0,
        Math.min(
          2000,
          Math.floor(
            asNumber(
              sidebar.childrenMaxSessions,
              defaultConfig.sidebar.childrenMaxSessions,
            ),
          ),
        ),
      ),
      childrenConcurrency: Math.max(
        1,
        Math.min(
          10,
          Math.floor(
            asNumber(
              sidebar.childrenConcurrency,
              defaultConfig.sidebar.childrenConcurrency,
            ),
          ),
        ),
      ),
    },
    quota: {
      refreshMs: Math.max(
        30_000,
        asNumber(quota.refreshMs, defaultConfig.quota.refreshMs),
      ),
      includeOpenAI: asBoolean(
        quota.includeOpenAI,
        defaultConfig.quota.includeOpenAI,
      ),
      includeCopilot: asBoolean(
        quota.includeCopilot,
        defaultConfig.quota.includeCopilot,
      ),
      includeAnthropic: asBoolean(
        quota.includeAnthropic,
        defaultConfig.quota.includeAnthropic,
      ),
      providers: Object.entries(providers).reduce<
        Record<string, { enabled?: boolean }>
      >((acc, [id, value]) => {
        if (!isRecord(value)) return acc
        if (typeof value.enabled === 'boolean') {
          acc[id] = { enabled: value.enabled }
        }
        return acc
      }, {}),
      refreshAccessToken: asBoolean(
        quota.refreshAccessToken,
        defaultConfig.quota.refreshAccessToken,
      ),
      requestTimeoutMs: Math.max(
        1000,
        asNumber(quota.requestTimeoutMs, defaultConfig.quota.requestTimeoutMs),
      ),
    },
    toast: {
      durationMs: Math.max(
        1000,
        asNumber(toast.durationMs, defaultConfig.toast.durationMs),
      ),
    },
    retentionDays: Math.max(
      1,
      asNumber(parsed.retentionDays, defaultConfig.retentionDays),
    ),
  }
}

// ─── State loading ───────────────────────────────────────────────────────────

/** P2: Lazy chunk loading — only load chunks for sessions in sessionDateMap. */
async function loadVersion2State(
  raw: Record<string, unknown>,
  statePath: string,
) {
  const titleEnabled = asBoolean(raw.titleEnabled, true)
  const quotaCache = parseQuotaCache(raw.quotaCache)
  const rootPath = chunkRootPathFromStateFile(statePath)

  const hasSessionDateMap = Object.prototype.hasOwnProperty.call(
    raw,
    'sessionDateMap',
  )

  const sessionDateMapRaw = isRecord(raw.sessionDateMap)
    ? raw.sessionDateMap
    : {}
  const sessionDateMap = Object.entries(sessionDateMapRaw).reduce<
    Record<string, string>
  >((acc, [sessionID, value]) => {
    if (typeof value !== 'string') return acc
    if (!isDateKey(value)) return acc
    acc[sessionID] = value
    return acc
  }, {})

  const hadRawSessionDateMapEntries =
    isRecord(raw.sessionDateMap) && Object.keys(raw.sessionDateMap).length > 0

  const explicitDateKeys = Array.from(new Set(Object.values(sessionDateMap)))
  // Only discover chunks when sessionDateMap is missing from state.
  // If sessionDateMap exists (even empty), treat it as authoritative so we
  // don't repeatedly load and evict historical sessions from disk.
  const discoveredDateKeys =
    (!hasSessionDateMap && explicitDateKeys.length === 0) ||
    (hasSessionDateMap &&
      hadRawSessionDateMapEntries &&
      explicitDateKeys.length === 0)
      ? await discoverChunks(rootPath)
      : []
  const dateKeys: string[] = explicitDateKeys.length
    ? explicitDateKeys
    : discoveredDateKeys

  const LOAD_CHUNKS_CONCURRENCY = 5
  const chunks: Array<readonly [string, Record<string, SessionState>]> =
    await mapConcurrent(dateKeys, LOAD_CHUNKS_CONCURRENCY, async (dateKey) => {
      const sessions = await readDayChunk(rootPath, dateKey)
      return [dateKey, sessions] as const
    })

  const sessions: Record<string, SessionState> = {}
  for (const [dateKey, chunkSessions] of chunks) {
    for (const [sessionID, session] of Object.entries(chunkSessions)) {
      sessions[sessionID] = session
      if (!sessionDateMap[sessionID]) sessionDateMap[sessionID] = dateKey
    }
  }

  return {
    version: 2 as const,
    titleEnabled,
    sessionDateMap,
    sessions,
    quotaCache,
  }
}

export async function loadState(statePath: string) {
  const raw = await fs
    .readFile(statePath, 'utf8')
    .then((value) => JSON.parse(value) as unknown)
    .catch(swallow('loadState'))
  if (!isRecord(raw)) return defaultState()

  if (raw.version === 2) return loadVersion2State(raw, statePath)

  return defaultState()
}

// ─── State saving ────────────────────────────────────────────────────────────

const MAX_QUOTA_CACHE_AGE_MS = 24 * 60 * 60 * 1000

function pruneState(state: QuotaSidebarState) {
  const now = Date.now()
  for (const [key, value] of Object.entries(state.quotaCache)) {
    if (now - value.checkedAt > MAX_QUOTA_CACHE_AGE_MS) {
      delete state.quotaCache[key]
    }
  }
}

/**
 * H1 fix: when dirtyDateKeys is empty and writeAll is not set, skip chunk writes entirely.
 * M11 fix: only iterate sessions belonging to dirty date keys (not all sessions).
 * M4 fix: atomic writes via safeWriteFile.
 * P4 fix: sessionDateMap dirty flag tracked externally.
 */
export async function saveState(
  statePath: string,
  state: QuotaSidebarState,
  options?: { dirtyDateKeys?: string[]; writeAll?: boolean },
) {
  pruneState(state)

  const rootPath = chunkRootPathFromStateFile(statePath)
  const writeAll = options?.writeAll === true

  // H1 fix: if no dirty keys and not writeAll, only write the state file (no chunks)
  const dirtySet = writeAll
    ? undefined
    : new Set((options?.dirtyDateKeys ?? []).filter((key) => isDateKey(key)))

  const skipChunks = !writeAll && (!dirtySet || dirtySet.size === 0)

  // M11 fix: only build sessionsByDate for dirty keys (or all if writeAll)
  const sessionsByDate: Record<string, Record<string, SessionState>> = {}

  if (!skipChunks) {
    for (const [sessionID, session] of Object.entries(state.sessions)) {
      const normalizedCreatedAt =
        Number.isFinite(session.createdAt) && session.createdAt > 0
          ? session.createdAt
          : Date.now()
      session.createdAt = normalizedCreatedAt

      const dateKey = isDateKey(state.sessionDateMap[sessionID])
        ? state.sessionDateMap[sessionID]
        : dateKeyFromTimestamp(normalizedCreatedAt)
      state.sessionDateMap[sessionID] = dateKey

      // M11: skip sessions not in dirty set
      if (!writeAll && dirtySet && !dirtySet.has(dateKey)) continue

      const dateBucket = sessionsByDate[dateKey] || {}
      dateBucket[sessionID] = session
      sessionsByDate[dateKey] = dateBucket
    }
  }

  await fs.mkdir(path.dirname(statePath), { recursive: true })

  if (!skipChunks) {
    const keysToWrite = writeAll
      ? Object.keys(sessionsByDate)
      : Array.from(dirtySet ?? [])

    await Promise.all(
      keysToWrite
        .map((dateKey) => {
          if (!Object.prototype.hasOwnProperty.call(sessionsByDate, dateKey)) {
            return undefined
          }
          return (async () => {
            const memorySessions = sessionsByDate[dateKey] || {}
            const next = writeAll
              ? memorySessions
              : {
                  ...(await readDayChunk(rootPath, dateKey)),
                  ...memorySessions,
                }
            await writeDayChunk(rootPath, dateKey, next)
          })()
        })
        .filter((promise): promise is Promise<void> => Boolean(promise)),
    )
  }

  // M4: atomic state file write
  await safeWriteFile(
    statePath,
    `${JSON.stringify(
      {
        version: 2,
        titleEnabled: state.titleEnabled,
        sessionDateMap: state.sessionDateMap,
        quotaCache: state.quotaCache,
      },
      null,
      2,
    )}\n`,
  )
}

// ─── Eviction (M2) ──────────────────────────────────────────────────────────

/**
 * M2 fix: evict sessions older than retentionDays from memory.
 * Chunk files remain on disk for historical range scans.
 */
export function evictOldSessions(
  state: QuotaSidebarState,
  retentionDays: number,
) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  let evicted = 0
  for (const [sessionID, session] of Object.entries(state.sessions)) {
    if (session.createdAt < cutoff) {
      delete state.sessions[sessionID]
      delete state.sessionDateMap[sessionID]
      evicted++
    }
  }
  if (evicted > 0) {
    debug(`evicted ${evicted} sessions older than ${retentionDays} days`)
  }
  return evicted
}

// ─── Range scan (M9 fix: prefer memory, fall back to disk) ──────────────────

/**
 * M9 fix: scan from in-memory state first, only read disk for date keys
 * not represented in memory.
 */
export async function scanSessionsByCreatedRange(
  statePath: string,
  startAt: number,
  endAt = Date.now(),
  memoryState?: QuotaSidebarState,
) {
  const rootPath = chunkRootPathFromStateFile(statePath)
  const dateKeys = dateKeysInRange(startAt, endAt)
  if (!dateKeys.length) {
    return [] as Array<{
      sessionID: string
      dateKey: string
      state: SessionState
    }>
  }

  type SessionEntry = {
    sessionID: string
    dateKey: string
    state: SessionState
  }
  const results: SessionEntry[] = []
  const seenSessionIDs = new Set<string>()

  // First pass: collect from memory
  if (memoryState) {
    const dateKeySet = new Set(dateKeys)
    for (const [sessionID, session] of Object.entries(memoryState.sessions)) {
      const dk = memoryState.sessionDateMap[sessionID]
      if (!dk || !dateKeySet.has(dk)) continue
      const createdAt =
        Number.isFinite(session.createdAt) && session.createdAt > 0
          ? session.createdAt
          : dateStartFromKey(dk)
      if (createdAt >= startAt && createdAt <= endAt) {
        results.push({ sessionID, dateKey: dk, state: session })
        seenSessionIDs.add(sessionID)
      }
    }
  }

  // Second pass: read disk chunks for date keys that may have sessions not in memory
  const memoryDateKeys = memoryState
    ? new Set(Object.values(memoryState.sessionDateMap))
    : new Set<string>()

  const diskDateKeys = dateKeys.filter((dk) => !memoryDateKeys.has(dk))

  if (diskDateKeys.length > 0) {
    const RANGE_SCAN_CONCURRENCY = 5
    const chunkEntries = await mapConcurrent(
      diskDateKeys,
      RANGE_SCAN_CONCURRENCY,
      async (dateKey) => {
        const sessions = await readDayChunk(rootPath, dateKey)
        return Object.entries(sessions).map(([sessionID, state]) => ({
          sessionID,
          dateKey,
          state,
        }))
      },
    )

    for (const entry of chunkEntries.flat()) {
      if (seenSessionIDs.has(entry.sessionID)) continue
      const createdAt =
        Number.isFinite(entry.state.createdAt) && entry.state.createdAt > 0
          ? entry.state.createdAt
          : dateStartFromKey(entry.dateKey)
      if (createdAt >= startAt && createdAt <= endAt) {
        results.push(entry)
        seenSessionIDs.add(entry.sessionID)
      }
    }
  }

  return results
}

/** Best-effort: remove a session entry from its day chunk (if present). */
export async function deleteSessionFromDayChunk(
  statePath: string,
  sessionID: string,
  dateKey: string,
) {
  const rootPath = chunkRootPathFromStateFile(statePath)
  const sessions = await readDayChunk(rootPath, dateKey)
  if (!Object.prototype.hasOwnProperty.call(sessions, sessionID)) return false
  const next = { ...sessions }
  delete next[sessionID]
  await writeDayChunk(rootPath, dateKey, next)
  return true
}
