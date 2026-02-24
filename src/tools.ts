import { tool } from '@opencode-ai/plugin/tool'
import type { QuotaSnapshot } from './types.js'
import type { UsageSummary } from './usage.js'

const z = tool.schema

export function createQuotaSidebarTools(deps: {
  getTitleEnabled: () => boolean
  setTitleEnabled: (enabled: boolean) => void
  scheduleSave: () => void
  refreshSessionTitle: (sessionID: string, delay?: number) => void
  restoreAllVisibleTitles: () => Promise<void>
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
        deps.scheduleSave()

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
        const current = deps.getTitleEnabled()
        const next = args.enabled !== undefined ? args.enabled : !current
        deps.setTitleEnabled(next)
        deps.scheduleSave()

        if (next) {
          // Turning on — re-render current session immediately
          deps.refreshSessionTitle(context.sessionID, 0)
          await deps.showToast('toggle', 'Sidebar usage display: ON')
          return 'Sidebar usage display is now ON. Session titles will show token usage and quota.'
        }

        // Turning off — restore all touched sessions to base titles
        await deps.restoreAllVisibleTitles()
        await deps.showToast('toggle', 'Sidebar usage display: OFF')
        return 'Sidebar usage display is now OFF. Session titles restored to original.'
      },
    }),
  }
}
