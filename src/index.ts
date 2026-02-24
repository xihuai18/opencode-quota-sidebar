import path from 'node:path'

import type { Session } from '@opencode-ai/sdk'
import { type Hooks, type PluginInput } from '@opencode-ai/plugin'

import {
  renderMarkdownReport,
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

export async function QuotaSidebarPlugin(input: PluginInput): Promise<Hooks> {
  const quotaRuntime = createQuotaRuntime()
  const config = await loadConfig([
    path.join(input.directory, 'quota-sidebar.config.json'),
    path.join(input.worktree, 'quota-sidebar.config.json'),
  ])

  const dataDir = resolveOpencodeDataDir()
  const statePath = stateFilePath(dataDir)
  const authPath = authFilePath(dataDir)

  const state = await loadState(statePath)

  // M2: evict old sessions on startup
  evictOldSessions(state, config.retentionDays)

  const persistence = createPersistenceScheduler({
    statePath,
    state,
    saveState: (path, st, options) => saveState(path, st, options),
  })
  const markDirty = persistence.markDirty
  const scheduleSave = persistence.scheduleSave
  const flushSave = persistence.flushSave

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
    const created = {
      createdAt: normalizedCreatedAt,
      baseTitle: normalizeBaseTitle(title),
      lastAppliedTitle: undefined as string | undefined,
      parentID: parentID ?? undefined,
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

  // title apply / refresh lifecycle
  let scheduleTitleRefresh = (sessionID: string, delay = 250) => {
    void sessionID
    void delay
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

    scheduleTitleRefresh(parentID, 0)
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
    quotaRuntime,
    getQuotaSnapshots,
    summarizeSessionUsageForDisplay,
    scheduleParentRefreshIfSafe,
    restoreConcurrency: RESTORE_TITLE_CONCURRENCY,
  })

  const titleRefresh = createTitleRefreshScheduler({
    apply: titleApplicator.applyTitle,
    onError: swallow('titleRefresh'),
  })
  scheduleTitleRefresh = titleRefresh.schedule

  const restoreAllVisibleTitles = titleApplicator.restoreAllVisibleTitles

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
        scheduleRefresh: titleRefresh.schedule,
      })
    },

    onSessionDeleted: async (session) => {
      await flushSave().catch(swallow('onSessionDeleted:flushSave'))

      descendantsResolver.invalidateForAncestors(session.parentID)
      descendantsResolver.invalidateForAncestors(session.id)
      usageService.forgetSession(session.id)
      titleApplicator.forgetSession(session.id)
      titleRefresh.cancel(session.id)

      const dateKey =
        state.sessionDateMap[session.id] ||
        dateKeyFromTimestamp(session.time.created)

      delete state.sessions[session.id]
      delete state.sessionDateMap[session.id]
      scheduleSave()

      await deleteSessionFromDayChunk(statePath, session.id, dateKey).catch(
        swallow('deleteSessionFromDayChunk'),
      )

      if (config.sidebar.includeChildren && session.parentID) {
        titleRefresh.schedule(session.parentID, 0)
      }
    },

    onMessageRemoved: async (sessionID) => {
      usageService.markForceRescan(sessionID)
      titleRefresh.schedule(sessionID)
    },

    onAssistantMessageCompleted: async (message) => {
      usageService.markSessionDirty(message.sessionID)
      titleRefresh.schedule(message.sessionID)
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
      refreshSessionTitle: (sessionID, delay) =>
        titleRefresh.schedule(sessionID, delay ?? 250),
      restoreAllVisibleTitles,
      showToast,
      summarizeForTool,
      getQuotaSnapshots,
      renderMarkdownReport,
      renderToastMessage,
      config,
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
