# opencode-quota-sidebar

[![npm version](https://img.shields.io/npm/v/@leo000001/opencode-quota-sidebar.svg)](https://www.npmjs.com/package/@leo000001/opencode-quota-sidebar)
[![license](https://img.shields.io/npm/l/@leo000001/opencode-quota-sidebar.svg)](https://github.com/xihuai18/opencode-quota-sidebar/blob/main/LICENSE)

[简体中文](./README.zh-CN.md)

OpenCode plugin that shows token usage and provider quota in TUI sidebar panels, while keeping the shared session title compact.

![Example sidebar title with usage and quota](./assets/OpenCode-Quota-Sidebar.png)

## Features

- Dedicated TUI sidebar blocks for `TITLE`, `USAGE`, and `QUOTA`
- Compact shared session titles for Desktop, Web, and TUI
- Session/day/week/month reports via `quota_summary`
- Toggle title decoration with `quota_show`
- Usage aggregation can include descendant subagent sessions
- Built-in quota adapters for OpenAI, Copilot, Anthropic, Kimi, Zhipu, MiniMax, RightCode, Buzz, and XYAI

## Install

OpenCode loads the server plugin from `opencode.json` and the TUI plugin from `tui.json`.

`opencode.json`

```json
{
  "plugin": ["@leo000001/opencode-quota-sidebar@3.0.1"]
}
```

`tui.json`

```json
{
  "plugin": ["@leo000001/opencode-quota-sidebar@3.0.1"]
}
```

For OpenCode `>=1.2.15`, keep server plugins in `opencode.json` and TUI plugins in `tui.json`.

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

See [`quota-sidebar.config.example.json`](./quota-sidebar.config.example.json) for a full example.

## Tools

- `quota_summary`: shows usage and quota for `session`, `day`, `week`, or `month`
- `quota_show`: toggles title decoration on or off

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

## Contributing

- Adapter and architecture notes: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Security policy: [SECURITY.md](./SECURITY.md)
