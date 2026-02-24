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
  quotaRuntime: { normalizeProviderID: (providerID: string) => string }
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

  const forgetSession = (sessionID: string) => {
    pendingAppliedTitle.delete(sessionID)
  }

  const applyTitle = async (sessionID: string) => {
    if (!deps.config.sidebar.enabled || !deps.state.titleEnabled) return

    let stateMutated = false

    const session = await deps.client.session
      .get({
        path: { id: sessionID },
        query: { directory: deps.directory },
        throwOnError: true,
      })
      .catch(swallow('applyTitle:getSession'))

    if (!session) return

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
    const quotaProviders = Array.from(
      new Set(
        Object.keys(usage.providers).map((id) =>
          deps.quotaRuntime.normalizeProviderID(id),
        ),
      ),
    )

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
      return
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
      return
    }

    pendingAppliedTitle.delete(sessionID)
    deps.scheduleSave()
    deps.scheduleParentRefreshIfSafe(sessionID, sessionState.parentID)
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

    if (looksDecorated(args.incomingTitle)) {
      debug(`ignoring late decorated echo for session ${args.sessionID}`)
      return
    }

    args.sessionState.baseTitle = normalizeBaseTitle(args.incomingTitle)
    args.sessionState.lastAppliedTitle = undefined
    deps.markDirty(deps.state.sessionDateMap[args.sessionID])
    deps.scheduleSave()
    args.scheduleRefresh(args.sessionID)
  }

  const restoreSessionTitle = async (sessionID: string) => {
    const session = await deps.client.session
      .get({
        path: { id: sessionID },
        query: { directory: deps.directory },
        throwOnError: true,
      })
      .catch(swallow('restoreSessionTitle:get'))
    if (!session) return

    const sessionState = deps.ensureSessionState(
      sessionID,
      session.data.title,
      session.data.time.created,
      session.data.parentID ?? null,
    )
    const baseTitle = normalizeBaseTitle(sessionState.baseTitle)
    if (session.data.title === baseTitle) return

    await deps.client.session
      .update({
        path: { id: sessionID },
        query: { directory: deps.directory },
        body: { title: baseTitle },
        throwOnError: true,
      })
      .catch(swallow('restoreSessionTitle:update'))

    sessionState.lastAppliedTitle = undefined
    deps.markDirty(deps.state.sessionDateMap[sessionID])
    deps.scheduleSave()
  }

  const restoreAllVisibleTitles = async () => {
    const list = await deps.client.session
      .list({
        query: { directory: deps.directory },
        throwOnError: true,
      })
      .catch(swallow('restoreAllVisibleTitles:list'))
    if (!list?.data) return

    const touched = list.data.filter(
      (s) => deps.state.sessions[s.id]?.lastAppliedTitle,
    )
    await mapConcurrent(touched, deps.restoreConcurrency, async (s) => {
      await restoreSessionTitle(s.id)
    })
  }

  return {
    applyTitle,
    handleSessionUpdatedTitle,
    restoreSessionTitle,
    restoreAllVisibleTitles,
    forgetSession,
  }
}
