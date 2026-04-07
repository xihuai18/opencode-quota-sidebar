# opencode-quota-sidebar

[![npm version](https://img.shields.io/npm/v/@leo000001/opencode-quota-sidebar.svg)](https://www.npmjs.com/package/@leo000001/opencode-quota-sidebar)
[![license](https://img.shields.io/npm/l/@leo000001/opencode-quota-sidebar.svg)](https://github.com/xihuai18/opencode-quota-sidebar/blob/main/LICENSE)

[简体中文](./README.zh-CN.md)

OpenCode plugin that shows token usage and provider quota in the TUI sidebar, while keeping the shared session title compact and readable across Desktop, Web, and TUI.

![Example sidebar title with usage and quota](./assets/OpenCode-Quota-Sidebar.png)

The screenshot above comes from [`./assets/OpenCode-Quota-Sidebar.png`](./assets/OpenCode-Quota-Sidebar.png) and shows the actual TUI sidebar layout this plugin renders.

## What It Does

- Renders dedicated `TITLE`, `USAGE`, and `QUOTA` blocks in the TUI sidebar
- Keeps the shared `session.title` on a compact single line instead of pushing multiline telemetry into every client
- Aggregates usage for `session`, `day`, `week`, and `month`
- Supports provider quota/balance fetchers for OpenAI, Copilot, Anthropic, Kimi, Zhipu, MiniMax, RightCode, and XYAI
- Can include descendant subagent sessions in session-scoped usage/quota totals
- Exposes `quota_summary` and `quota_show` tools for reports and title toggling

## Architecture Overview

This repository is a pure plugin implementation. It does not modify OpenCode core.

- Server layer: aggregates usage, fetches quota snapshots, stores state, manages title refresh, and exposes tools
- TUI layer: renders the sidebar panel UI and reads persisted sidebar-panel payloads
- Persistence layer: stores global state plus day-partitioned session chunks so historical sessions can render without full rescans
- Provider adapter layer: maps each provider to a common `QuotaSnapshot` shape through a registry of adapters

The implementation is built on top of `@opencode-ai/plugin` and `@opencode-ai/sdk`.

## How It Works

This plugin has two display layers:

- TUI sidebar panel: renders structured `TITLE`, `USAGE`, and `QUOTA` blocks
- Shared session title: stays compact so Desktop, Web, and TUI can all read the same title cleanly

In `sidebar.titleMode="auto"`, the shared title remains a compact single line. The richer multiline layout is handled by the dedicated TUI plugin instead of being written into `session.title` for every client.

Session-scoped aggregation can include descendant subagent sessions when `sidebar.includeChildren=true`. Day/week/month summaries do not merge descendants.

## Supported Providers

Built-in quota adapters:

| Provider            | Endpoint family                                            | Auth                  | Quota shape                | Notes                                                     |
| ------------------- | ---------------------------------------------------------- | --------------------- | -------------------------- | --------------------------------------------------------- |
| OpenAI Codex        | `chatgpt.com/backend-api/wham/usage`                       | OAuth                 | Multi-window subscription  | Reads ChatGPT usage windows such as short-term + weekly   |
| GitHub Copilot      | `api.github.com/copilot_internal/user`                     | OAuth                 | Monthly subscription       | Uses the Copilot internal user endpoint                   |
| Anthropic           | `api.anthropic.com/api/oauth/usage`                        | OAuth                 | Multi-window subscription  | Supports plan-based usage windows                         |
| Kimi For Coding     | `api.kimi.com/coding/v1/usages`                            | API key               | Multi-window subscription  | Typically `5h` + weekly windows                           |
| Zhipu Coding Plan   | `bigmodel.cn/api/monitor/usage/quota/limit`                | API key               | Token quota                | Coding-plan style quota window                            |
| MiniMax Coding Plan | `www.minimaxi.com/v1/api/openplatform/coding_plan/remains` | API key               | Multi-window subscription  | Typically `5h` + weekly windows                           |
| RightCode           | `www.right.codes/account/summary`                          | API key               | Daily quota and/or balance | Prefix-based subscription matching, with balance fallback |
| XYAI                | `new.xychatai.com/frontend-api/*`                          | Login -> session auth | Daily balance              | Disabled by default, configured in `quota.providers.xyai` |

Generic providers without a built-in quota endpoint can still contribute usage totals, but they will not show quota/balance unless an adapter exists.

Provider notes:

- OpenAI, Copilot, and Anthropic quota support is based on OAuth/session auth, not generic API-key billing endpoints
- RightCode can show both a daily allowance line and a balance line
- XYAI requires login credentials in config so the plugin can obtain and cache session auth
- Copilot quota is supported, but API-equivalent cost is intentionally not shown because runtime pricing is not reliable enough

## Display Rules

- Sidebar quota lines show providers actually used in the current session and recognized by an adapter
- `quota_summary` fetches default quota providers even if they were not used in the current session
- The TUI sidebar reads persisted `sidebarPanel` / usage state first, so historical sessions can render quickly on open or resume
- Compact-title quota parsing is only a fallback path; the TUI panel prefers persisted structured data
- `quota_show` toggles title decoration on or off, but the TUI panel remains the main rich display path

## Install

OpenCode loads the server plugin from `opencode.json` and the TUI plugin from `tui.json`.

`opencode.json`

```json
{
  "plugin": ["@leo000001/opencode-quota-sidebar@latest"]
}
```

`tui.json`

```json
{
  "plugin": ["@leo000001/opencode-quota-sidebar@latest"]
}
```

For OpenCode `>=1.2.15`, keep server plugins in `opencode.json` and TUI plugins in `tui.json`.

## Sidebar Demo

Typical TUI sidebar layout:

```text
TITLE
  Fix quota adapter matching
USAGE
  R184 I189k O53.2k
  CR31.4k CW3.2k Cd66%
  Est $12.8
QUOTA
  OAI 5h80 R3h20m
      W70 R2D04h
  Cop M78 R12D00h
  RC D$88.9/$60 E6D00h
     B260
```

Compact shared title example:

```text
Fix quota adapter matching | OAI 5h80 R3h20m W70 R2D04h | RC D$88.9/$60 B260 | Cd66% | Est$12.8
```

Another compact title example with multiple providers:

```text
Add XYAI quota adapter | Ant 5h100 W77 O7d60 | Cop M78 R04-01 | Cd52% | Est$2.34
```

## Tool Report Demo

Example `quota_summary` markdown output shape:

```md
## Session Usage

- Requests: 184
- Input: 189k
- Output: 53.2k
- Cache Read: 31.4k
- Cache Write: 3.2k
- Cost as API: $12.8

## Quota

- OpenAI: 5h 80% (reset 3h20m), Weekly 70% (reset 2D04h)
- Copilot: Monthly 78% (reset 12D00h)
- RightCode: Daily $88.9/$60 (exp 6D00h), Balance $260
```

The tool already returns full markdown. Clients should display that report directly instead of replacing it with a short summary.

Sidebar output uses compact tokens. Toasts and markdown reports keep fuller human-readable wording.

## Why The TUI Panel Exists

OpenCode renders the sidebar title as plain text inside a single styled title field. That means the shared title is great for compact telemetry, but not ideal for a rich multi-section layout.

This plugin therefore uses:

- shared compact titles for cross-client compatibility
- a dedicated TUI sidebar panel for the detailed block layout

That split avoids polluting Desktop/Web titles while still giving TUI users a readable quota dashboard.

## Abbreviations

Usage tokens:

- `R`: requests
- `I`: input tokens
- `O`: output tokens, including reasoning tokens
- `CR`: cache read tokens
- `CW`: cache write tokens
- `Cd`: cached ratio / cache coverage
- `Est`: API-equivalent cost estimate

Quota tokens:

- `OAI`: OpenAI
- `Cop`: GitHub Copilot
- `Ant`: Anthropic
- `RC`: RightCode
- `B`: balance
- `D`: daily window
- `W`: weekly window
- `M`: monthly window
- `R3h20m`: resets in `3h20m`
- `R2D04h`: resets in `2D04h`
- `E6D00h`: expires in `6D00h`

Example compact quota fragments:

- `OAI 5h80 R3h20m`: OpenAI short window, 80% remaining, resets in `3h20m`
- `Cop M78 R12D00h`: Copilot monthly quota, 78% remaining, resets in `12D00h`
- `RC D$88.9/$60 E6D00h B260`: RightCode daily quota plus balance

## Config

Recommended config file locations:

- `~/.config/opencode/quota-sidebar.config.json`
- `<worktree>/quota-sidebar.config.json`
- `<worktree>/.opencode/quota-sidebar.config.json`
- `OPENCODE_QUOTA_CONFIG=/absolute/path/to/config.json`

Minimal example:

```json
{
  "sidebar": {
    "enabled": true,
    "titleMode": "auto",
    "showCost": true,
    "showQuota": true,
    "includeChildren": true
  }
}
```

See [`quota-sidebar.config.example.json`](./quota-sidebar.config.example.json) for a fuller config example.

Important config notes:

- `sidebar.titleMode`: `auto`, `compact`, or `multiline`
- `sidebar.showCost`: controls API-equivalent cost in sidebar, title, markdown report, and toast
- `sidebar.wrapQuotaLines`: wraps long quota lines with indentation instead of dropping fields
- `sidebar.includeChildren`: includes descendant subagent sessions for `period=session`
- `quota.providers.xyai.enabled`: must be explicitly enabled if you want XYAI quota
- `quota.providers.xyai.login.username/password`: used to fetch and refresh XYAI session auth

Config is layered. The later source overrides the earlier one:

1. global config
2. worktree config
3. directory config
4. worktree `.opencode` config
5. directory `.opencode` config
6. `OPENCODE_QUOTA_CONFIG`

## Persistence And Aggregation

The plugin stores:

- global state in `<opencode-data>/quota-sidebar.state.json`
- session chunks in `<opencode-data>/quota-sidebar-sessions/YYYY/MM/DD.json`

Those persisted chunks keep title state, cached usage, sidebar-panel payloads, and quota cache data. This lets the TUI sidebar render from stored structured state on session open/resume instead of depending entirely on live message scans.

Usage aggregation is incremental. The plugin tracks a cursor per session and processes only new messages when possible. If message history changes in a way that invalidates the incremental view, it can rescan and refresh persisted usage.

## Tools

- `quota_summary`: shows usage and quota for `session`, `day`, `week`, or `month`
- `quota_show`: toggles title decoration on or off

Behavior notes:

- `quota_summary` returns the full markdown report body
- `quota_summary` can show a toast in addition to returning markdown
- `quota_summary(includeChildren=true)` only changes `period=session`
- `quota_show(enabled=true|false)` can explicitly force a state instead of toggling

Example command aliases:

```json
{
  "command": {
    "qday": {
      "description": "Show today's usage and quota",
      "template": "Call tool quota_summary with period=day and toast=true."
    },
    "qweek": {
      "description": "Show this week's usage and quota",
      "template": "Call tool quota_summary with period=week and toast=true."
    },
    "qmonth": {
      "description": "Show this month's usage and quota",
      "template": "Call tool quota_summary with period=month and toast=true."
    },
    "qtoggle": {
      "description": "Toggle sidebar usage display on/off",
      "template": "Call tool quota_show (no arguments, it toggles)."
    }
  }
}
```

## Development

```bash
npm install
npm run build
npm test
```

For local development, load:

- `file:///ABSOLUTE/PATH/opencode-quota-sidebar/dist/index.js` in `opencode.json`
- `file:///ABSOLUTE/PATH/opencode-quota-sidebar/dist/tui.tsx` in `tui.json`

On Windows, use forward slashes in `file:///` URLs.

## Compatibility And Caveats

- Node.js `>=18`
- OpenCode plugin SDK `@opencode-ai/plugin` / `@opencode-ai/sdk` `^1.3.5`
- For OpenCode `>=1.2.15`, TUI config belongs in `tui.json`
- The shared title is still one `session.title` value for all clients
- The plugin avoids ANSI styling in sidebar titles to keep resize behavior stable
- Some providers expose true quota windows, others only expose balance data

## Contributing

- Changelog: [CHANGELOG.md](./CHANGELOG.md)
- Adapter and architecture notes: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Security policy: [SECURITY.md](./SECURITY.md)

## Documentation Navigation

- English README: [`README.md`](./README.md)
- Simplified Chinese README: [`README.zh-CN.md`](./README.zh-CN.md)
- Changelog: [`CHANGELOG.md`](./CHANGELOG.md)
- Contributing guide: [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- Security policy: [`SECURITY.md`](./SECURITY.md)
