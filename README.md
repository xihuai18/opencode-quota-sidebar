# opencode-quota-sidebar

OpenCode plugin: show token usage and subscription quota in the session sidebar title.

## Features

- Session title becomes multiline in sidebar:
  - line 1: original session title
  - line 2: input/output/reasoning/cache/total tokens
  - line 3: estimated cost + compact quota percent
- Custom tools:
  - `quota_summary` — generate usage report for session/day/week/month (markdown + toast)
  - `quota_show` — toggle sidebar title display on/off (state persists across sessions)
- Quota connectors:
  - OpenAI Codex OAuth (`/backend-api/wham/usage`)
  - GitHub Copilot OAuth (`/copilot_internal/user`)
  - Anthropic: currently marked unsupported (no public quota endpoint)
- OpenAI OAuth quota checks auto-refresh expired access token (using refresh token)
- API key providers still show usage aggregation and estimated cost

## Build

```bash
npm install
npm run build
```

## OpenCode config

Add built plugin file into your `opencode.json`:

```json
{
  "plugin": ["file:///ABSOLUTE/PATH/opencode-quota-sidebar/dist/index.js"]
}
```

On Windows, use forward slashes: `"file:///D:/Lab/opencode-quota-sidebar/dist/index.js"`

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
    "width": 36,
    "showCost": true,
    "showQuota": true,
    "maxQuotaProviders": 2
  },
  "quota": {
    "refreshMs": 300000
  },
  "toast": {
    "durationMs": 12000
  }
}
```

## Independent repository

This folder is initialized as its own git repository.
