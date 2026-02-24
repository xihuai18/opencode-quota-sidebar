# Changelog

## 1.0.0

Initial release.

### Features

- Show token usage (Input/Output/Cache) in session sidebar title.
- Show subscription quota for OpenAI Codex, GitHub Copilot, and RightCode.
- `quota_summary` tool — usage report for session/day/week/month (markdown + toast).
- `quota_show` tool — toggle sidebar title display on/off.
- Provider adapter registry — add new quota providers without editing core code.
- Incremental usage aggregation with per-session cursor.
- Date-partitioned storage with LRU chunk cache.
- API-equivalent cost display for subscription providers.
- Atomic file writes with symlink refusal.
