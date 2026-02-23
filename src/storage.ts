import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  asBoolean,
  asNumber,
  debug,
  debugError,
  isRecord,
  swallow,
} from './helpers.js'
import type {
  CachedProviderUsage,
  CachedSessionUsage,
  IncrementalCursor,
  QuotaSidebarConfig,
  QuotaSidebarState,
  SessionDayChunk,
  SessionState,
  SessionTitleState,
} from './types.js'

// ─── Default config ──────────────────────────────────────────────────────────

export const defaultConfig: QuotaSidebarConfig = {
  sidebar: {
    enabled: true,
    width: 36,
    showCost: true,
    showQuota: true,
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

// ─── Timestamp helpers ───────────────────────────────────────────────────────

export function normalizeTimestampMs(value: unknown, fallback = Date.now()) {
  const num = asNumber(value)
  if (num === undefined) return fallback
  // Seconds -> ms heuristic
  if (num > 0 && num < 1_000_000_000_000) return num * 1000
  if (num > 0) return num
  return fallback
}

function pad2(value: number) {
  return `${value}`.padStart(2, '0')
}

/**
 * Extract date parts from a timestamp.
 * M12 fix: accepts already-normalized ms timestamp — no double normalization.
 */
function datePartsFromMs(timestampMs: number) {
  const date = new Date(timestampMs)
  if (Number.isNaN(date.getTime())) {
    const now = new Date()
    return {
      year: `${now.getFullYear()}`,
      month: pad2(now.getMonth() + 1),
      day: pad2(now.getDate()),
    }
  }
  return {
    year: `${date.getFullYear()}`,
    month: pad2(date.getMonth() + 1),
    day: pad2(date.getDate()),
  }
}

function isDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [yearText, monthText, dayText] = value.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  if (!Number.isInteger(year)) return false
  if (!Number.isInteger(month) || month < 1 || month > 12) return false
  if (!Number.isInteger(day) || day < 1 || day > 31) return false
  const probe = new Date(year, month - 1, day)
  return (
    probe.getFullYear() === year &&
    probe.getMonth() === month - 1 &&
    probe.getDate() === day
  )
}

/**
 * Convert a timestamp (already in ms) to a date key string.
 * M12 fix: no double normalization — caller must pass ms.
 */
export function dateKeyFromTimestamp(timestampMs: number) {
  const { year, month, day } = datePartsFromMs(timestampMs)
  return `${year}-${month}-${day}`
}

function dateStartFromKey(dateKey: string) {
  if (!isDateKey(dateKey)) return 0
  const [yearText, monthText, dayText] = dateKey.split('-')
  return new Date(
    Number(yearText),
    Number(monthText) - 1,
    Number(dayText),
  ).getTime()
}

/** M7 fix: cap iteration at 400 days (~13 months). */
const MAX_DATE_RANGE_DAYS = 400

function dateKeysInRange(startAt: number, endAt: number) {
  const startDate = new Date(startAt)
  if (Number.isNaN(startDate.getTime())) return []

  const endDate = new Date(endAt)
  if (Number.isNaN(endDate.getTime())) return []

  const cursor = new Date(
    startDate.getFullYear(),
    startDate.getMonth(),
    startDate.getDate(),
  )
  const endDay = new Date(
    endDate.getFullYear(),
    endDate.getMonth(),
    endDate.getDate(),
  )

  const keys: string[] = []
  let iterations = 0
  while (
    cursor.getTime() <= endDay.getTime() &&
    iterations < MAX_DATE_RANGE_DAYS
  ) {
    keys.push(dateKeyFromTimestamp(cursor.getTime()))
    cursor.setDate(cursor.getDate() + 1)
    iterations++
  }
  return keys
}

// ─── Path helpers ────────────────────────────────────────────────────────────

/**
 * Resolve the OpenCode data directory.
 *
 * OpenCode uses `xdg-basedir@5.1.0` which has NO platform-specific logic:
 *   xdgData = $XDG_DATA_HOME || $HOME/.local/share
 * This applies on all platforms including Windows and macOS.
 *
 * S4 fix: renamed env var from OPENCODE_TEST_HOME to OPENCODE_QUOTA_DATA_HOME.
 */
export function resolveOpencodeDataDir() {
  const home = process.env.OPENCODE_QUOTA_DATA_HOME || os.homedir()
  const xdg = process.env.XDG_DATA_HOME
  if (xdg) return path.join(xdg, 'opencode')
  return path.join(home, '.local', 'share', 'opencode')
}

export function stateFilePath(dataDir: string) {
  return path.join(dataDir, 'quota-sidebar.state.json')
}

export function authFilePath(dataDir: string) {
  return path.join(dataDir, 'auth.json')
}

function chunkRootPathFromStateFile(statePath: string) {
  return path.join(path.dirname(statePath), 'quota-sidebar-sessions')
}

function chunkFilePath(rootPath: string, dateKey: string) {
  const [year, month, day] = dateKey.split('-')
  return path.join(rootPath, year, month, `${day}.json`)
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

// ─── State parsing ───────────────────────────────────────────────────────────

function parseSessionTitleState(value: unknown): SessionTitleState | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.baseTitle !== 'string') return undefined
  if (
    value.lastAppliedTitle !== undefined &&
    typeof value.lastAppliedTitle !== 'string'
  ) {
    return undefined
  }
  return {
    baseTitle: value.baseTitle,
    lastAppliedTitle: value.lastAppliedTitle,
  }
}

function parseProviderUsage(value: unknown): CachedProviderUsage | undefined {
  if (!isRecord(value)) return undefined
  return {
    input: asNumber(value.input, 0),
    output: asNumber(value.output, 0),
    reasoning: asNumber(value.reasoning, 0),
    cacheRead: asNumber(value.cacheRead, 0),
    cacheWrite: asNumber(value.cacheWrite, 0),
    total: asNumber(value.total, 0),
    cost: asNumber(value.cost, 0),
    apiCost: asNumber(value.apiCost, 0),
    assistantMessages: asNumber(value.assistantMessages, 0),
  }
}

function parseCachedUsage(value: unknown): CachedSessionUsage | undefined {
  if (!isRecord(value)) return undefined
  const providersRaw = isRecord(value.providers) ? value.providers : {}
  const providers = Object.entries(providersRaw).reduce<
    Record<string, CachedProviderUsage>
  >((acc, [providerID, providerUsage]) => {
    const parsed = parseProviderUsage(providerUsage)
    if (!parsed) return acc
    acc[providerID] = parsed
    return acc
  }, {})

  return {
    input: asNumber(value.input, 0),
    output: asNumber(value.output, 0),
    reasoning: asNumber(value.reasoning, 0),
    cacheRead: asNumber(value.cacheRead, 0),
    cacheWrite: asNumber(value.cacheWrite, 0),
    total: asNumber(value.total, 0),
    cost: asNumber(value.cost, 0),
    apiCost: asNumber(value.apiCost, 0),
    assistantMessages: asNumber(value.assistantMessages, 0),
    providers,
  }
}

function parseCursor(value: unknown): IncrementalCursor | undefined {
  if (!isRecord(value)) return undefined
  return {
    lastMessageId:
      typeof value.lastMessageId === 'string' ? value.lastMessageId : undefined,
    lastMessageTime: asNumber(value.lastMessageTime),
  }
}

function parseSessionState(value: unknown): SessionState | undefined {
  if (!isRecord(value)) return undefined
  const title = parseSessionTitleState(value)
  if (!title) return undefined

  const createdAt = asNumber(value.createdAt, 0)
  if (!createdAt) return undefined

  return {
    ...title,
    createdAt,
    usage: parseCachedUsage(value.usage),
    cursor: parseCursor(value.cursor),
  }
}

function parseQuotaCache(value: unknown) {
  const raw = isRecord(value) ? value : {}
  return Object.entries(raw).reduce<QuotaSidebarState['quotaCache']>(
    (acc, [key, item]) => {
      if (!isRecord(item)) return acc

      const checkedAt = asNumber(item.checkedAt, 0)
      if (!checkedAt) return acc
      const status = item.status
      if (
        status !== 'ok' &&
        status !== 'unavailable' &&
        status !== 'unsupported' &&
        status !== 'error'
      ) {
        return acc
      }
      const label = typeof item.label === 'string' ? item.label : key
      const adapterID =
        typeof item.adapterID === 'string' ? item.adapterID : undefined
      const shortLabel =
        typeof item.shortLabel === 'string' ? item.shortLabel : undefined
      const sortOrder =
        typeof item.sortOrder === 'number' ? item.sortOrder : undefined
      const balance = isRecord(item.balance)
        ? {
            amount:
              typeof item.balance.amount === 'number' ? item.balance.amount : 0,
            currency:
              typeof item.balance.currency === 'string'
                ? item.balance.currency
                : '$',
          }
        : undefined
      const windows = Array.isArray(item.windows)
        ? item.windows
            .filter((window): window is Record<string, unknown> =>
              isRecord(window),
            )
            .map((window) => ({
              label: typeof window.label === 'string' ? window.label : '',
              showPercent:
                typeof window.showPercent === 'boolean'
                  ? window.showPercent
                  : undefined,
              resetLabel:
                typeof window.resetLabel === 'string'
                  ? window.resetLabel
                  : undefined,
              remainingPercent:
                typeof window.remainingPercent === 'number'
                  ? window.remainingPercent
                  : undefined,
              usedPercent:
                typeof window.usedPercent === 'number'
                  ? window.usedPercent
                  : undefined,
              resetAt:
                typeof window.resetAt === 'string' ? window.resetAt : undefined,
            }))
            .filter(
              (window) => window.label || window.remainingPercent !== undefined,
            )
        : undefined
      acc[key] = {
        providerID: typeof item.providerID === 'string' ? item.providerID : key,
        adapterID,
        label,
        shortLabel,
        sortOrder,
        status,
        checkedAt,
        remainingPercent:
          typeof item.remainingPercent === 'number'
            ? item.remainingPercent
            : undefined,
        usedPercent:
          typeof item.usedPercent === 'number' ? item.usedPercent : undefined,
        resetAt: typeof item.resetAt === 'string' ? item.resetAt : undefined,
        balance,
        note: typeof item.note === 'string' ? item.note : undefined,
        windows,
      }
      return acc
    },
    {},
  )
}

// ─── Chunk I/O ───────────────────────────────────────────────────────────────

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

  clear() {
    this.cache.clear()
  }
}

const chunkCache = new ChunkCache()

async function readDayChunk(
  rootPath: string,
  dateKey: string,
): Promise<Record<string, SessionState>> {
  const cached = chunkCache.get(dateKey)
  if (cached) return cached

  const filePath = chunkFilePath(rootPath, dateKey)
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
async function safeWriteFile(filePath: string, content: string) {
  // S3: refuse to write through symlinks
  const stat = await fs.lstat(filePath).catch(() => undefined)
  if (stat?.isSymbolicLink()) {
    debug(`refusing to write through symlink: ${filePath}`)
    return
  }

  // M4: atomic write via temp + rename
  const tmpPath = `${filePath}.tmp.${process.pid}`
  await fs.writeFile(tmpPath, content, 'utf8')
  await fs.rename(tmpPath, filePath)
}

async function writeDayChunk(
  rootPath: string,
  dateKey: string,
  sessions: Record<string, SessionState>,
) {
  const filePath = chunkFilePath(rootPath, dateKey)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const chunk: SessionDayChunk = {
    version: 1,
    dateKey,
    sessions,
  }
  await safeWriteFile(filePath, `${JSON.stringify(chunk, null, 2)}\n`)
  chunkCache.invalidate(dateKey)
}

async function discoverChunks(rootPath: string): Promise<string[]> {
  const years = await fs.readdir(rootPath).catch(() => [])
  const dateKeys: string[] = []

  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue
    const yearPath = path.join(rootPath, year)
    const months = await fs.readdir(yearPath).catch(() => [])
    for (const month of months) {
      if (!/^\d{2}$/.test(month)) continue
      const monthPath = path.join(yearPath, month)
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

// ─── State loading ───────────────────────────────────────────────────────────

/** P2: Lazy chunk loading — only load chunks for sessions in sessionDateMap. */
async function loadVersion2State(
  raw: Record<string, unknown>,
  statePath: string,
) {
  const titleEnabled = asBoolean(raw.titleEnabled, true)
  const quotaCache = parseQuotaCache(raw.quotaCache)
  const rootPath = chunkRootPathFromStateFile(statePath)

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

  const explicitDateKeys = Array.from(new Set(Object.values(sessionDateMap)))
  const discoveredDateKeys = explicitDateKeys.length
    ? []
    : await discoverChunks(rootPath)
  const dateKeys: string[] = explicitDateKeys.length
    ? explicitDateKeys
    : discoveredDateKeys
  const chunks: Array<readonly [string, Record<string, SessionState>]> =
    await Promise.all(
      dateKeys.map(async (dateKey) => {
        const sessions = await readDayChunk(rootPath, dateKey)
        return [dateKey, sessions] as const
      }),
    )

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

/**
 * M3 fix: use session.createdAt from v1 state if available,
 * otherwise fall back to Date.now() (unavoidable for truly missing data).
 */
function migrateVersion1State(raw: Record<string, unknown>): QuotaSidebarState {
  const titleEnabled = asBoolean(raw.titleEnabled, true)
  const quotaCache = parseQuotaCache(raw.quotaCache)
  const sessionsRaw = isRecord(raw.sessions) ? raw.sessions : {}

  const sessions: Record<string, SessionState> = {}
  const sessionDateMap: Record<string, string> = {}

  for (const [sessionID, value] of Object.entries(sessionsRaw)) {
    const title = parseSessionTitleState(value)
    if (!title) continue
    // M3: try to recover createdAt from v1 data
    const rawCreatedAt = isRecord(value) ? asNumber(value.createdAt) : undefined
    const createdAt = rawCreatedAt
      ? normalizeTimestampMs(rawCreatedAt)
      : Date.now()
    const dateKey = dateKeyFromTimestamp(createdAt)
    sessions[sessionID] = {
      ...title,
      createdAt,
    }
    sessionDateMap[sessionID] = dateKey
  }

  return {
    version: 2,
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
  if (raw.version === 1) {
    const migrated = migrateVersion1State(raw)
    // Persist immediately so chunk files exist for range scans.
    await saveState(statePath, migrated, { writeAll: true }).catch(
      swallow('loadState:migrate'),
    )
    return migrated
  }

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

      const dateKey =
        state.sessionDateMap[sessionID] ||
        dateKeyFromTimestamp(normalizedCreatedAt)
      state.sessionDateMap[sessionID] = dateKey

      // M11: skip sessions not in dirty set
      if (!writeAll && dirtySet && !dirtySet.has(dateKey)) continue

      const dateBucket = sessionsByDate[dateKey] || {}
      dateBucket[sessionID] = session
      sessionsByDate[dateKey] = dateBucket
    }
  }

  await fs.mkdir(path.dirname(statePath), { recursive: true })
  await fs.mkdir(rootPath, { recursive: true })

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

  if (skipChunks) return

  const keysToWrite = writeAll
    ? Object.keys(sessionsByDate)
    : Array.from(dirtySet ?? [])

  await Promise.all(
    keysToWrite
      .map((dateKey) => {
        const sessions = sessionsByDate[dateKey]
        if (!sessions) return undefined
        return writeDayChunk(rootPath, dateKey, sessions)
      })
      .filter((promise): promise is Promise<void> => Boolean(promise)),
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
  if (evicted > 0)
    debug(`evicted ${evicted} sessions older than ${retentionDays} days`)
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
  if (!dateKeys.length)
    return [] as Array<{
      sessionID: string
      dateKey: string
      state: SessionState
    }>

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
    const chunkEntries = await Promise.all(
      diskDateKeys.map(async (dateKey) => {
        const sessions = await readDayChunk(rootPath, dateKey)
        return Object.entries(sessions).map(([sessionID, state]) => ({
          sessionID,
          dateKey,
          state,
        }))
      }),
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
