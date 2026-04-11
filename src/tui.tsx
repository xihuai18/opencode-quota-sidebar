/** @jsxImportSource @opentui/solid */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from '@opencode-ai/plugin/tui'
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'

import { fitLine, renderSidebarUsageLines } from './format.js'
import {
  API_COST_ENABLED_PROVIDERS,
  calcEquivalentApiCostForMessage,
  canonicalApiCostProviderID,
  getBundledModelCostMap,
  modelCostKey,
  modelCostLookupKeys,
  parseModelCostRates,
  type ModelCostRates,
} from './cost.js'
import { mapConcurrent } from './helpers.js'
import { parseSince, periodRanges, type HistoryPeriod } from './period.js'
import {
  fallbackQuotaGroupsFromTitle,
  quotaGroupsAreCollapsible,
  quotaGroupsSummary,
  quotaGroupsUseBullets,
  renderSidebarQuotaGroups,
  sidebarPanelQuotaSnapshots,
  type SidebarQuotaGroup,
} from './tui_helpers.js'
import {
  loadConfig,
  loadState,
  quotaConfigPaths,
  resolveOpencodeDataDir,
  scanAllSessions,
  stateFilePath,
} from './storage.js'
import { looksDecorated, normalizeBaseTitle } from './title.js'
import type { QuotaSidebarConfig } from './types.js'
import {
  emptyUsageSummary,
  fromCachedSessionUsage,
  mergeUsage,
  summarizeMessages,
  summarizeMessagesAcrossCompletedRanges,
  type UsageSummary,
} from './usage.js'

const id = 'leo.quota-sidebar'
const INTERNAL_CONTEXT_PLUGIN_ID = 'internal:sidebar-context'
const SECTION_INDENT = 2
const DEFAULT_WIDTH = 36

type SidebarPanelData = {
  enabled: boolean
  width: number
  usageLines: string[]
  quotaGroups: SidebarQuotaGroup[]
  compactTitle?: string
}

const latestCompactTitles = new Map<string, string>()
const [compactTitleVersion, setCompactTitleVersion] = createSignal(0)
const HISTORY_FETCH_CONCURRENCY = 5

type HistoryMetric = 'apiCost' | 'tokens' | 'requests'

type HistoryDialogRow = {
  label: string
  isCurrent: boolean
  usage: UsageSummary
}

type HistoryDialogData = {
  period: HistoryPeriod
  since: string
  rows: HistoryDialogRow[]
  total: UsageSummary
  warning?: string
}

const HISTORY_METRIC_OPTIONS: Array<{
  name: string
  description: string
  value: HistoryMetric
}> = [
  { name: 'API Cost', description: 'API cost', value: 'apiCost' },
  { name: 'Tokens', description: 'Total tokens', value: 'tokens' },
  { name: 'Requests', description: 'Assistant requests', value: 'requests' },
]

function pad2(value: number) {
  return `${value}`.padStart(2, '0')
}

function defaultSinceInput(period: HistoryPeriod, now = Date.now()) {
  const date = new Date(now)
  if (period === 'month') {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`
  }
  if (period === 'week') {
    const day = date.getDay()
    const shift = day === 0 ? 6 : day - 1
    const monday = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() - shift,
    )
    return `${monday.getFullYear()}-${pad2(monday.getMonth() + 1)}-${pad2(monday.getDate())}`
  }
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function metricValue(usage: UsageSummary, metric: HistoryMetric) {
  if (metric === 'requests') return usage.assistantMessages
  if (metric === 'tokens') return usage.total
  return usage.apiCost
}

function formatDialogUsd(value: number) {
  const safe = Number.isFinite(value) ? value : 0
  if (safe < 10) return `$${safe.toFixed(2)}`
  const one = safe.toFixed(1)
  return `$${one.endsWith('.0') ? one.slice(0, -2) : one}`
}

function resolvedHistoryMetric(api: TuiPluginApi): HistoryMetric {
  const raw = api.kv.ready
    ? api.kv.get<HistoryMetric>('quota-history-metric', 'apiCost')
    : 'apiCost'
  return HISTORY_METRIC_OPTIONS.some((option) => option.value === raw)
    ? raw
    : 'apiCost'
}

function historyPeriodLabel(period: HistoryPeriod) {
  if (period === 'day') return 'Daily'
  if (period === 'week') return 'Weekly'
  return 'Monthly'
}

function metricLabel(usage: UsageSummary, metric: HistoryMetric) {
  if (metric === 'requests') return `${usage.assistantMessages}`
  if (metric === 'tokens') return `${usage.total}`
  return formatDialogUsd(usage.apiCost)
}

function historyChartLine(
  label: string,
  value: number,
  maxValue: number,
  display: string,
  width: number,
) {
  const barWidth = Math.max(
    8,
    Math.min(24, width - label.length - display.length - 4),
  )
  const filled = maxValue > 0 ? Math.round((value / maxValue) * barWidth) : 0
  return fitLine(
    `${label} |${'#'.repeat(filled)}${' '.repeat(barWidth - filled)}| ${display}`,
    width,
  )
}

async function getDialogModelCostMap(api: TuiPluginApi) {
  const fallbackMap = getBundledModelCostMap()
  const all = api.state.provider || []
  return all.reduce<Record<string, ModelCostRates>>((acc, provider) => {
    const rawProviderID =
      typeof provider.id === 'string' ? provider.id : undefined
    if (
      !rawProviderID ||
      !provider.models ||
      typeof provider.models !== 'object'
    ) {
      return acc
    }

    for (const [modelKey, modelValue] of Object.entries(provider.models)) {
      if (!modelValue || typeof modelValue !== 'object') continue
      const record = modelValue as Record<string, unknown>
      const rates = parseModelCostRates(record.cost)
      if (!rates) continue
      const modelID = typeof record.id === 'string' ? record.id : modelKey
      const lookupKeys = new Set([
        ...modelCostLookupKeys(rawProviderID, modelID),
        ...modelCostLookupKeys(rawProviderID, modelKey),
        modelCostKey(rawProviderID, modelID),
      ])
      for (const key of lookupKeys) {
        acc[key] = rates
      }
    }
    return acc
  }, fallbackMap)
}

function calcDialogApiCost(
  message: Parameters<typeof calcEquivalentApiCostForMessage>[0],
  modelCostMap: Record<string, ModelCostRates>,
) {
  const providerID = canonicalApiCostProviderID(message.providerID)
  if (!API_COST_ENABLED_PROVIDERS.has(providerID)) return 0
  for (const key of modelCostLookupKeys(providerID, message.modelID)) {
    const rates = modelCostMap[key]
    if (!rates) continue
    return calcEquivalentApiCostForMessage(message, rates)
  }
  return 0
}

async function loadHistoryDialogData(
  api: TuiPluginApi,
  period: HistoryPeriod,
  sinceInput: string,
): Promise<HistoryDialogData> {
  const statePath = stateFilePath(resolveOpencodeDataDir())
  const state = await loadState(statePath)
  const since = parseSince(sinceInput)
  const ranges = periodRanges(period, since)
  const rows = ranges.map((range) => ({ range, usage: emptyUsageSummary() }))
  const total = emptyUsageSummary()
  const modelCostMap = await getDialogModelCostMap(api)
  const sessions = (await scanAllSessions(statePath, state)).filter(
    (session) => {
      if (session.state.createdAt > Date.now()) return false
      const lastMessageTime = session.state.cursor?.lastMessageTime
      if (
        typeof lastMessageTime === 'number' &&
        lastMessageTime < ranges[0]?.startAt
      ) {
        return false
      }
      return true
    },
  )

  const fetched = await mapConcurrent(
    sessions,
    HISTORY_FETCH_CONCURRENCY,
    async ({ sessionID }) => {
      try {
        const response = await api.client.session
          .messages({
            sessionID,
            directory: directoryPath(api),
          })
          .catch(() => undefined)
        const entries = Array.isArray(response?.data)
          ? response.data.map((item) => ({
              info: item.info,
            }))
          : []
        const normalizedEntries = entries as unknown as Parameters<
          typeof summarizeMessagesAcrossCompletedRanges
        >[0]
        const rangeUsage = summarizeMessagesAcrossCompletedRanges(
          normalizedEntries,
          rows.map((row) => ({
            startAt: row.range.startAt,
            endAt: row.range.endAt,
          })),
          {
            calcApiCost: (message) => calcDialogApiCost(message, modelCostMap),
          },
        )
        const sessionTotal = emptyUsageSummary()
        for (const usage of rangeUsage) {
          if (usage.assistantMessages > 0) mergeUsage(sessionTotal, usage)
        }
        if (sessionTotal.assistantMessages > 0) sessionTotal.sessionCount = 1
        return {
          rangeUsage,
          sessionTotal,
          failed: !Array.isArray(response?.data),
        }
      } catch {
        return {
          rangeUsage: rows.map(() => emptyUsageSummary()),
          sessionTotal: emptyUsageSummary(),
          failed: true,
        }
      }
    },
  )

  const failedSessions = fetched.filter((item) => item.failed).length

  for (const item of fetched) {
    for (let index = 0; index < rows.length; index++) {
      if (item.rangeUsage[index].assistantMessages > 0) {
        mergeUsage(rows[index].usage, item.rangeUsage[index])
      }
    }
    if (item.sessionTotal.assistantMessages > 0) {
      mergeUsage(total, item.sessionTotal)
    }
  }

  return {
    period,
    since: since.raw,
    rows: rows.map((row) => ({
      label: row.range.label,
      isCurrent: row.range.isCurrent,
      usage: row.usage,
    })),
    total,
    warning:
      failedSessions > 0
        ? `Skipped ${failedSessions} session(s) that could not be loaded.`
        : undefined,
  }
}

function directoryPath(api: TuiPluginApi) {
  return api.state.path.directory || process.cwd()
}

function worktreePath(api: TuiPluginApi) {
  return api.state.path.worktree || directoryPath(api)
}

function panelConfig(config: QuotaSidebarConfig): QuotaSidebarConfig {
  return {
    ...config,
    sidebar: {
      ...config.sidebar,
      width: Math.max(8, config.sidebar.width - SECTION_INDENT),
    },
  }
}

function resolveCompactTitle(sessionID: string, persistedTitle?: string) {
  const liveTitle = latestCompactTitles.get(sessionID)
  if (liveTitle && looksDecorated(liveTitle)) return liveTitle
  if (persistedTitle && looksDecorated(persistedTitle)) return persistedTitle
  return liveTitle || persistedTitle
}

async function loadSidebarPanel(
  api: TuiPluginApi,
  sessionID: string,
): Promise<SidebarPanelData> {
  const statePath = stateFilePath(resolveOpencodeDataDir())
  const config = await loadConfig(
    quotaConfigPaths(worktreePath(api), directoryPath(api)),
  )
  // Session payload lives in day chunks that the server updates from a
  // separate process, so TUI should re-read persisted state instead of keeping
  // an extra full-state cache here.
  const state = await loadState(statePath)
  const session = state.sessions[sessionID]
  const enabled = config.sidebar.enabled
  const width = Math.max(8, config.sidebar.width - SECTION_INDENT)
  const liveEntries = api.state.session.messages(sessionID).map((info) => ({
    info,
  })) as Parameters<typeof summarizeMessages>[0]

  const liveUsage = summarizeMessages(liveEntries, 0, 1)
  const cachedUsage = session?.sidebarPanel?.usage || session?.usage
  const persistedUsage = cachedUsage
    ? fromCachedSessionUsage(cachedUsage)
    : undefined
  const usage =
    liveUsage.assistantMessages > 0 &&
    (!persistedUsage ||
      liveUsage.assistantMessages > persistedUsage.assistantMessages ||
      (liveUsage.assistantMessages === persistedUsage.assistantMessages &&
        liveUsage.total >= persistedUsage.total))
      ? liveUsage
      : persistedUsage ||
        (liveUsage.assistantMessages > 0 ? liveUsage : undefined)
  const compactTitle = resolveCompactTitle(sessionID, session?.lastAppliedTitle)

  if (!enabled) {
    return {
      enabled,
      width,
      usageLines: [],
      quotaGroups: [],
      compactTitle: session?.lastAppliedTitle,
    }
  }

  const usageLines = usage
    ? renderSidebarUsageLines(usage, panelConfig(config))
    : []
  const quotaGroups = renderSidebarQuotaGroups(
    sidebarPanelQuotaSnapshots(session?.sidebarPanel),
    panelConfig(config),
  )

  return {
    enabled,
    width,
    usageLines,
    quotaGroups,
    compactTitle,
  }
}

function useSidebarPanelData(api: TuiPluginApi, sessionID: () => string) {
  const [panel, setPanel] = createSignal<SidebarPanelData | undefined>()
  let disposed = false
  let loadVersion = 0

  const reload = () => {
    const currentVersion = ++loadVersion
    const currentSessionID = sessionID()
    void loadSidebarPanel(api, currentSessionID)
      .then((next) => {
        if (disposed || currentVersion !== loadVersion) return
        setPanel(next)
      })
      .catch((error) => {
        if (disposed || currentVersion !== loadVersion) return
        void error
      })
  }

  reload()

  const timers = new Set<ReturnType<typeof setTimeout>>()
  const queueRefresh = (delay = 250) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      reload()
    }, delay)
    timers.add(timer)
  }

  const scheduleRefresh = () => {
    queueRefresh(150)
    queueRefresh(600)
  }

  // Bulk session sync populates messages asynchronously without emitting the
  // real-time message.updated events we listen to below. Retry a few times on
  // mount so historical sessions can render usage once the sync finishes.
  queueRefresh(500)
  queueRefresh(1_500)
  queueRefresh(4_000)

  const unsubscribers = [
    api.event.on('session.updated', (event) => {
      if (event.properties.info.id === sessionID()) {
        scheduleRefresh()
      }
    }),
    api.event.on('message.updated', (event) => {
      if (event.properties.info.sessionID === sessionID()) {
        scheduleRefresh()
      }
    }),
    api.event.on('message.removed', (event) => {
      if (event.properties.sessionID === sessionID()) {
        scheduleRefresh()
      }
    }),
    api.event.on('tui.session.select', (event) => {
      if (event.properties.sessionID === sessionID()) {
        scheduleRefresh()
      }
    }),
  ]

  onCleanup(() => {
    disposed = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const unsubscribe of unsubscribers) unsubscribe()
  })

  return panel
}

function SectionHeading(props: {
  api: TuiPluginApi
  value: string
  collapsible?: boolean
  open?: boolean
  summary?: string
  onToggle?: () => void
}) {
  const clickable = () => props.collapsible === true && props.onToggle

  return (
    <box
      flexDirection="row"
      gap={1}
      onMouseDown={() => {
        if (!clickable()) return
        props.onToggle?.()
      }}
    >
      <Show when={props.collapsible}>
        <text fg={props.api.theme.current.text}>{props.open ? '▼' : '▶'}</text>
      </Show>
      <text fg={props.api.theme.current.text}>
        <b>{props.value}</b>
        <Show when={props.summary}>
          <span style={{ fg: props.api.theme.current.textMuted }}>
            {' '}
            {props.summary}
          </span>
        </Show>
      </text>
    </box>
  )
}

function quotaToneColor(api: TuiPluginApi, tone: SidebarQuotaGroup['tone']) {
  const theme = api.theme.current
  if (tone === 'success') return theme.success
  if (tone === 'warning') return theme.warning
  if (tone === 'error') return theme.error
  return theme.textMuted
}

function QuotaGroupBlock(props: {
  api: TuiPluginApi
  group: SidebarQuotaGroup
  bullet: boolean
}) {
  const content = (
    <box gap={0}>
      <text>
        <span style={{ fg: props.api.theme.current.text }}>
          {props.group.shortLabel}
        </span>
        <Show when={props.group.detail}>
          <span style={{ fg: props.api.theme.current.textMuted }}>
            {' '}
            {props.group.detail}
          </span>
        </Show>
      </text>
      <For each={props.group.continuationLines}>
        {(line) => <text fg={props.api.theme.current.textMuted}>{line}</text>}
      </For>
    </box>
  )

  return (
    <Show when={props.bullet} fallback={content}>
      <box flexDirection="row" gap={1}>
        <text flexShrink={0} fg={quotaToneColor(props.api, props.group.tone)}>
          •
        </text>
        {content}
      </box>
    </Show>
  )
}

function fallbackUsageCostLineFromTitle(title: string, width: number) {
  const est = (title || '')
    .split(' | ')
    .map((part) => part.trim())
    .find((part) => /^Est\$/.test(part) || /^Est\s+\$/.test(part))
  if (!est) return undefined
  return fitLine(est.replace(/^Est\$/, 'Est $'), width)
}

function SidebarContentView(props: { api: TuiPluginApi; sessionID: string }) {
  const panel = useSidebarPanelData(props.api, () => props.sessionID)
  const [quotaOpen, setQuotaOpen] = createSignal(true)
  const width = createMemo(
    () => panel()?.width || DEFAULT_WIDTH - SECTION_INDENT,
  )
  const compactTitle = createMemo(() => {
    compactTitleVersion()
    return resolveCompactTitle(props.sessionID, panel()?.compactTitle) || ''
  })
  const usageLines = createMemo(() => {
    const liveLines = panel()?.usageLines || []
    const hasCostLine = liveLines.some((line) => /^Est\b/.test(line))
    if (hasCostLine) return liveLines
    const costLine = fallbackUsageCostLineFromTitle(compactTitle(), width())
    return costLine ? [...liveLines, costLine] : liveLines
  })
  const quotaGroups = createMemo(() => {
    const liveGroups = panel()?.quotaGroups || []
    if (liveGroups.length > 0) return liveGroups
    return fallbackQuotaGroupsFromTitle(compactTitle(), width())
  })
  const hasUsage = createMemo(() => usageLines().length > 0)
  const hasQuota = createMemo(() => quotaGroups().length > 0)
  const quotaBullets = createMemo(() => quotaGroupsUseBullets(quotaGroups()))
  const quotaCollapsible = createMemo(() =>
    quotaGroupsAreCollapsible(quotaGroups()),
  )
  const quotaSummary = createMemo(() => {
    if (!quotaCollapsible() || quotaOpen()) return undefined
    return quotaGroupsSummary(quotaGroups())
  })

  return (
    <box gap={0}>
      <Show when={hasUsage()}>
        <box gap={0}>
          <SectionHeading api={props.api} value="Usage" />
          <box gap={0}>
            <For each={usageLines()}>
              {(line) => (
                <text fg={props.api.theme.current.textMuted}>{line}</text>
              )}
            </For>
          </box>
        </box>
      </Show>

      <Show when={hasQuota()}>
        <box paddingTop={hasUsage() ? 1 : 0} gap={0}>
          <SectionHeading
            api={props.api}
            value="Quota"
            collapsible={quotaCollapsible()}
            open={quotaOpen()}
            summary={quotaSummary()}
            onToggle={() => setQuotaOpen((value) => !value)}
          />
          <Show when={!quotaCollapsible() || quotaOpen()}>
            <box gap={0}>
              <For each={quotaGroups()}>
                {(group) => (
                  <QuotaGroupBlock
                    api={props.api}
                    group={group}
                    bullet={quotaBullets()}
                  />
                )}
              </For>
            </box>
          </Show>
        </box>
      </Show>
    </box>
  )
}

function SidebarTitleView(props: {
  api: TuiPluginApi
  sessionID: string
  title: string
  shareURL?: string
}) {
  const panel = useSidebarPanelData(props.api, () => props.sessionID)
  const width = createMemo(
    () => panel()?.width || DEFAULT_WIDTH - SECTION_INDENT,
  )
  const titleLines = createMemo(() => {
    const baseTitle = normalizeBaseTitle(props.title || 'Session') || 'Session'
    return baseTitle
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => fitLine(line, width()))
  })
  const shareLine = createMemo(() =>
    props.shareURL ? fitLine(props.shareURL, width()) : undefined,
  )

  return (
    <box gap={0} paddingRight={1}>
      <box gap={0}>
        <For each={titleLines()}>
          {(line) => (
            <text fg={props.api.theme.current.text}>
              <b>{line}</b>
            </text>
          )}
        </For>
        <Show when={shareLine()}>
          <text fg={props.api.theme.current.textMuted}>{shareLine()}</text>
        </Show>
      </box>
    </box>
  )
}

function HistoryDialogView(props: {
  api: TuiPluginApi
  period: HistoryPeriod
  sinceInput: string
}) {
  const [metric, setMetric] = createSignal<HistoryMetric>(
    resolvedHistoryMetric(props.api),
  )
  const [data, setData] = createSignal<HistoryDialogData | undefined>()
  const [error, setError] = createSignal<string | undefined>()
  let metricTabs: { setSelectedIndex: (index: number) => void } | undefined

  let disposed = false
  void loadHistoryDialogData(props.api, props.period, props.sinceInput)
    .then((value) => {
      if (disposed) return
      setData(value)
    })
    .catch((reason) => {
      if (disposed) return
      setError(reason instanceof Error ? reason.message : String(reason))
    })

  onCleanup(() => {
    disposed = true
  })

  const rows = createMemo(() => data()?.rows || [])
  const maxValue = createMemo(() =>
    rows().reduce(
      (max, row) => Math.max(max, metricValue(row.usage, metric())),
      0,
    ),
  )
  const total = createMemo(() => data()?.total || emptyUsageSummary())

  return props.api.ui.Dialog({
    size: 'large',
    onClose: () => props.api.ui.dialog.clear(),
    children: (
      <box flexDirection="column" gap={1}>
        <text fg={props.api.theme.current.text}>
          <b>{`${historyPeriodLabel(props.period)} Usage since ${props.sinceInput.trim()}`}</b>
        </text>
        <tab_select
          ref={(value) => {
            metricTabs = value as { setSelectedIndex: (index: number) => void }
            const index = Math.max(
              0,
              HISTORY_METRIC_OPTIONS.findIndex(
                (option) => option.value === metric(),
              ),
            )
            queueMicrotask(() => metricTabs?.setSelectedIndex(index))
          }}
          focused={true}
          options={HISTORY_METRIC_OPTIONS}
          onChange={(_index, option) => {
            const value = (option?.value || 'apiCost') as HistoryMetric
            setMetric(value)
            if (props.api.kv.ready) {
              props.api.kv.set('quota-history-metric', value)
            }
          }}
        />
        <Show
          when={!error()}
          fallback={<text fg={props.api.theme.current.error}>{error()}</text>}
        >
          <Show
            when={data()}
            fallback={
              <text fg={props.api.theme.current.textMuted}>
                Loading history...
              </text>
            }
          >
            <scrollbox height={Math.max(6, Math.min(14, rows().length + 1))}>
              <box flexDirection="column" gap={0}>
                <For each={rows()}>
                  {(row) => (
                    <text
                      fg={
                        row.isCurrent
                          ? props.api.theme.current.text
                          : props.api.theme.current.textMuted
                      }
                    >
                      {historyChartLine(
                        row.isCurrent ? `${row.label}*` : row.label,
                        metricValue(row.usage, metric()),
                        maxValue(),
                        metricLabel(row.usage, metric()),
                        56,
                      )}
                    </text>
                  )}
                </For>
              </box>
            </scrollbox>
            <text fg={props.api.theme.current.text}>
              <b>Total</b>
            </text>
            <text
              fg={props.api.theme.current.textMuted}
            >{`Requests ${total().assistantMessages}`}</text>
            <text
              fg={props.api.theme.current.textMuted}
            >{`Tokens ${total().total}`}</text>
            <text
              fg={props.api.theme.current.textMuted}
            >{`API Cost ${formatDialogUsd(total().apiCost)}`}</text>
            <Show when={data()?.warning}>
              <text fg={props.api.theme.current.warning}>
                {data()?.warning}
              </text>
            </Show>
            <text fg={props.api.theme.current.textMuted}>
              ESC close, Left/Right switch metric
            </text>
          </Show>
        </Show>
      </box>
    ),
  })
}

function openHistoryDialog(
  api: TuiPluginApi,
  period: HistoryPeriod,
  sinceInput: string,
) {
  api.ui.dialog.replace(() => HistoryDialogView({ api, period, sinceInput }))
}

function openHistoryPrompt(api: TuiPluginApi, period: HistoryPeriod) {
  const initialValue = defaultSinceInput(period)
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: `${historyPeriodLabel(period)} History`,
      placeholder: period === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD',
      value: initialValue,
      onConfirm: (value) => {
        const nextValue = String(value).trim() || initialValue
        openHistoryDialog(api, period, nextValue)
      },
      onCancel: () => api.ui.dialog.clear(),
    }),
  )
}

const tui: TuiPlugin = async (api) => {
  const config = await loadConfig(
    quotaConfigPaths(worktreePath(api), directoryPath(api)),
  )
  let didDeactivateContext = false
  if (config.sidebar.enabled) {
    const contextPlugin = api.plugins
      .list()
      .find((item) => item.id === INTERNAL_CONTEXT_PLUGIN_ID)
    if (contextPlugin?.active) {
      didDeactivateContext = await api.plugins
        .deactivate(INTERNAL_CONTEXT_PLUGIN_ID)
        .catch(() => false)
    }
  }
  api.lifecycle.onDispose(() => {
    if (!didDeactivateContext) return
    return api.plugins
      .activate(INTERNAL_CONTEXT_PLUGIN_ID)
      .then(() => undefined)
      .catch(() => undefined)
  })

  const unregisterCommands = api.command.register(() => [
    {
      title: 'Quota Day History',
      value: 'quota.history.day',
      description: 'Open daily usage history chart',
      slash: { name: 'qday' },
      onSelect: () => openHistoryPrompt(api, 'day'),
    },
    {
      title: 'Quota Week History',
      value: 'quota.history.week',
      description: 'Open weekly usage history chart',
      slash: { name: 'qweek' },
      onSelect: () => openHistoryPrompt(api, 'week'),
    },
    {
      title: 'Quota Month History',
      value: 'quota.history.month',
      description: 'Open monthly usage history chart',
      slash: { name: 'qmonth' },
      onSelect: () => openHistoryPrompt(api, 'month'),
    },
  ])
  api.lifecycle.onDispose(unregisterCommands)

  api.slots.register({
    order: 100,
    slots: {
      sidebar_title(
        _ctx: unknown,
        props: { session_id: string; title: string; share_url?: string },
      ) {
        if (latestCompactTitles.get(props.session_id) !== props.title) {
          latestCompactTitles.set(props.session_id, props.title)
          setCompactTitleVersion((value) => value + 1)
        }
        return (
          <SidebarTitleView
            api={api}
            sessionID={props.session_id}
            title={props.title}
            shareURL={props.share_url}
          />
        )
      },
      sidebar_content(_ctx: unknown, props: { session_id: string }) {
        return <SidebarContentView api={api} sessionID={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
