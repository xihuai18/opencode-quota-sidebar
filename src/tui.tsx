/** @jsxImportSource @opentui/solid */
import fs from 'node:fs/promises'

import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from '@opencode-ai/plugin/tui'
import {
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from 'solid-js'

import {
  fitLine,
  renderSidebarContextLine,
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
import { normalizeBaseTitle } from './title.js'
import type { QuotaSidebarConfig } from './types.js'
import { fromCachedSessionUsage } from './usage.js'

const id = 'leo.quota-sidebar'
const INTERNAL_CONTEXT_PLUGIN_ID = 'internal:sidebar-context'
const SECTION_INDENT = 2
const DEFAULT_WIDTH = 36

type SidebarPanelData = {
  enabled: boolean
  width: number
  usageLines: string[]
  quotaLines: string[]
}

const STATE_CACHE_MAX = 4

type SessionMessages = ReturnType<TuiPluginApi['state']['session']['messages']>
type AssistantLike = Extract<SessionMessages[number], { role: 'assistant' }>

function latestAssistantWithOutput(messages: SessionMessages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') continue
    if (message.tokens.output <= 0) continue
    return message as AssistantLike
  }
  return undefined
}

const stateCache = new Map<
  string,
  {
    mtimeMs: number
    accessedAt: number
    state: Awaited<ReturnType<typeof loadState>>
  }
>()

async function loadStateCached(filePath: string) {
  const stat = await fs.stat(filePath).catch(() => undefined)
  const mtimeMs = stat?.mtimeMs ?? -1
  const cached = stateCache.get(filePath)
  if (cached && cached.mtimeMs === mtimeMs) {
    cached.accessedAt = Date.now()
    return cached.state
  }
  const state = await loadState(filePath)
  if (!stateCache.has(filePath) && stateCache.size >= STATE_CACHE_MAX) {
    let oldestKey: string | undefined
    let oldestTime = Infinity
    for (const [key, entry] of stateCache) {
      if (entry.accessedAt < oldestTime) {
        oldestTime = entry.accessedAt
        oldestKey = key
      }
    }
    if (oldestKey) stateCache.delete(oldestKey)
  }
  stateCache.set(filePath, { mtimeMs, accessedAt: Date.now(), state })
  return state
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

async function loadSidebarPanel(
  api: TuiPluginApi,
  sessionID: string,
): Promise<SidebarPanelData> {
  const config = await loadConfig(
    quotaConfigPaths(worktreePath(api), directoryPath(api)),
  )
  const state = await loadStateCached(stateFilePath(resolveOpencodeDataDir()))
  const session = state.sessions[sessionID]
  const enabled = config.sidebar.enabled
  const width = Math.max(8, config.sidebar.width - SECTION_INDENT)

  if (!enabled) {
    return {
      enabled,
      width,
      usageLines: [],
      quotaLines: [],
    }
  }

  if (!session?.sidebarPanel?.usage) {
    return {
      enabled,
      width,
      usageLines: [],
      quotaLines: [],
    }
  }

  const usage = fromCachedSessionUsage(session.sidebarPanel.usage)
  const usageLines = renderSidebarUsageLines(usage, panelConfig(config))
  const quotaLines = renderSidebarQuotaLines(
    session.sidebarPanel.quotas || [],
    panelConfig(config),
  )

  return {
    enabled,
    width,
    usageLines,
    quotaLines,
  }
}

function useSidebarPanelData(api: TuiPluginApi, sessionID: () => string) {
  const [refresh, setRefresh] = createSignal(0)
  const [panel] = createResource(
    () => `${sessionID()}:${refresh()}`,
    async () => loadSidebarPanel(api, sessionID()),
  )

  const timers = new Set<ReturnType<typeof setTimeout>>()
  const queueRefresh = (delay = 250) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      setRefresh((value) => value + 1)
    }, delay)
    timers.add(timer)
  }

  const scheduleRefresh = () => {
    queueRefresh(300)
    queueRefresh(1_000)
  }

  queueRefresh(1_000)

  const unsubscribers = [
    api.event.on('session.updated', (event) => {
      if (event.properties.info.id === sessionID()) scheduleRefresh()
    }),
    api.event.on('message.updated', (event) => {
      if (event.properties.info.sessionID === sessionID()) scheduleRefresh()
    }),
    api.event.on('message.removed', (event) => {
      if (event.properties.sessionID === sessionID()) scheduleRefresh()
    }),
    api.event.on('tui.session.select', (event) => {
      if (event.properties.sessionID === sessionID()) scheduleRefresh()
    }),
  ]

  onCleanup(() => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const unsubscribe of unsubscribers) unsubscribe()
  })

  return panel
}

function sectionHeading(api: TuiPluginApi, value: string) {
  return <text fg={api.theme.current.textMuted}>{value}</text>
}

function ContextSection(props: {
  api: TuiPluginApi
  sessionID: string
  width: () => number
}) {
  const messages = createMemo(() =>
    props.api.state.session.messages(props.sessionID),
  )
  const contextLine = createMemo(() => {
    const last = latestAssistantWithOutput(messages())
    if (!last) return undefined

    const tokens =
      last.tokens.input +
      last.tokens.output +
      last.tokens.reasoning +
      last.tokens.cache.read +
      last.tokens.cache.write
    const model = props.api.state.provider.find(
      (item) => item.id === last.providerID,
    )?.models[last.modelID]
    const percent =
      model?.limit.context && model.limit.context > 0
        ? (tokens / model.limit.context) * 100
        : undefined

    return renderSidebarContextLine(tokens, percent, props.width())
  })

  return (
    <Show when={contextLine()}>
      <box paddingTop={1} gap={0}>
        {sectionHeading(props.api, 'CONTEXT')}
        <box paddingLeft={SECTION_INDENT}>
          <text fg={props.api.theme.current.text}>{contextLine()}</text>
        </box>
      </box>
    </Show>
  )
}

function SidebarContentView(props: {
  api: TuiPluginApi
  sessionID: string
  showContext: boolean
}) {
  const panel = useSidebarPanelData(props.api, () => props.sessionID)
  const width = createMemo(
    () => panel()?.width || DEFAULT_WIDTH - SECTION_INDENT,
  )

  return (
    <Show when={panel()?.enabled}>
      <box gap={0}>
        <Show when={props.showContext}>
          <ContextSection
            api={props.api}
            sessionID={props.sessionID}
            width={width}
          />
        </Show>

        <Show when={(panel()?.usageLines.length || 0) > 0}>
          <box paddingTop={1} gap={0}>
            {sectionHeading(props.api, 'USAGE')}
            <box paddingLeft={SECTION_INDENT} gap={0}>
              <For each={panel()?.usageLines || []}>
                {(line) => (
                  <text fg={props.api.theme.current.text}>{line}</text>
                )}
              </For>
            </box>
          </box>
        </Show>

        <Show when={(panel()?.quotaLines.length || 0) > 0}>
          <box paddingTop={1} gap={0}>
            {sectionHeading(props.api, 'QUOTA')}
            <box paddingLeft={SECTION_INDENT} gap={0}>
              <For each={panel()?.quotaLines || []}>
                {(line) => (
                  <text fg={props.api.theme.current.text}>{line}</text>
                )}
              </For>
            </box>
          </box>
        </Show>
      </box>
    </Show>
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
    <Show
      when={panel()?.enabled}
      fallback={
        <box gap={0} paddingRight={1}>
          <For each={titleLines()}>
            {(line) => <text fg={props.api.theme.current.text}>{line}</text>}
          </For>
          <Show when={shareLine()}>
            <text fg={props.api.theme.current.textMuted}>{shareLine()}</text>
          </Show>
        </box>
      }
    >
      <box gap={0} paddingRight={1}>
        {sectionHeading(props.api, 'TITLE')}
        <box paddingLeft={SECTION_INDENT} gap={0}>
          <For each={titleLines()}>
            {(line) => <text fg={props.api.theme.current.text}>{line}</text>}
          </For>
          <Show when={shareLine()}>
            <text fg={props.api.theme.current.textMuted}>{shareLine()}</text>
          </Show>
        </box>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  const config = await loadConfig(
    quotaConfigPaths(worktreePath(api), directoryPath(api)),
  )
  const contextPlugin = api.plugins
    .list()
    .find((item) => item.id === INTERNAL_CONTEXT_PLUGIN_ID)
  let didDeactivateContext = false
  if (config.sidebar.enabled && contextPlugin?.active) {
    didDeactivateContext = await api.plugins
      .deactivate(INTERNAL_CONTEXT_PLUGIN_ID)
      .catch(() => false)
  }
  const showCustomContext =
    config.sidebar.enabled && (!contextPlugin?.active || didDeactivateContext)
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
        return (
          <SidebarContentView
            api={api}
            sessionID={props.session_id}
            showContext={showCustomContext}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
