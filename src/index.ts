import path from 'node:path'

import type { AssistantMessage, Event, Message } from '@opencode-ai/sdk'
import { type Hooks, type PluginInput } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'

import {
  renderMarkdownReport,
  renderSidebarTitle,
  renderToastMessage,
} from './format.js'
import {
  fetchQuotaSnapshot,
  loadAuthMap,
  normalizeProviderID,
} from './quota.js'
import {
  authFilePath,
  loadConfig,
  loadState,
  resolveOpencodeDataDir,
  saveState,
  stateFilePath,
} from './storage.js'
import type { QuotaSnapshot } from './types.js'
import {
  buildPricingTable,
  emptyUsageSummary,
  mergeUsage,
  summarizeMessages,
  type PricingTable,
} from './usage.js'

const z = tool.schema

function normalizeBaseTitle(title: string) {
  return title.split(/\r?\n/, 1)[0] || 'Session'
}

function periodStart(period: 'day' | 'week' | 'month') {
  const now = new Date()
  if (period === 'month') {
    return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  }
  if (period === 'week') {
    const day = now.getDay()
    const shift = day === 0 ? 6 : day - 1
    const start = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - shift,
    )
    start.setHours(0, 0, 0, 0)
    return start.getTime()
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.role === 'assistant'
}

function quotaSort(left: QuotaSnapshot, right: QuotaSnapshot) {
  const order: Record<string, number> = {
    openai: 0,
    'github-copilot': 1,
    anthropic: 2,
  }
  const leftOrder = order[left.providerID] ?? 99
  const rightOrder = order[right.providerID] ?? 99
  if (leftOrder !== rightOrder) return leftOrder - rightOrder
  return left.providerID.localeCompare(right.providerID)
}

export async function QuotaSidebarPlugin(input: PluginInput): Promise<Hooks> {
  const config = await loadConfig([
    path.join(input.directory, 'quota-sidebar.config.json'),
    path.join(input.worktree, 'quota-sidebar.config.json'),
  ])

  const dataDir = resolveOpencodeDataDir()
  const statePath = stateFilePath(dataDir)
  const authPath = authFilePath(dataDir)

  const state = await loadState(statePath)
  const refreshTimer = new Map<string, ReturnType<typeof setTimeout>>()

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let pricing: PricingTable = new Map()
  let pricingExpiresAt = 0

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      void saveState(statePath, state).catch(() => undefined)
    }, 200)
  }

  const ensureSessionState = (sessionID: string, title: string) => {
    const existing = state.sessions[sessionID]
    if (existing) return existing
    const created = {
      baseTitle: normalizeBaseTitle(title),
      lastAppliedTitle: undefined,
    }
    state.sessions[sessionID] = created
    return created
  }

  const refreshPricing = async () => {
    if (pricingExpiresAt > Date.now()) return pricing

    const response = await input.client.provider
      .list({
        query: { directory: input.directory },
        throwOnError: true,
      })
      .catch(() => undefined)

    const table = buildPricingTable(response?.data)
    // Only cache if we got actual pricing data; otherwise retry next call
    if (table.size > 0) {
      pricing = table
      pricingExpiresAt = Date.now() + 10 * 60 * 1000
    }
    return pricing.size > 0 ? pricing : table
  }

  const loadSessionEntries = async (sessionID: string) => {
    const response = await input.client.session
      .messages({
        path: { id: sessionID },
        query: { directory: input.directory },
        throwOnError: true,
      })
      .catch(() => undefined)
    return response?.data ?? []
  }

  const summarizeSessionUsage = async (sessionID: string) => {
    const [entries, priceTable] = await Promise.all([
      loadSessionEntries(sessionID),
      refreshPricing(),
    ])
    const usage = summarizeMessages(entries, priceTable, 0, 1)
    usage.sessionCount = 1
    return usage
  }

  const MAX_RANGE_SESSIONS = 50

  const summarizeRangeUsage = async (period: 'day' | 'week' | 'month') => {
    const startAt = periodStart(period)
    const [priceTable, list] = await Promise.all([
      refreshPricing(),
      input.client.session
        .list({
          // The server supports `start` and `limit` query params but the
          // generated SDK types don't expose them. Pass via assertion.
          query: {
            directory: input.directory,
            start: startAt,
            limit: MAX_RANGE_SESSIONS,
          } as { directory?: string },
          throwOnError: true,
        })
        .catch(() => undefined),
    ])

    const sessions = (list?.data ?? []).filter((session) => {
      return session.time.updated >= startAt || session.time.created >= startAt
    })

    const usage = emptyUsageSummary()
    usage.sessionCount = sessions.length

    const chunks = await Promise.all(
      sessions.map(async (session) => {
        const entries = await loadSessionEntries(session.id)
        return summarizeMessages(entries, priceTable, startAt, 1)
      }),
    )

    for (const chunk of chunks) mergeUsage(usage, chunk)
    return usage
  }

  const getQuotaSnapshots = async (providerIDs: string[]) => {
    const normalized = Array.from(
      new Set(providerIDs.map((providerID) => normalizeProviderID(providerID))),
    )
    const authMap = await loadAuthMap(authPath)

    const candidates = normalized.length
      ? normalized
      : (['openai', 'github-copilot', 'anthropic'] as Array<
          'openai' | 'github-copilot' | 'anthropic'
        >)

    const fetched = await Promise.all(
      candidates.map(async (providerID) => {
        const cached = state.quotaCache[providerID]
        if (cached && Date.now() - cached.checkedAt <= config.quota.refreshMs)
          return cached
        const latest = await fetchQuotaSnapshot(
          providerID,
          authMap,
          config,
          async (id, auth) => {
            await input.client.auth
              .set({
                path: { id },
                query: { directory: input.directory },
                body: {
                  type: auth.type,
                  access: auth.access,
                  refresh: auth.refresh,
                  expires: auth.expires,
                  enterpriseUrl: auth.enterpriseUrl,
                },
                throwOnError: true,
              })
              .catch(() => undefined)
          },
        )
        if (!latest) return undefined
        state.quotaCache[providerID] = latest
        return latest
      }),
    )

    const snapshots = fetched.filter((value): value is QuotaSnapshot =>
      Boolean(value),
    )
    snapshots.sort(quotaSort)
    scheduleSave()
    return snapshots
  }

  const applyTitle = async (sessionID: string) => {
    if (!config.sidebar.enabled) return

    const session = await input.client.session
      .get({
        path: { id: sessionID },
        query: { directory: input.directory },
        throwOnError: true,
      })
      .catch(() => undefined)

    if (!session) return

    const sessionState = ensureSessionState(sessionID, session.data.title)
    if (session.data.title !== sessionState.lastAppliedTitle) {
      sessionState.baseTitle = normalizeBaseTitle(session.data.title)
      sessionState.lastAppliedTitle = undefined
    }

    const usage = await summarizeSessionUsage(sessionID)
    const providers = Object.keys(usage.providers)
    const quotas = await getQuotaSnapshots(providers)
    const nextTitle = renderSidebarTitle(
      sessionState.baseTitle,
      usage,
      quotas,
      config,
    )

    if (nextTitle === session.data.title) return

    const updated = await input.client.session
      .update({
        path: { id: sessionID },
        query: { directory: input.directory },
        body: { title: nextTitle },
        throwOnError: true,
      })
      .catch(() => undefined)

    if (!updated) return
    sessionState.lastAppliedTitle = nextTitle
    scheduleSave()
  }

  const scheduleTitleRefresh = (sessionID: string, delay = 250) => {
    const previous = refreshTimer.get(sessionID)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      refreshTimer.delete(sessionID)
      void applyTitle(sessionID).catch(() => undefined)
    }, delay)
    refreshTimer.set(sessionID, timer)
  }

  const resetSessionTitle = async (sessionID: string) => {
    const session = await input.client.session
      .get({
        path: { id: sessionID },
        query: { directory: input.directory },
        throwOnError: true,
      })
      .catch(() => undefined)
    if (!session) return false

    const sessionState = ensureSessionState(sessionID, session.data.title)
    const baseTitle = normalizeBaseTitle(sessionState.baseTitle)
    const updated = await input.client.session
      .update({
        path: { id: sessionID },
        query: { directory: input.directory },
        body: { title: baseTitle },
        throwOnError: true,
      })
      .catch(() => undefined)

    if (!updated) return false
    sessionState.baseTitle = baseTitle
    sessionState.lastAppliedTitle = undefined
    scheduleSave()
    return true
  }

  const summarizeForTool = async (
    period: 'session' | 'day' | 'week' | 'month',
    sessionID: string,
  ) => {
    if (period === 'session') return summarizeSessionUsage(sessionID)
    return summarizeRangeUsage(period)
  }

  const showToast = async (
    period: 'session' | 'day' | 'week' | 'month',
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
      .catch(() => undefined)
  }

  const onEvent = async (event: Event) => {
    if (event.type === 'session.created') {
      ensureSessionState(event.properties.info.id, event.properties.info.title)
      scheduleSave()
      return
    }

    if (event.type === 'session.updated') {
      const sessionState = ensureSessionState(
        event.properties.info.id,
        event.properties.info.title,
      )
      if (event.properties.info.title === sessionState.lastAppliedTitle) return
      sessionState.baseTitle = normalizeBaseTitle(event.properties.info.title)
      sessionState.lastAppliedTitle = undefined
      scheduleSave()
      // External rename detected — re-render sidebar with new base title
      scheduleTitleRefresh(event.properties.info.id)
      return
    }

    if (event.type === 'message.removed') {
      scheduleTitleRefresh(event.properties.sessionID)
      return
    }

    if (event.type !== 'message.updated') return
    if (!isAssistantMessage(event.properties.info)) return
    if (!event.properties.info.time.completed) return
    scheduleTitleRefresh(event.properties.info.sessionID)
  }

  return {
    event: async ({ event }) => {
      await onEvent(event)
    },
    tool: {
      quota_show: tool({
        description: 'Show usage and quota summary for session/day/week/month.',
        args: {
          period: z.enum(['session', 'day', 'week', 'month']).optional(),
          toast: z.boolean().optional(),
        },
        execute: async (args, context) => {
          const period = args.period || 'session'
          const usage = await summarizeForTool(period, context.sessionID)
          const quotas = await getQuotaSnapshots(Object.keys(usage.providers))
          const markdown = renderMarkdownReport(period, usage, quotas)

          if (args.toast !== false) {
            await showToast(period, renderToastMessage(period, usage, quotas))
          }

          return markdown
        },
      }),
      quota_reset_title: tool({
        description: 'Reset current session title to its base line.',
        args: {
          session_id: z.string().optional(),
        },
        execute: async (args, context) => {
          const sessionID = args.session_id || context.sessionID
          const ok = await resetSessionTitle(sessionID)
          if (!ok) return `Failed to reset title for session ${sessionID}.`
          return `Reset title for session ${sessionID}.`
        },
      }),
    },
  }
}

export default QuotaSidebarPlugin
