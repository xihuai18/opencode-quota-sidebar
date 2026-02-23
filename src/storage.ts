import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type {
  QuotaSidebarConfig,
  QuotaSidebarState,
  SessionTitleState,
} from './types.js'

export const defaultConfig: QuotaSidebarConfig = {
  sidebar: {
    enabled: true,
    width: 36,
    showCost: true,
    showQuota: true,
    maxQuotaProviders: 2,
  },
  quota: {
    refreshMs: 5 * 60 * 1000,
    includeOpenAI: true,
    includeCopilot: true,
    includeAnthropic: true,
  },
  toast: {
    durationMs: 12_000,
  },
}

export function defaultState(): QuotaSidebarState {
  return {
    version: 1,
    titleEnabled: true,
    sessions: {},
    quotaCache: {},
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asNumber(value: unknown, fallback: number) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  return value
}

function asBoolean(value: unknown, fallback: boolean) {
  if (typeof value !== 'boolean') return fallback
  return value
}

/**
 * Resolve the OpenCode data directory.
 *
 * OpenCode uses `xdg-basedir@5.1.0` which has NO platform-specific logic:
 *   xdgData = $XDG_DATA_HOME || $HOME/.local/share
 * This applies on all platforms including Windows and macOS.
 * We must match this exactly so we find auth.json in the right place.
 */
export function resolveOpencodeDataDir() {
  const home = process.env.OPENCODE_TEST_HOME || os.homedir()
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

export async function loadConfig(paths: string[]) {
  const existing = await Promise.all(
    paths.map(async (filePath) => {
      const stat = await fs.stat(filePath).catch(() => undefined)
      if (!stat || !stat.isFile()) return undefined
      return filePath
    }),
  )

  const selected = existing.find((value) => value)
  if (!selected) return defaultConfig

  const parsed = await fs
    .readFile(selected, 'utf8')
    .then((value) => JSON.parse(value) as unknown)
    .catch(() => undefined)

  if (!isRecord(parsed)) return defaultConfig

  const sidebar = isRecord(parsed.sidebar) ? parsed.sidebar : {}
  const quota = isRecord(parsed.quota) ? parsed.quota : {}
  const toast = isRecord(parsed.toast) ? parsed.toast : {}

  return {
    sidebar: {
      enabled: asBoolean(sidebar.enabled, defaultConfig.sidebar.enabled),
      width: Math.max(
        20,
        Math.min(60, asNumber(sidebar.width, defaultConfig.sidebar.width)),
      ),
      showCost: asBoolean(sidebar.showCost, defaultConfig.sidebar.showCost),
      showQuota: asBoolean(sidebar.showQuota, defaultConfig.sidebar.showQuota),
      maxQuotaProviders: Math.max(
        1,
        Math.min(
          4,
          Math.floor(
            asNumber(
              sidebar.maxQuotaProviders,
              defaultConfig.sidebar.maxQuotaProviders,
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
    },
    toast: {
      durationMs: Math.max(
        1000,
        asNumber(toast.durationMs, defaultConfig.toast.durationMs),
      ),
    },
  }
}

function parseSessionState(value: unknown): SessionTitleState | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.baseTitle !== 'string') return undefined
  if (
    value.lastAppliedTitle !== undefined &&
    typeof value.lastAppliedTitle !== 'string'
  )
    return undefined
  return {
    baseTitle: value.baseTitle,
    lastAppliedTitle: value.lastAppliedTitle,
  }
}

export async function loadState(filePath: string) {
  const raw = await fs
    .readFile(filePath, 'utf8')
    .then((value) => JSON.parse(value) as unknown)
    .catch(() => undefined)
  if (!isRecord(raw)) return defaultState()
  if (raw.version !== 1) return defaultState()

  const sessions = isRecord(raw.sessions) ? raw.sessions : {}
  const quotaCache = isRecord(raw.quotaCache) ? raw.quotaCache : {}

  return {
    version: 1 as const,
    titleEnabled:
      typeof raw.titleEnabled === 'boolean' ? raw.titleEnabled : true,
    sessions: Object.entries(sessions)
      .map(([key, value]) => {
        const parsed = parseSessionState(value)
        if (!parsed) return undefined
        return [key, parsed] as const
      })
      .filter((entry): entry is readonly [string, SessionTitleState] =>
        Boolean(entry),
      )
      .reduce<Record<string, SessionTitleState>>((acc, [key, value]) => {
        acc[key] = value
        return acc
      }, {}),
    quotaCache: Object.entries(quotaCache).reduce<
      QuotaSidebarState['quotaCache']
    >((acc, [key, value]) => {
      if (!isRecord(value)) return acc

      const checkedAt = asNumber(value.checkedAt, 0)
      if (!checkedAt) return acc
      const status = value.status
      if (
        status !== 'ok' &&
        status !== 'unavailable' &&
        status !== 'unsupported' &&
        status !== 'error'
      ) {
        return acc
      }
      const label = typeof value.label === 'string' ? value.label : key
      acc[key] = {
        providerID:
          typeof value.providerID === 'string' ? value.providerID : key,
        label,
        status,
        checkedAt,
        remainingPercent:
          typeof value.remainingPercent === 'number'
            ? value.remainingPercent
            : undefined,
        usedPercent:
          typeof value.usedPercent === 'number' ? value.usedPercent : undefined,
        resetAt: typeof value.resetAt === 'string' ? value.resetAt : undefined,
        note: typeof value.note === 'string' ? value.note : undefined,
      }
      return acc
    }, {}),
  }
}

const MAX_SESSION_ENTRIES = 200
const MAX_QUOTA_CACHE_AGE_MS = 24 * 60 * 60 * 1000

function pruneState(state: QuotaSidebarState) {
  const entries = Object.entries(state.sessions)
  if (entries.length > MAX_SESSION_ENTRIES) {
    const sorted = entries.sort((a, b) => {
      const aHas = a[1].lastAppliedTitle ? 1 : 0
      const bHas = b[1].lastAppliedTitle ? 1 : 0
      return aHas - bHas
    })
    const toRemove = sorted.slice(0, entries.length - MAX_SESSION_ENTRIES)
    for (const [key] of toRemove) delete state.sessions[key]
  }

  const now = Date.now()
  for (const [key, value] of Object.entries(state.quotaCache)) {
    if (now - value.checkedAt > MAX_QUOTA_CACHE_AGE_MS) {
      delete state.quotaCache[key]
    }
  }
}

export async function saveState(filePath: string, state: QuotaSidebarState) {
  pruneState(state)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}
