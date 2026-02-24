# opencode-quota-sidebar

[![npm version](https://img.shields.io/npm/v/@leo000001/opencode-quota-sidebar.svg)](https://www.npmjs.com/package/@leo000001/opencode-quota-sidebar)
[![license](https://img.shields.io/npm/l/@leo000001/opencode-quota-sidebar.svg)](https://github.com/xihuai18/opencode-quota-sidebar/blob/main/LICENSE)

OpenCode plugin: show token usage and subscription quota in the session sidebar title.

## Install

Add the package name to `plugin` in your `opencode.json`. OpenCode uses Bun to install it automatically on startup:

```json
{
  "plugin": ["@leo000001/opencode-quota-sidebar"]
}
```

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

| Provider       | Endpoint                               | Auth            | Status                                 |
| -------------- | -------------------------------------- | --------------- | -------------------------------------- |
| OpenAI Codex   | `chatgpt.com/backend-api/wham/usage`   | OAuth (ChatGPT) | Multi-window (short-term + weekly)     |
| GitHub Copilot | `api.github.com/copilot_internal/user` | OAuth           | Monthly quota                          |
| RightCode      | `www.right.codes/account/summary`      | API key         | Subscription or balance (by prefix)    |
| Anthropic      | —                                      | —               | Unsupported (no public quota endpoint) |

Want to add support for another provider (Google Antigravity, Zhipu AI, Firmware AI, etc.)? See [CONTRIBUTING.md](CONTRIBUTING.md).

## Features

- Session title becomes multiline in sidebar:
  - line 1: original session title
  - line 2: Input/Output tokens
  - line 3: Cache Read tokens (only if non-zero)
  - line 4: Cache Write tokens (only if non-zero)
  - line 5: `$X.XX as API cost` (equivalent API billing for subscription-auth providers)
  - quota lines: quota text like `OpenAI 5h 80% Rst 16:20`, with multi-window continuation lines indented (e.g. `       Weekly 70% Rst 03-01`)
  - RightCode daily quota shows `$remaining/$dailyTotal` + expiry (e.g. `RC Daily $105/$60 Exp 02-27`, without trailing percent) and also shows balance on the next indented line when available
- Toast message includes three sections: `Token Usage`, `Cost as API` (per provider), and `Quota`
- Quota snapshots are de-duplicated before rendering to avoid repeated provider lines
- Custom tools:
  - `quota_summary` — generate usage report for session/day/week/month (markdown + toast)
  - `quota_show` — toggle sidebar title display on/off (state persists across sessions)
- Quota connectors:
  - OpenAI Codex OAuth (`/backend-api/wham/usage`)
  - GitHub Copilot OAuth (`/copilot_internal/user`)
  - RightCode API key (`/account/summary`)
  - Anthropic: currently marked unsupported (no public quota endpoint)
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

## Optional project config

Create `quota-sidebar.config.json` under your project root:

```json
{
  "sidebar": {
    "enabled": true,
    "width": 36,
    "showCost": true,
    "showQuota": true
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
- `output` now includes reasoning tokens. Reasoning is no longer rendered as a separate line.
- API cost excludes reasoning tokens from output billing (uses `tokens.output` only for output-price multiplication).
- `quota.providers` is the extensible per-adapter switch map.
- If API Cost is `$0.00`, it usually means the model/provider has no pricing mapping in OpenCode at the moment, so equivalent API cost cannot be estimated.

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
- State file writes refuse to follow symlinks to prevent symlink attacks.
- The `OPENCODE_QUOTA_DATA_HOME` env var can override the home directory for
  testing; do not set this in production.

## Contributing

Contributions are welcome — especially new quota provider connectors. See [CONTRIBUTING.md](CONTRIBUTING.md) for a step-by-step guide on adding support for a new provider.

## License

MIT. See `LICENSE`.
