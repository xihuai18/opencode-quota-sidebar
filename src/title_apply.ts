import type { PluginInput } from '@opencode-ai/plugin'

import {
  canonicalizeTitle,
  canonicalizeTitleForCompare,
  looksDecorated,
  normalizeBaseTitle,
} from './title.js'
import type {
  QuotaSidebarConfig,
  QuotaSidebarState,
  QuotaSnapshot,
  SessionState,
} from './types.js'
import type { UsageSummary } from './usage.js'
import { swallow, debug, mapConcurrent } from './helpers.js'

export function createTitleApplicator(deps: {
  state: QuotaSidebarState
  config: QuotaSidebarConfig
  client: PluginInput['client']
  directory: string
  ensureSessionState: (
    sessionID: string,
    title: string,
    createdAt: number,
    parentID?: string | null,
  ) => SessionState
  markDirty: (dateKey: string | undefined) => void
  scheduleSave: () => void
  renderSidebarTitle: (
    baseTitle: string,
    usage: UsageSummary,
    quotas: QuotaSnapshot[],
    config: QuotaSidebarConfig,
  ) => string
  getQuotaSnapshots: (
    providerIDs: string[],
    options?: { allowDefault?: boolean },
  ) => Promise<QuotaSnapshot[]>
  summarizeSessionUsageForDisplay: (
    sessionID: string,
    includeChildren: boolean,
  ) => Promise<UsageSummary>
  scheduleParentRefreshIfSafe: (sessionID: string, parentID?: string) => void
  restoreConcurrency: number
}) {
  const pendingAppliedTitle = new Map<
    string,
    { title: string; expiresAt: number }
  >()
  const recentRestore = new Map<
    string,
    { baseTitle: string; decoratedTitle?: string; expiresAt: number }
  >()

  const forgetSession = (sessionID: string) => {
    pendingAppliedTitle.delete(sessionID)
    recentRestore.delete(sessionID)
  }

  const applyTitle = async (sessionID: string) => {
    if (!deps.config.sidebar.enabled || !deps.state.titleEnabled) return false

    let stateMutated = false

    const session = await deps.client.session
      .get({
        path: { id: sessionID },
        query: { directory: deps.directory },
        throwOnError: true,
      })
      .catch(swallow('applyTitle:getSession'))

    if (!session) return false
    if (
      !session.data ||
      typeof session.data.title !== 'string' ||
      !session.data.time ||
      typeof session.data.time.created !== 'number'
    ) {
      debug(`applyTitle skipped malformed session payload for ${sessionID}`)
      return false
    }

    const sessionState = deps.ensureSessionState(
      sessionID,
      session.data.title,
      session.data.time.created,
      session.data.parentID ?? null,
    )

    // Detect whether the current title is our own decorated form.
    const currentTitle = session.data.title
    if (
      canonicalizeTitle(currentTitle) !==
      canonicalizeTitle(sessionState.lastAppliedTitle || '')
    ) {
      if (looksDecorated(currentTitle)) {
        // Ignore decorated echoes as base-title source.
        // If we previously applied a decorated title, treat this as an
        // equivalent echo (OpenCode may normalize whitespace) and keep
        // lastAppliedTitle in sync so restoreAllVisibleTitles still works.
        if (
          sessionState.lastAppliedTitle &&
          looksDecorated(sessionState.lastAppliedTitle)
        ) {
          if (sessionState.lastAppliedTitle !== currentTitle) {
            sessionState.lastAppliedTitle = currentTitle
            stateMutated = true
          }
        } else {
          debug(`ignoring decorated current title for session ${sessionID}`)
          if (sessionState.lastAppliedTitle !== undefined) {
            sessionState.lastAppliedTitle = undefined
            stateMutated = true
          }
        }
      } else {
        const nextBase = normalizeBaseTitle(currentTitle)
        if (sessionState.baseTitle !== nextBase) {
          sessionState.baseTitle = nextBase
          stateMutated = true
        }
        if (sessionState.lastAppliedTitle !== undefined) {
          sessionState.lastAppliedTitle = undefined
          stateMutated = true
        }
      }
    }

    const usage = await deps.summarizeSessionUsageForDisplay(
      sessionID,
      deps.config.sidebar.includeChildren,
    )
    const quotaProviders = Array.from(new Set(Object.keys(usage.providers)))

    const quotas =
      deps.config.sidebar.showQuota && quotaProviders.length > 0
        ? await deps.getQuotaSnapshots(quotaProviders)
        : ([] as QuotaSnapshot[])

    const nextTitle = deps.renderSidebarTitle(
      sessionState.baseTitle,
      usage,
      quotas,
      deps.config,
    )

    if (!deps.config.sidebar.enabled || !deps.state.titleEnabled) return false

    if (
      canonicalizeTitleForCompare(nextTitle) ===
      canonicalizeTitleForCompare(session.data.title)
    ) {
      if (looksDecorated(session.data.title)) {
        if (sessionState.lastAppliedTitle !== session.data.title) {
          sessionState.lastAppliedTitle = session.data.title
          stateMutated = true
        }
      }
      if (stateMutated) {
        deps.markDirty(deps.state.sessionDateMap[sessionID])
      }
      deps.scheduleSave()
      deps.scheduleParentRefreshIfSafe(sessionID, sessionState.parentID)
      return true
    }

    // Mark pending title to ignore the immediate echo `session.updated` event.
    // H3 fix: use longer TTL (15s) and add decoration detection as backup.
    pendingAppliedTitle.set(sessionID, {
      title: nextTitle,
      expiresAt: Date.now() + 15_000,
    })
    const previousApplied = sessionState.lastAppliedTitle
    sessionState.lastAppliedTitle = nextTitle
    deps.markDirty(deps.state.sessionDateMap[sessionID])

    const updated = await deps.client.session
      .update({
        path: { id: sessionID },
        query: { directory: deps.directory },
        body: { title: nextTitle },
        throwOnError: true,
      })
      .catch(swallow('applyTitle:update'))

    if (!updated) {
      pendingAppliedTitle.delete(sessionID)
      sessionState.lastAppliedTitle = previousApplied
      deps.scheduleSave()
      deps.scheduleParentRefreshIfSafe(sessionID, sessionState.parentID)
      return false
    }

    pendingAppliedTitle.delete(sessionID)
    deps.scheduleSave()
    deps.scheduleParentRefreshIfSafe(sessionID, sessionState.parentID)
    return true
  }

  const handleSessionUpdatedTitle = async (args: {
    sessionID: string
    incomingTitle: string
    sessionState: SessionState
    scheduleRefresh: (sessionID: string, delay?: number) => void
  }) => {
    const pending = pendingAppliedTitle.get(args.sessionID)
    if (pending) {
      if (pending.expiresAt > Date.now()) {
        if (
          canonicalizeTitleForCompare(args.incomingTitle) ===
          canonicalizeTitleForCompare(pending.title)
        ) {
          pendingAppliedTitle.delete(args.sessionID)
          // Keep in sync with what the server actually stored.
          args.sessionState.lastAppliedTitle = args.incomingTitle
          deps.markDirty(deps.state.sessionDateMap[args.sessionID])
          deps.scheduleSave()
          return
        }
      } else {
        pendingAppliedTitle.delete(args.sessionID)
      }
    }

    // H3 fix: if the incoming title looks decorated, it's likely a late echo
    // of our own update. Extract the base title from line 1 instead of
    // treating the whole decorated string as the new base title.
    if (
      canonicalizeTitleForCompare(args.incomingTitle) ===
      canonicalizeTitleForCompare(args.sessionState.lastAppliedTitle || '')
    ) {
      return
    }

    if (looksDecorated(args.incomingTitle) && args.sessionState.lastAppliedTitle) {
      if (
        canonicalizeTitleForCompare(args.incomingTitle) ===
        canonicalizeTitleForCompare(args.sessionState.lastAppliedTitle)
      ) {
        debug(`ignoring late decorated echo for session ${args.sessionID}`)
        return
      }
    }

    if (looksDecorated(args.incomingTitle) && !args.sessionState.lastAppliedTitle) {
      debug(`ignoring untracked decorated title for session ${args.sessionID}`)
      return
    }

    const restored = recentRestore.get(args.sessionID)
    if (restored) {
      if (restored.expiresAt <= Date.now()) {
        recentRestore.delete(args.sessionID)
      } else if (
        looksDecorated(args.incomingTitle) &&
        (!restored.decoratedTitle ||
          canonicalizeTitleForCompare(args.incomingTitle) ===
            canonicalizeTitleForCompare(restored.decoratedTitle))
      ) {
        debug(`ignoring decorated echo after restore for session ${args.sessionID}`)
        return
      }
    }

    args.sessionState.baseTitle = normalizeBaseTitle(args.incomingTitle)
    args.sessionState.lastAppliedTitle = undefined
    deps.markDirty(deps.state.sessionDateMap[args.sessionID])
    deps.scheduleSave()
    args.scheduleRefresh(args.sessionID)
  }

  const restoreSessionTitle = async (
    sessionID: string,
    options?: { abortIfEnabled?: boolean },
  ) => {
    if (options?.abortIfEnabled && deps.state.titleEnabled) return false
    const session = await deps.client.session
      .get({
        path: { id: sessionID },
        query: { directory: deps.directory },
        throwOnError: true,
      })
      .catch(swallow('restoreSessionTitle:get'))
    if (!session) return false
    if (
      !session.data ||
      typeof session.data.title !== 'string' ||
      !session.data.time ||
      typeof session.data.time.created !== 'number'
    ) {
      debug(`restoreSessionTitle skipped malformed session payload for ${sessionID}`)
      return false
    }

    const sessionState = deps.ensureSessionState(
      sessionID,
      session.data.title,
      session.data.time.created,
      session.data.parentID ?? null,
    )
    const baseTitle = canonicalizeTitle(sessionState.baseTitle) || 'Session'
    if (session.data.title === baseTitle) {
      if (sessionState.lastAppliedTitle !== undefined) {
        sessionState.lastAppliedTitle = undefined
        deps.markDirty(deps.state.sessionDateMap[sessionID])
        deps.scheduleSave()
      }
      return true
    }

    if (options?.abortIfEnabled && deps.state.titleEnabled) return false

    const updated = await deps.client.session
      .update({
        path: { id: sessionID },
        query: { directory: deps.directory },
        body: { title: baseTitle },
        throwOnError: true,
      })
      .catch(swallow('restoreSessionTitle:update'))

    if (!updated) return false

    pendingAppliedTitle.delete(sessionID)
    recentRestore.set(sessionID, {
      baseTitle,
      decoratedTitle: sessionState.lastAppliedTitle,
      expiresAt: Date.now() + 15_000,
    })
    sessionState.lastAppliedTitle = undefined
    deps.markDirty(deps.state.sessionDateMap[sessionID])
    deps.scheduleSave()
    return true
  }

  const restoreAllVisibleTitles = async (options?: { abortIfEnabled?: boolean }) => {
    const touched = Object.entries(deps.state.sessions)
      .filter(([, sessionState]) => Boolean(sessionState.lastAppliedTitle))
      .map(([sessionID]) => sessionID)
    const results = await mapConcurrent(
      touched,
      deps.restoreConcurrency,
      async (sessionID) => restoreSessionTitle(sessionID, options),
    )
    return {
      attempted: touched.length,
      restored: results.filter(Boolean).length,
      listFailed: false,
    }
  }

  const refreshAllTouchedTitles = async () => {
    const touched = Object.entries(deps.state.sessions)
      .filter(([, sessionState]) => Boolean(sessionState.lastAppliedTitle))
      .map(([sessionID]) => sessionID)
    const results = await mapConcurrent(
      touched,
      deps.restoreConcurrency,
      async (sessionID) => applyTitle(sessionID),
    )
    return {
      attempted: touched.length,
      refreshed: results.filter(Boolean).length,
      listFailed: false,
    }
  }

  const refreshAllVisibleTitles = async () => {
    const list = await deps.client.session
      .list({
        query: { directory: deps.directory },
        throwOnError: true,
      })
      .catch(swallow('refreshAllVisibleTitles:list'))
    if (!list?.data || !Array.isArray(list.data)) {
      return { attempted: 0, refreshed: 0, listFailed: true }
    }
    const sessions = list.data.filter(
      (session) => Boolean(session && typeof (session as { id?: unknown }).id === 'string'),
    )

    const results = await mapConcurrent(
      sessions,
      deps.restoreConcurrency,
      async (session) => applyTitle(session.id),
    )
    return {
      attempted: sessions.length,
      refreshed: results.filter(Boolean).length,
      listFailed: false,
    }
  }

  return {
    applyTitle,
    handleSessionUpdatedTitle,
    restoreSessionTitle,
    restoreAllVisibleTitles,
    refreshAllTouchedTitles,
    refreshAllVisibleTitles,
    forgetSession,
  }
}
