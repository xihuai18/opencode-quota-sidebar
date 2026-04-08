import type { Session } from '@opencode-ai/sdk'
import { type Hooks, type PluginInput } from '@opencode-ai/plugin'

import {
  renderMarkdownReport,
  resolveTitleView,
  renderSidebarTitle,
  renderToastMessage,
} from './format.js'
import { createQuotaRuntime } from './quota.js'
import {
  authFilePath,
  dateKeyFromTimestamp,
  deleteSessionFromDayChunk,
  evictOldSessions,
  loadConfig,
  loadState,
  normalizeTimestampMs,
  quotaConfigPaths,
  resolveOpencodeDataDir,
  saveState,
  stateFilePath,
} from './storage.js'
import { debug, swallow } from './helpers.js'
import { normalizeBaseTitle } from './title.js'
import { createDescendantsResolver } from './descendants.js'
import { createTitleRefreshScheduler } from './title_refresh.js'
import { createQuotaSidebarTools } from './tools.js'
import { createEventDispatcher } from './events.js'
import { createPersistenceScheduler } from './persistence.js'
import { createQuotaService } from './quota_service.js'
import { createUsageService } from './usage_service.js'
import { createTitleApplicator } from './title_apply.js'
import type { SessionState } from './types.js'

const SHUTDOWN_HOOK_KEY = Symbol.for('opencode-quota-sidebar.shutdown-hook')
const SHUTDOWN_CALLBACKS_KEY = Symbol.for(
  'opencode-quota-sidebar.shutdown-callbacks',
)
const SESSION_ACTIVE_GRACE_MS = 15_000

export async function QuotaSidebarPlugin(input: PluginInput): Promise<Hooks> {
  const quotaRuntime = createQuotaRuntime()
  const config = await loadConfig(
    quotaConfigPaths(input.worktree, input.directory),
  )

  const dataDir = resolveOpencodeDataDir()
  const statePath = stateFilePath(dataDir)
  const authPath = authFilePath(dataDir)

  const state = await loadState(statePath)

  // M2: evict old sessions on startup
  const evictedOnStartup = evictOldSessions(state, config.retentionDays)

  const persistence = createPersistenceScheduler({
    statePath,
    state,
    saveState: (path, st, options) => saveState(path, st, options),
  })
  const markDirty = persistence.markDirty
  const scheduleSave = persistence.scheduleSave
  const flushSave = persistence.flushSave

  if (evictedOnStartup > 0) {
    scheduleSave()
  }

  const RESTORE_TITLE_CONCURRENCY = 5

  const quotaService = createQuotaService({
    quotaRuntime,
    config,
    state,
    authPath,
    client: input.client,
    directory: input.directory,
    scheduleSave,
  })
  const getQuotaSnapshots = quotaService.getQuotaSnapshots

  const ensureSessionState = (
    sessionID: string,
    title: string,
    createdAt = Date.now(),
    parentID?: string | null,
  ) => {
    const existing = state.sessions[sessionID]
    if (existing) {
      if (parentID !== undefined) {
        const nextParentID = parentID ?? undefined
        if (existing.parentID !== nextParentID) {
          existing.parentID = nextParentID
          const dateKey =
            state.sessionDateMap[sessionID] ||
            dateKeyFromTimestamp(existing.createdAt)
          state.sessionDateMap[sessionID] = dateKey
          markDirty(dateKey)
          scheduleSave()
        }
      }
      if (!state.sessionDateMap[sessionID]) {
        state.sessionDateMap[sessionID] = dateKeyFromTimestamp(
          existing.createdAt,
        )
        markDirty(state.sessionDateMap[sessionID])
        scheduleSave()
      }
      return existing
    }
    const normalizedCreatedAt = normalizeTimestampMs(createdAt)
    const created: SessionState = {
      createdAt: normalizedCreatedAt,
      baseTitle: normalizeBaseTitle(title),
      lastAppliedTitle: undefined as string | undefined,
      parentID: parentID ?? undefined,
      expiryToastShown: false,
      usage: undefined,
      cursor: undefined,
    }
    state.sessions[sessionID] = created
    state.sessionDateMap[sessionID] = dateKeyFromTimestamp(normalizedCreatedAt)
    markDirty(state.sessionDateMap[sessionID])
    scheduleSave()
    return created
  }

  const descendantsResolver = createDescendantsResolver({
    listChildren: async (sessionID: string) => {
      const sessionClient = input.client as unknown as {
        session?: {
          children?: (args: {
            path: { id: string }
            query: { directory: string }
            throwOnError: true
          }) => Promise<{ data?: Session[] }>
        }
      }
      if (!sessionClient.session?.children) return []

      const response = await sessionClient.session
        .children({
          path: { id: sessionID },
          query: { directory: input.directory },
          throwOnError: true,
        })
        .catch(swallow('listSessionChildren'))
      return response?.data ?? []
    },
    getParentID: (sessionID: string) => state.sessions[sessionID]?.parentID,
    onDiscover: (session) => {
      ensureSessionState(
        session.id,
        session.title,
        session.createdAt,
        session.parentID ?? null,
      )
    },
    debug,
  })
  const usageService = createUsageService({
    state,
    config,
    statePath,
    client: input.client,
    directory: input.directory,
    persistence: {
      markDirty,
      scheduleSave,
      flushSave,
    },
    descendantsResolver,
  })

  const summarizeSessionUsageForDisplay =
    usageService.summarizeSessionUsageForDisplay
  const summarizeForTool = usageService.summarizeForTool

  const activeSessionUntil = new Map<string, number>()

  const markSessionActive = (sessionID: string, now = Date.now()) => {
    activeSessionUntil.set(sessionID, now + SESSION_ACTIVE_GRACE_MS)
  }

  const clearSessionActivity = (sessionID: string) => {
    activeSessionUntil.delete(sessionID)
  }

  const isSessionActive = (sessionID: string, now = Date.now()) => {
    const expiresAt = activeSessionUntil.get(sessionID)
    if (expiresAt === undefined) return false
    if (expiresAt > now) return true
    activeSessionUntil.delete(sessionID)
    return false
  }

  // title apply / refresh lifecycle
  let scheduleTitleRefresh = (sessionID: string, delay = 250) => {
    void sessionID
    void delay
  }

  const scheduleActiveTitleRefresh = (sessionID: string, delay = 250) => {
    if (!isSessionActive(sessionID)) return false
    scheduleTitleRefresh(sessionID, delay)
    return true
  }

  const scheduleParentRefreshIfSafe = (
    sessionID: string,
    parentID: string | undefined,
  ) => {
    if (!config.sidebar.includeChildren) return
    if (!parentID) return
    if (parentID === sessionID) return

    // Guard against cycles in parent chains that would cause endless refresh.
    const seen = new Set<string>([sessionID])
    let current: string | undefined = parentID
    const maxHops = 512
    for (let i = 0; i < maxHops && current; i++) {
      if (seen.has(current)) {
        debug(
          `skip parent refresh due to parentID cycle: ${sessionID} -> ${parentID}`,
        )
        return
      }
      seen.add(current)
      current = state.sessions[current]?.parentID
    }

    scheduleActiveTitleRefresh(parentID, 0)
  }

  const titleApplicator = createTitleApplicator({
    state,
    config,
    client: input.client,
    directory: input.directory,
    ensureSessionState,
    markDirty,
    scheduleSave,
    renderSidebarTitle,
    getTitleView: () => resolveTitleView({ config }),
    getQuotaSnapshots,
    summarizeSessionUsageForDisplay,
    scheduleParentRefreshIfSafe,
    isSessionActive,
    restoreConcurrency: RESTORE_TITLE_CONCURRENCY,
  })

  const titleRefresh = createTitleRefreshScheduler({
    apply: async (sessionID: string) => {
      if (!isSessionActive(sessionID)) return
      await titleApplicator.applyTitle(sessionID)
    },
    onError: swallow('titleRefresh'),
  })
  scheduleTitleRefresh = titleRefresh.schedule

  const startupTitleWork = Promise.resolve()

  const shutdown = async () => {
    await Promise.race([
      startupTitleWork,
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]).catch(swallow('shutdown:startupTitleWork'))
    await titleRefresh
      .waitForQuiescence()
      .catch(swallow('shutdown:titleQuiescence'))
    await flushSave().catch(swallow('shutdown:flushSave'))
  }

  const processWithHook = process as NodeJS.Process & {
    [SHUTDOWN_HOOK_KEY]?: boolean
    [SHUTDOWN_CALLBACKS_KEY]?: Set<() => Promise<void>>
  }
  const shutdownCallbacks = (processWithHook[SHUTDOWN_CALLBACKS_KEY] ||=
    new Set<() => Promise<void>>())
  shutdownCallbacks.add(shutdown)
  if (!processWithHook[SHUTDOWN_HOOK_KEY]) {
    processWithHook[SHUTDOWN_HOOK_KEY] = true
    process.once('beforeExit', () => {
      void Promise.allSettled(
        Array.from(shutdownCallbacks).map((callback) => callback()),
      )
    })
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void Promise.allSettled(
          Array.from(shutdownCallbacks).map((callback) => callback()),
        ).finally(() => {
          process.kill(process.pid, signal)
        })
      })
    }
  }

  const showToast = async (
    period: 'session' | 'day' | 'week' | 'month' | 'toggle',
    message: string,
  ) => {
    await input.client.tui
      .showToast({
        query: { directory: input.directory },
        body: {
          title: `Quota ${period}`,
          message,
          variant: 'info',
          duration: config.toast.durationMs,
        },
        throwOnError: true,
      })
      .catch(swallow('showToast'))
  }

  const expiryAlertText = (iso: string | undefined, nowMs = Date.now()) => {
    if (!iso) return undefined
    const timestamp = Date.parse(iso)
    if (Number.isNaN(timestamp) || timestamp <= nowMs) return undefined
    const remainingMs = timestamp - nowMs
    const thresholdMs = 3 * 24 * 60 * 60 * 1000
    if (remainingMs > thresholdMs) return undefined
    const value = new Date(timestamp)
    const now = new Date(nowMs)
    const two = (num: number) => `${num}`.padStart(2, '0')
    const hhmm = `${two(value.getHours())}:${two(value.getMinutes())}`
    const sameDay =
      value.getFullYear() === now.getFullYear() &&
      value.getMonth() === now.getMonth() &&
      value.getDate() === now.getDate()
    return sameDay
      ? `Exp today ${hhmm}`
      : `Exp ${two(value.getMonth() + 1)}-${two(value.getDate())} ${hhmm}`
  }

  const expiryToastInflight = new Set<string>()
  const maybeShowExpiryToast = async (sessionID: string) => {
    const sessionState = state.sessions[sessionID]
    if (!sessionState) return
    if (sessionState.expiryToastShown || expiryToastInflight.has(sessionID)) {
      return
    }
    expiryToastInflight.add(sessionID)
    try {
      const quotas = await getQuotaSnapshots([], { allowDefault: true })
      const nowMs = Date.now()
      const expiryLines = quotas
        .filter((item) => item.status === 'ok')
        .map((item) => ({
          label: item.shortLabel || item.label,
          value: expiryAlertText(item.expiresAt, nowMs),
        }))
        .filter((item): item is { label: string; value: string } =>
          Boolean(item.value),
        )

      if (expiryLines.length === 0) return

      sessionState.expiryToastShown = true
      const dateKey =
        state.sessionDateMap[sessionID] ||
        dateKeyFromTimestamp(sessionState.createdAt)
      state.sessionDateMap[sessionID] = dateKey
      markDirty(dateKey)
      scheduleSave()

      const body = [
        'Expiry Soon',
        ...expiryLines.map((item) => `${item.label} ${item.value}`),
      ].join('\n')
      await showToast('session', body)
    } catch (error) {
      debug(`expiry toast check failed: ${String(error)}`)
    } finally {
      expiryToastInflight.delete(sessionID)
    }
  }

  const dispatchEvent = createEventDispatcher({
    onSessionCreated: async (session) => {
      ensureSessionState(
        session.id,
        session.title,
        session.time.created,
        session.parentID ?? null,
      )
      descendantsResolver.invalidateForAncestors(session.parentID)
      scheduleSave()
      scheduleParentRefreshIfSafe(session.id, session.parentID)
    },

    onSessionUpdated: async (session) => {
      const existing = state.sessions[session.id]
      const oldParentID = existing?.parentID
      const sessionState = ensureSessionState(
        session.id,
        session.title,
        session.time.created,
        session.parentID ?? null,
      )
      const newParentID = sessionState.parentID
      const parentMoved =
        config.sidebar.includeChildren && oldParentID !== newParentID

      descendantsResolver.invalidateForAncestors(oldParentID)
      descendantsResolver.invalidateForAncestors(newParentID)

      // If this session moved between parents, refresh both sides even if we
      // later return early due to title echo/decorated-title handling.
      if (parentMoved) {
        scheduleParentRefreshIfSafe(session.id, oldParentID)
        scheduleParentRefreshIfSafe(session.id, newParentID)
      }

      await titleApplicator.handleSessionUpdatedTitle({
        sessionID: session.id,
        incomingTitle: session.title,
        sessionState,
        scheduleRefresh: scheduleActiveTitleRefresh,
      })
    },

    onSessionDeleted: async (session) => {
      await flushSave().catch(swallow('onSessionDeleted:flushSave'))

      descendantsResolver.invalidateForAncestors(session.parentID)
      descendantsResolver.invalidateForAncestors(session.id)
      usageService.forgetSession(session.id)
      titleApplicator.forgetSession(session.id)
      titleRefresh.cancel(session.id)
      clearSessionActivity(session.id)

      const dateKey =
        state.sessionDateMap[session.id] ||
        dateKeyFromTimestamp(session.time.created)

      state.deletedSessionDateMap[session.id] = dateKey
      delete state.sessions[session.id]
      delete state.sessionDateMap[session.id]
      markDirty(dateKey)
      scheduleSave()

      const deletedFromChunk = await deleteSessionFromDayChunk(
        statePath,
        session.id,
        dateKey,
      ).catch(swallow('deleteSessionFromDayChunk'))
      if (deletedFromChunk) {
        delete state.deletedSessionDateMap[session.id]
        scheduleSave()
      }

      if (config.sidebar.includeChildren && session.parentID) {
        scheduleActiveTitleRefresh(session.parentID, 0)
      }
    },

    onTuiActivity: async () => {
      return
    },

    onTuiSessionSelect: async (sessionID) => {
      scheduleActiveTitleRefresh(sessionID, 0)
    },

    onMessageRemoved: async (info) => {
      usageService.markForceRescan(info.sessionID)
      scheduleActiveTitleRefresh(info.sessionID, 0)
      scheduleParentRefreshIfSafe(
        info.sessionID,
        state.sessions[info.sessionID]?.parentID,
      )
    },

    onAssistantMessageUpdated: async (message) => {
      const now = Date.now()
      const completed = message.time.completed
      if (typeof completed !== 'number' || !Number.isFinite(completed)) {
        markSessionActive(message.sessionID, now)
        return
      }

      const wasActive = isSessionActive(message.sessionID, now)
      if (!wasActive) {
        return
      }

      markSessionActive(message.sessionID, now)
      usageService.markSessionDirty(message.sessionID)
      scheduleActiveTitleRefresh(message.sessionID)
      void maybeShowExpiryToast(message.sessionID)
    },
  })

  return {
    event: async ({ event }) => {
      try {
        await dispatchEvent(event)
      } catch (error) {
        debug(`event handler failed: ${String(error)}`)
      }
    },
    tool: createQuotaSidebarTools({
      getTitleEnabled: () => state.titleEnabled,
      setTitleEnabled: (enabled) => {
        state.titleEnabled = enabled
      },
      scheduleSave,
      flushSave,
      waitForStartupTitleWork: () => startupTitleWork,
      markSessionActive,
      refreshSessionTitle: (sessionID, delay) =>
        scheduleActiveTitleRefresh(sessionID, delay ?? 250),
      cancelAllTitleRefreshes: () => titleRefresh.cancelAll(),
      flushScheduledTitleRefreshes: () => titleRefresh.flushScheduled(),
      waitForTitleRefreshIdle: () => titleRefresh.waitForIdle(),
      waitForTitleRefreshQuiescence: () => titleRefresh.waitForQuiescence(),
      restoreSessionTitle: (sessionID) =>
        titleApplicator.restoreSessionTitle(sessionID),
      showToast,
      summarizeForTool,
      getQuotaSnapshots,
      renderMarkdownReport,
      renderToastMessage,
      config: {
        sidebar: config.sidebar,
        sidebarEnabled: config.sidebar.enabled,
      },
    }),
  }
}

export default QuotaSidebarPlugin

// O5: Export consumer types
export type {
  QuotaSidebarConfig,
  QuotaSidebarState,
  QuotaSnapshot,
  QuotaStatus,
  SessionState,
  CachedSessionUsage,
  CachedProviderUsage,
  IncrementalCursor,
} from './types.js'
export type { UsageSummary } from './usage.js'
