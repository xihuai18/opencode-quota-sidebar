import * as z from 'zod'
import { sinceFromLast } from './period.js'
import {
  filterHistoryProvidersForDisplay,
  filterUsageProvidersForDisplay,
} from './provider_catalog.js'
import type { QuotaSnapshot } from './types.js'
import type { UsageSummary } from './usage.js'
import type { HistoryPeriod } from './period.js'
import type { HistoryUsageResult } from './usage_service.js'

type ToolContext = {
  sessionID: string
}

function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute: (
    args: z.infer<z.ZodObject<Args>>,
    context: ToolContext,
  ) => Promise<string>
}) {
  return input
}

export function createQuotaSidebarTools(deps: {
  getTitleEnabled: () => boolean
  setTitleEnabled: (enabled: boolean) => void
  scheduleSave: () => void
  flushSave: () => Promise<void>
  waitForStartupTitleWork: () => Promise<void>
  markSessionActive?: (sessionID: string) => void
  refreshSessionTitle: (sessionID: string, delay?: number) => void
  cancelAllTitleRefreshes: () => void
  flushScheduledTitleRefreshes: () => Promise<void>
  waitForTitleRefreshIdle: () => Promise<void>
  waitForTitleRefreshQuiescence: () => Promise<void>
  restoreSessionTitle?: (sessionID: string) => Promise<boolean>
  showToast: (
    period: 'session' | 'day' | 'week' | 'month' | 'toggle',
    message: string,
  ) => Promise<void>
  summarizeForTool: (
    period: 'session' | 'day' | 'week' | 'month',
    sessionID: string,
    includeChildren: boolean,
  ) => Promise<UsageSummary>
  summarizeHistoryForTool: (
    period: HistoryPeriod,
    since: string,
  ) => Promise<HistoryUsageResult>
  listCurrentProviderIDs?: () => Promise<Set<string>>
  getQuotaSnapshots: (
    providerIDs: string[],
    options?: { allowDefault?: boolean },
  ) => Promise<QuotaSnapshot[]>
  renderMarkdownReport: (
    period: string,
    usage: UsageSummary,
    quotas: QuotaSnapshot[],
    options?: { showCost?: boolean },
  ) => string
  renderToastMessage: (
    period: string,
    usage: UsageSummary,
    quotas: QuotaSnapshot[],
    options?: { showCost?: boolean; width?: number },
  ) => string
  renderHistoryMarkdownReport: (
    result: HistoryUsageResult,
    quotas: QuotaSnapshot[],
    options?: { showCost?: boolean },
  ) => string
  config: {
    sidebar: { showCost: boolean; width: number; includeChildren: boolean }
    sidebarEnabled: boolean
  }
}) {
  let toggleLock = Promise.resolve()

  const waitForStartupTitleWork = async () => {
    const timedOut = await Promise.race([
      deps.waitForStartupTitleWork(),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 3_000)),
    ])
    return timedOut === 'timeout'
  }

  return {
    quota_summary: tool({
      description:
        'Show usage and quota summary for session/day/week/month. Returns the full markdown report with totals, highlights, provider table, and subscription quota so callers can present the report directly to the user.',
      args: {
        period: z.enum(['session', 'day', 'week', 'month']).optional(),
        since: z
          .string()
          .optional()
          .describe('Historical start date: `YYYY-MM` or `YYYY-MM-DD`.'),
        last: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Relative history length. Examples: `period=day,last=7`, `period=week,last=8`, `period=month,last=6`.',
          ),
        toast: z.boolean().optional(),
        includeChildren: z
          .boolean()
          .optional()
          .describe(
            'For period=session, include descendant subagent sessions in usage aggregation.',
          ),
      },
      execute: async (args, context) => {
        const period =
          args.period || (args.since || args.last ? 'month' : 'session')
        const since = args.since?.trim()
        const last = args.last
        if (since && last !== undefined) {
          throw new Error('`since` and `last` cannot be used together')
        }
        if (period === 'session' && since) {
          throw new Error('`since` is not supported when `period=session`')
        }
        if (period === 'session' && last !== undefined) {
          throw new Error('`last` is not supported when `period=session`')
        }

        const resolvedSince =
          since ||
          (period !== 'session' && last !== undefined
            ? sinceFromLast(period, last)
            : undefined)
        const allowedProviderIDs = await deps
          .listCurrentProviderIDs?.()
          .catch(() => new Set<string>())

        if (period !== 'session' && resolvedSince) {
          const historyRaw = await deps.summarizeHistoryForTool(
            period,
            resolvedSince,
          )
          const history = allowedProviderIDs
            ? filterHistoryProvidersForDisplay(historyRaw, allowedProviderIDs)
            : historyRaw
          const quotas = await deps.getQuotaSnapshots([], {
            allowDefault: true,
          })
          const markdown = deps.renderHistoryMarkdownReport(history, quotas, {
            showCost: deps.config.sidebar.showCost,
          })

          if (args.toast === true) {
            await deps.showToast(
              period,
              deps.renderToastMessage(period, history.total, quotas, {
                showCost: deps.config.sidebar.showCost,
                width: Math.max(44, deps.config.sidebar.width + 18),
              }),
            )
          }

          return markdown
        }

        const includeChildren =
          period === 'session'
            ? (args.includeChildren ?? deps.config.sidebar.includeChildren)
            : false

        const usageRaw = await deps.summarizeForTool(
          period,
          context.sessionID,
          includeChildren,
        )
        const usage = allowedProviderIDs
          ? filterUsageProvidersForDisplay(usageRaw, allowedProviderIDs)
          : usageRaw

        // For quota_summary, always show all subscription quota balances,
        // regardless of which providers were used in the session.
        const quotas = await deps.getQuotaSnapshots([], { allowDefault: true })
        const markdown = deps.renderMarkdownReport(period, usage, quotas, {
          showCost: deps.config.sidebar.showCost,
        })

        if (args.toast !== false) {
          await deps.showToast(
            period,
            deps.renderToastMessage(period, usage, quotas, {
              showCost: deps.config.sidebar.showCost,
              width: Math.max(44, deps.config.sidebar.width + 18),
            }),
          )
        }

        return markdown
      },
    }),

    quota_show: tool({
      description:
        'Toggle sidebar title display mode. When on, titles show token usage and quota; when off, titles revert to original. Returns a user-facing status message that callers should present directly.',
      args: {
        enabled: z
          .boolean()
          .optional()
          .describe('Explicit on/off. Omit to toggle current state.'),
      },
      execute: async (args, context) => {
        const run = async () => {
          const current = deps.getTitleEnabled()
          const next = args.enabled !== undefined ? args.enabled : !current

          if (next) {
            if (!deps.config.sidebarEnabled) {
              return 'Sidebar usage display cannot be enabled because `sidebar.enabled=false` in config. Re-enable the sidebar feature first.'
            }
            const startupTimedOut = await waitForStartupTitleWork()
            deps.setTitleEnabled(true)
            deps.scheduleSave()
            await deps.flushSave()

            deps.markSessionActive?.(context.sessionID)
            deps.refreshSessionTitle(context.sessionID, 0)
            if (startupTimedOut) {
              void deps.waitForStartupTitleWork().then(() => {
                if (!deps.getTitleEnabled()) return
                deps.markSessionActive?.(context.sessionID)
                deps.refreshSessionTitle(context.sessionID, 0)
              })
            }
            await deps.showToast('toggle', 'Sidebar usage display: ON')
            return 'Sidebar usage display is now ON. Only assistant-active sessions will refresh shared titles.'
          }

          deps.setTitleEnabled(false)
          deps.scheduleSave()
          await deps.flushSave()
          deps.cancelAllTitleRefreshes()
          await deps.waitForTitleRefreshQuiescence()
          const restoredCurrent = await (deps.restoreSessionTitle
            ? deps.restoreSessionTitle(context.sessionID)
            : Promise.resolve(false))
          if (restoredCurrent) {
            await deps.showToast('toggle', 'Sidebar usage display: OFF')
            return 'Sidebar usage display is now OFF. The current session title was restored to its base title.'
          }

          deps.setTitleEnabled(true)
          deps.scheduleSave()
          await deps.flushSave()
          deps.markSessionActive?.(context.sessionID)
          deps.refreshSessionTitle(context.sessionID, 0)
          await deps.showToast('toggle', 'Sidebar usage display: OFF failed')
          return 'Sidebar usage display remains ON because some touched session titles could not be restored. Try again after the session service recovers.'
        }

        const pending = toggleLock.then(run, run)
        toggleLock = pending.then(
          () => undefined,
          () => undefined,
        )
        return pending
      },
    }),
  }
}
