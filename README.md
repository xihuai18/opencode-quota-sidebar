# opencode-quota-sidebar

[![npm version](https://img.shields.io/npm/v/@leo000001/opencode-quota-sidebar.svg)](https://www.npmjs.com/package/@leo000001/opencode-quota-sidebar)
[![license](https://img.shields.io/npm/l/@leo000001/opencode-quota-sidebar.svg)](https://github.com/xihuai18/opencode-quota-sidebar/blob/main/LICENSE)

OpenCode plugin: show token usage and subscription quota in the session sidebar title.

![Example sidebar title with usage and quota](./assets/OpenCode-Quota-Sidebar.png)

## Install

Add the package name to `plugin` in your `opencode.json`. OpenCode uses Bun to install it automatically on startup:

```json
{
  "plugin": ["@leo000001/opencode-quota-sidebar"]
}
```

Note for OpenCode `>=1.2.15`: TUI settings (`theme`/`keybinds`/`tui`) moved to `tui.json`, but plugin loading still stays in `opencode.json` (`plugin: []`).
This plugin also accepts both `config.providers` and older `provider.list` runtime shapes when discovering provider options.

## Development (build from source)

```bash
npm install
npm run build
```

Add the built file to your `opencode.json`:

```json
{
  "plugin": ["file:///ABSOLUTE/PATH/opencode-quota-sidebar/dist/index.js"]
}
```

On Windows, use forward slashes: `"file:///D:/Lab/opencode-quota-sidebar/dist/index.js"`

## Supported quota providers

| Provider       | Endpoint                               | Auth            | Status                                  |
| -------------- | -------------------------------------- | --------------- | --------------------------------------- |
| OpenAI Codex   | `chatgpt.com/backend-api/wham/usage`   | OAuth (ChatGPT) | Multi-window (short-term + weekly)      |
| GitHub Copilot | `api.github.com/copilot_internal/user` | OAuth           | Monthly quota                           |
| RightCode      | `www.right.codes/account/summary`      | API key         | Subscription or balance (by prefix)     |
| Anthropic      | `api.anthropic.com/api/oauth/usage`    | OAuth           | Multi-window (5h + weekly / plan-based) |

Want to add support for another provider (Google Antigravity, Zhipu AI, Firmware AI, etc.)? See [CONTRIBUTING.md](CONTRIBUTING.md).

## Features

- Session title becomes multiline in sidebar:
  - line 1: original session title
  - line 2: Input/Output tokens
  - line 3: Cache Read tokens (only if non-zero)
  - line 4: Cache Write tokens (only if non-zero)
  - line 5: `$X.XX as API cost` (equivalent API billing for subscription-auth providers)
  - quota lines: quota text like `OpenAI 5h 80% Rst 16:20`; short windows (`5h`, `1d`, `Daily`) show `HH:MM` on same-day resets and `MM-DD HH:MM` when crossing days, while longer windows continue to show `MM-DD`
  - RightCode daily quota shows `$remaining/$dailyTotal` + expiry (e.g. `RC Daily $105/$60 Exp 02-27`, without trailing percent) and also shows balance on the next indented line when available; `Exp` remains date-only
- Session-scoped usage/quota can include descendant subagent sessions (enabled by default via `sidebar.includeChildren=true`). Traversal is bounded by `childrenMaxDepth` (default 6), `childrenMaxSessions` (default 128), and `childrenConcurrency` (default 5); truncation is logged when `OPENCODE_QUOTA_DEBUG=1`. Day/week/month ranges never merge children — only session scope does.
- Toast message includes three sections: `Token Usage`, `Cost as API` (per provider), and `Quota`
- Quota snapshots are de-duplicated before rendering to avoid repeated provider lines
- Custom tools:
  - `quota_summary` — generate usage report for session/day/week/month (markdown + toast)
  - `quota_show` — toggle sidebar title display on/off (state persists across sessions)
- Quota connectors:
  - OpenAI Codex OAuth (`/backend-api/wham/usage`)
  - GitHub Copilot OAuth (`/copilot_internal/user`)
  - RightCode API key (`/account/summary`)
  - Anthropic Claude OAuth (`/api/oauth/usage`, with beta header)
- OpenAI OAuth quota checks auto-refresh expired access token (using refresh token)
- API key providers still show usage aggregation (quota only applies to subscription providers)
- Incremental usage aggregation — only processes new messages since last cursor
- Sidebar token units are adaptive (`k`/`m` with one decimal where applicable)

## Storage layout

The plugin stores lightweight global state and date-partitioned session chunks.

- Global metadata: `<opencode-data>/quota-sidebar.state.json`
  - `titleEnabled`
  - `sessionDateMap` (sessionID -> `YYYY-MM-DD`)
  - `quotaCache`
- Session chunks: `<opencode-data>/quota-sidebar-sessions/YYYY/MM/DD.json`
  - per-session title state (`baseTitle`, `lastAppliedTitle`)
  - `createdAt`
  - `parentID` (when the session is a subagent child session)
  - cached usage summary used by `quota_summary`
  - incremental aggregation cursor

Example tree:

```text
~/.local/share/opencode/
  quota-sidebar.state.json
  quota-sidebar-sessions/
    2026/
      02/
        23.json
        24.json
```

Sessions older than `retentionDays` (default 730 days / 2 years) are evicted from
memory on startup. Chunk files remain on disk for historical range scans.

## Compatibility

- Node.js: >= 18 (for `fetch` + `AbortController`)
- OpenCode: plugin SDK `@opencode-ai/plugin` ^1.2.10
- OpenCode config split: if you are on `>=1.2.15`, keep this plugin in `opencode.json` and keep TUI-only keys in `tui.json`.

## Optional commands

You can add these command templates in `opencode.json` so you can run `/qday`, `/qweek`, `/qmonth`, `/qtoggle`:

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

## Configuration files

Recommended global config:

- `~/.config/opencode/quota-sidebar.config.json`

Optional project overrides:

- `<worktree>/quota-sidebar.config.json`
- `<directory>/quota-sidebar.config.json` (when different from `worktree`)
- `<worktree>/.opencode/quota-sidebar.config.json`
- `<directory>/.opencode/quota-sidebar.config.json` (when different from `worktree`)

Optional explicit override:

- `OPENCODE_QUOTA_CONFIG=/absolute/path/to/config.json`

Optional config-home override:

- `OPENCODE_QUOTA_CONFIG_HOME=/absolute/path/to/config-home`

Resolution order (low -> high):

1. Global config (`~/.config/opencode/...`)
2. `<worktree>/quota-sidebar.config.json`
3. `<directory>/quota-sidebar.config.json`
4. `<worktree>/.opencode/quota-sidebar.config.json`
5. `<directory>/.opencode/quota-sidebar.config.json`
6. `OPENCODE_QUOTA_CONFIG`

Values are layered; later sources override earlier ones.

## Defaults

If you do not provide any config file, the plugin uses the built-in defaults below.

Sidebar defaults:

- `sidebar.enabled`: `true`
- `sidebar.width`: `36` (clamped to `20`-`60`)
- `sidebar.multilineTitle`: `true`
- `sidebar.showCost`: `true`
- `sidebar.showQuota`: `true`
- `sidebar.wrapQuotaLines`: `true`
- `sidebar.includeChildren`: `true`
- `sidebar.childrenMaxDepth`: `6` (clamped to `1`-`32`)
- `sidebar.childrenMaxSessions`: `128` (clamped to `0`-`2000`)
- `sidebar.childrenConcurrency`: `5` (clamped to `1`-`10`)

Quota defaults:

- `quota.refreshMs`: `300000` (clamped to `>=30000`)
- `quota.includeOpenAI`: `true`
- `quota.includeCopilot`: `true`
- `quota.includeAnthropic`: `true`
- `quota.providers`: `{}` (per-adapter switches, for example `rightcode.enabled`)
- `quota.refreshAccessToken`: `false`
- `quota.requestTimeoutMs`: `8000` (clamped to `>=1000`)

Other defaults:

- `toast.durationMs`: `12000` (clamped to `>=1000`)
- `retentionDays`: `730`

Example config:

```json
{
  "sidebar": {
    "enabled": true,
    "width": 36,
    "multilineTitle": true,
    "showCost": true,
    "showQuota": true,
    "wrapQuotaLines": true,
    "includeChildren": true,
    "childrenMaxDepth": 6,
    "childrenMaxSessions": 128,
    "childrenConcurrency": 5
  },
  "quota": {
    "refreshMs": 300000,
    "includeOpenAI": true,
    "includeCopilot": true,
    "includeAnthropic": true,
    "providers": {
      "rightcode": {
        "enabled": true
      }
    },
    "refreshAccessToken": false,
    "requestTimeoutMs": 8000
  },
  "toast": {
    "durationMs": 12000
  },
  "retentionDays": 730
}
```

Notes:

- `sidebar.showCost` controls API-cost visibility in sidebar title, `quota_summary` markdown report, and toast message.
- `quota_summary` follows the same reset compaction rules for short windows in its subscription section (`5h` / `1d` / `Daily` show time, long windows show date, RightCode `Exp` stays date-only).
- `sidebar.width` is measured in terminal cells. CJK/emoji truncation is best-effort to avoid sidebar overflow.
- `sidebar.multilineTitle` controls multi-line sidebar layout (default: `true`). Set `false` for compact single-line title.
- `sidebar.wrapQuotaLines` controls quota line wrapping and continuation indentation (default: `true`).
- `sidebar.includeChildren` controls whether session-scoped usage/quota includes descendant subagent sessions (default: `true`).
- `sidebar.childrenMaxDepth` limits how many levels of nested subagents are traversed (default: `6`, clamped 1–32).
- `sidebar.childrenMaxSessions` caps the total number of descendant sessions aggregated (default: `128`, clamped 0–2000).
- `sidebar.childrenConcurrency` controls parallel fetches for descendant session messages (default: `5`, clamped 1–10).
- `output` includes reasoning tokens (`output = tokens.output + tokens.reasoning`). Reasoning is not rendered as a separate line.
- API cost bills reasoning tokens at the output rate (same as completion tokens).
- `quota.providers` is the extensible per-adapter switch map.
- If API Cost is `$0.00`, it usually means the model/provider has no pricing mapping in OpenCode at the moment, so equivalent API cost cannot be estimated.

## Rendering examples

These examples show the quota block portion of the sidebar title.

### `sidebar.multilineTitle=true`

0 providers (no quota data):

```text
(no quota block)
```

1 provider, 1 window (fits):

```text
Copilot Monthly 78% Rst 04-01
```

1 provider, multi-window (for example OpenAI 5h + Weekly):

```text
OpenAI
  5h 78% Rst 05:05
  Weekly 73% Rst 03-12
```

1 provider, short window crossing into the next day:

```text
Anthropic
  5h 0% Rst 03-10 01:00
  Weekly 46% Rst 03-15
```

2+ providers (even if each provider is single-window):

```text
OpenAI
  5h 78% Rst 05:05
Copilot
  Monthly 78% Rst 04-01
```

2+ providers mixed (multi-window + single-window):

```text
OpenAI
  5h 78% Rst 05:05
  Weekly 73% Rst 03-12
Copilot
  Monthly 78% Rst 04-01
```

Balance-style quota:

```text
RC Balance $260
```

Multi-detail quota (window + balance):

```text
RC
  Daily $88.9/$60 Exp 02-27
  Balance $260
```

Provider status / quota (examples):

```text
Anthropic 5h 80%+
Copilot unavailable
OpenAI Remaining ?
```

### `sidebar.multilineTitle=false`

Quota is rendered inline as part of a single-line title:

```text
<base> | Input ... | Output ... | OpenAI 5h 78%+ | Copilot Monthly 78% | ...
```

`quota_summary` also supports an optional `includeChildren` flag (only effective for `period=session`) to override the config per call. For `day`/`week`/`month` periods, children are never merged — each session is counted independently.

## Debug logging

Set `OPENCODE_QUOTA_DEBUG=1` to enable debug logging to stderr. This logs:

- Chunk I/O operations
- Auth refresh attempts and failures
- Session eviction counts
- Symlink write refusals

## Security & privacy notes

- The plugin reads OpenCode credentials from `<opencode-data>/auth.json`.
- If enabled, quota checks call external endpoints:
  - OpenAI Codex: `https://chatgpt.com/backend-api/wham/usage`
  - GitHub Copilot: `https://api.github.com/copilot_internal/user`
  - RightCode: `https://www.right.codes/account/summary`
- **Screen-sharing warning**: Session titles and toasts surface usage/quota
  information. If you are screen-sharing or recording, consider toggling the
  sidebar display off (`/qtoggle` or `quota_show` tool) to avoid leaking
  subscription details.
- State is persisted under `<opencode-data>/quota-sidebar.state.json` and
  `<opencode-data>/quota-sidebar-sessions/` (see Storage layout).
- OpenAI OAuth token refresh is disabled by default; set
  `quota.refreshAccessToken=true` if you want the plugin to refresh access
  tokens when expired.
- State/chunk file writes refuse to write through symlinked targets (best-effort defense-in-depth).
- The `OPENCODE_QUOTA_DATA_HOME` env var overrides the OpenCode data directory
  path (for testing); do not set this in production.
- The `OPENCODE_QUOTA_CONFIG_HOME` env var overrides global config directory
  lookup (`<config-home>/opencode`).
- The `OPENCODE_QUOTA_CONFIG` env var points to an explicit config file and
  applies as the highest-priority override.

## Contributing

Contributions are welcome — especially new quota provider connectors. See [CONTRIBUTING.md](CONTRIBUTING.md) for a step-by-step guide on adding support for a new provider.

## License

MIT. See `LICENSE`.
