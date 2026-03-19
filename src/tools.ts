import { tool } from '@opencode-ai/plugin/tool'
import type { QuotaSnapshot } from './types.js'
import type { UsageSummary } from './usage.js'

const z = tool.schema

export function createQuotaSidebarTools(deps: {
  getTitleEnabled: () => boolean
  setTitleEnabled: (enabled: boolean) => void
  scheduleSave: () => void
  flushSave: () => Promise<void>
  waitForStartupTitleWork: () => Promise<void>
  refreshSessionTitle: (sessionID: string, delay?: number) => void
  cancelAllTitleRefreshes: () => void
  flushScheduledTitleRefreshes: () => Promise<void>
  waitForTitleRefreshIdle: () => Promise<void>
  restoreAllVisibleTitles: () => Promise<{
    attempted: number
    restored: number
    listFailed: boolean
  }>
  refreshAllTouchedTitles: () => Promise<void>
  refreshAllVisibleTitles: () => Promise<{
    attempted: number
    refreshed: number
    listFailed: boolean
  }>
  showToast: (
    period: 'session' | 'day' | 'week' | 'month' | 'toggle',
    message: string,
  ) => Promise<void>
  summarizeForTool: (
    period: 'session' | 'day' | 'week' | 'month',
    sessionID: string,
    includeChildren: boolean,
  ) => Promise<UsageSummary>
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
  config: {
    sidebar: { showCost: boolean; width: number; includeChildren: boolean }
  }
}) {
  let toggleLock = Promise.resolve()

  const waitForStartupTitleWork = async () => {
    await Promise.race([
      deps.waitForStartupTitleWork(),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ])
  }

  return {
    quota_summary: tool({
      description: 'Show usage and quota summary for session/day/week/month.',
      args: {
        period: z.enum(['session', 'day', 'week', 'month']).optional(),
        toast: z.boolean().optional(),
        includeChildren: z
          .boolean()
          .optional()
          .describe(
            'For period=session, include descendant subagent sessions in usage aggregation.',
          ),
      },
      execute: async (args, context) => {
        const period = args.period || 'session'
        const includeChildren =
          period === 'session'
            ? (args.includeChildren ?? deps.config.sidebar.includeChildren)
            : false

        const usage = await deps.summarizeForTool(
          period,
          context.sessionID,
          includeChildren,
        )

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
        'Toggle sidebar title display mode. When on, titles show token usage and quota; when off, titles revert to original.',
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
            await waitForStartupTitleWork()
            deps.setTitleEnabled(true)
            deps.scheduleSave()
            await deps.flushSave()

            const visible = await deps.refreshAllVisibleTitles()
            await deps.refreshAllTouchedTitles()
            deps.refreshSessionTitle(context.sessionID, 0)
            await deps.showToast('toggle', 'Sidebar usage display: ON')
            if (visible.listFailed) {
              return 'Sidebar usage display is now ON. Visible-session refresh failed, so only touched/current session titles are guaranteed to refresh immediately.'
            }
            return 'Sidebar usage display is now ON. Visible session titles are refreshing to show token usage and quota.'
          }

          deps.setTitleEnabled(false)
          deps.scheduleSave()
          await deps.flushSave()
          deps.cancelAllTitleRefreshes()
          await deps.flushScheduledTitleRefreshes()
          await deps.waitForTitleRefreshIdle()
          const restore = await deps.restoreAllVisibleTitles()
          if (restore.restored === restore.attempted) {
            await deps.showToast('toggle', 'Sidebar usage display: OFF')
            return 'Sidebar usage display is now OFF. Touched session titles were restored to base titles.'
          }

          deps.setTitleEnabled(true)
          deps.scheduleSave()
          await deps.flushSave()
          await deps.refreshAllVisibleTitles()
          await deps.refreshAllTouchedTitles()
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
