import type { TuiCommand } from '@opencode-ai/plugin/tui'

import type { HistoryPeriod } from './period.js'

export function createHistoryCommands(
  openHistoryPrompt: (period: HistoryPeriod) => void,
): TuiCommand[] {
  return [
    {
      title: 'Quota Day History',
      value: 'quota.history.day',
      description: 'Open daily usage history chart',
      slash: { name: 'qday' },
      onSelect: () => openHistoryPrompt('day'),
    },
    {
      title: 'Quota Week History',
      value: 'quota.history.week',
      description: 'Open weekly usage history chart',
      slash: { name: 'qweek' },
      onSelect: () => openHistoryPrompt('week'),
    },
    {
      title: 'Quota Month History',
      value: 'quota.history.month',
      description: 'Open monthly usage history chart',
      slash: { name: 'qmonth' },
      onSelect: () => openHistoryPrompt('month'),
    },
  ]
}
