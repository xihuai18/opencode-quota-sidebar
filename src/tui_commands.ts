import type { TuiCommand } from '@opencode-ai/plugin/tui'

import type { HistoryPeriod } from './period.js'

type CommandDialog = {
  replace: (render: () => unknown, onClose?: () => void) => void
}

export function createHistoryCommands(
  openHistoryPrompt: (period: HistoryPeriod, dialog?: CommandDialog) => void,
): TuiCommand[] {
  return [
    {
      title: 'Quota Day History',
      value: 'quota.history.day',
      description: 'Open daily usage history chart',
      slash: { name: 'qday' },
      onSelect: ((dialog?: CommandDialog) =>
        openHistoryPrompt('day', dialog)) as unknown as () => void,
    },
    {
      title: 'Quota Week History',
      value: 'quota.history.week',
      description: 'Open weekly usage history chart',
      slash: { name: 'qweek' },
      onSelect: ((dialog?: CommandDialog) =>
        openHistoryPrompt('week', dialog)) as unknown as () => void,
    },
    {
      title: 'Quota Month History',
      value: 'quota.history.month',
      description: 'Open monthly usage history chart',
      slash: { name: 'qmonth' },
      onSelect: ((dialog?: CommandDialog) =>
        openHistoryPrompt('month', dialog)) as unknown as () => void,
    },
  ]
}
