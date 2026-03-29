/** @jsxImportSource @opentui/solid */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from '@opencode-ai/plugin/tui'
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'

import {
  fitLine,
  renderSidebarQuotaLines,
  renderSidebarUsageLines,
} from './format.js'
import {
  loadConfig,
  loadState,
  quotaConfigPaths,
  resolveOpencodeDataDir,
  stateFilePath,
} from './storage.js'
import { looksDecorated, normalizeBaseTitle } from './title.js'
import type { QuotaSidebarConfig } from './types.js'
import { fromCachedSessionUsage, summarizeMessages } from './usage.js'

const id = 'leo.quota-sidebar'
const INTERNAL_CONTEXT_PLUGIN_ID = 'internal:sidebar-context'
const SECTION_INDENT = 2
const DEFAULT_WIDTH = 36

type SidebarPanelData = {
  enabled: boolean
  width: number
  usageLines: string[]
  quotaLines: string[]
  compactTitle?: string
}

const latestCompactTitles = new Map<string, string>()
const [compactTitleVersion, setCompactTitleVersion] = createSignal(0)

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
  const usage = cachedUsage
    ? fromCachedSessionUsage(cachedUsage)
    : liveUsage.assistantMessages > 0
      ? liveUsage
      : undefined
  const compactTitle = resolveCompactTitle(sessionID, session?.lastAppliedTitle)

  if (!enabled) {
    return {
      enabled,
      width,
      usageLines: [],
      quotaLines: [],
      compactTitle: session?.lastAppliedTitle,
    }
  }

  const usageLines = usage
    ? renderSidebarUsageLines(usage, panelConfig(config))
    : []
  const quotaLines = renderSidebarQuotaLines(
    session?.sidebarPanel?.quotas || [],
    panelConfig(config),
  )

  return {
    enabled,
    width,
    usageLines,
    quotaLines,
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
    queueRefresh(300)
    queueRefresh(1_000)
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

function sectionHeading(api: TuiPluginApi, value: string) {
  return <text fg={api.theme.current.textMuted}>{value}</text>
}

function fallbackQuotaLinesFromTitle(title: string, width: number) {
  const parts = (title || '')
    .split(' | ')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length <= 1) return [] as string[]
  return parts
    .slice(1)
    .filter((part) => !/^Cd\d/.test(part) && !/^Est\b/.test(part))
    .map((part) => fitLine(part, width))
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
  const quotaLines = createMemo(() => {
    const liveLines = panel()?.quotaLines || []
    if (liveLines.length > 0) return liveLines
    return fallbackQuotaLinesFromTitle(compactTitle(), width())
  })
  const hasUsage = createMemo(() => usageLines().length > 0)
  const hasQuota = createMemo(() => quotaLines().length > 0)

  return (
    <box gap={0}>
      <Show when={hasUsage()}>
        <box gap={0}>
          {sectionHeading(props.api, 'USAGE')}
          <box gap={0}>
            <For each={usageLines()}>
              {(line) => <text fg={props.api.theme.current.text}>{line}</text>}
            </For>
          </box>
        </box>
      </Show>

      <Show when={hasQuota()}>
        <box paddingTop={hasUsage() ? 1 : 0} gap={0}>
          {sectionHeading(props.api, 'QUOTA')}
          <box gap={0}>
            <For each={quotaLines()}>
              {(line) => <text fg={props.api.theme.current.text}>{line}</text>}
            </For>
          </box>
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
      {sectionHeading(props.api, 'TITLE')}
      <box gap={0}>
        <For each={titleLines()}>
          {(line) => <text fg={props.api.theme.current.text}>{line}</text>}
        </For>
        <Show when={shareLine()}>
          <text fg={props.api.theme.current.textMuted}>{shareLine()}</text>
        </Show>
      </box>
    </box>
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
