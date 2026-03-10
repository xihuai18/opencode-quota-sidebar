# Changelog

## Unreleased

- Add Buzz API balance support for OpenAI-compatible providers that use a Buzz `baseURL`.
- Document Buzz configuration, rendering, and outbound billing endpoints.

## 1.13.2

- Publish Anthropic quota fixes and cache invalidation updates.
- Keep npm release aligned with the current `dist/` output.

## 1.13.1

- Invalidate legacy cached Anthropic `unsupported` snapshots so OAuth quota can refetch correctly.
- Accept both `config.providers` and older `provider.list` runtime shapes when discovering provider options.

## 1.13.0

- Add Anthropic Claude OAuth quota support via `GET https://api.anthropic.com/api/oauth/usage`.
- Show precise reset times for short quota windows (`5h`, `1d`, `Daily`) while keeping long windows date-only.
- Expand rendering and quota tests for multi-window output and reset formatting.

## 1.12.0

- Add default configuration examples and rendering examples for sidebar/quota display.

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
