# Changelog

## Unreleased

- Add built-in `kimi-for-coding` subscription quota support via `GET https://api.kimi.com/coding/v1/usages`.
- Parse Kimi's `5h` and `Weekly` windows, including reset timestamps, and render them like other subscription providers.
- Accept OpenCode provider discovery responses that expose Kimi API keys through provider `key` fields.
- Add Buzz API balance support for OpenAI-compatible providers that use a Buzz `baseURL`.
- Document Buzz configuration, rendering, and outbound billing endpoints.
- Keep session measured cost aligned with OpenCode root-session `message.cost` while still including descendant subagent usage in API-equivalent cost.
- Support OpenCode long-context pricing tiers via `context_over_200k` when estimating API-equivalent cost.
- Bump the usage billing cache version so `/qday`, `/qweek`, and `/qmonth` recompute historical API cost with the updated rules.
- Document API-cost estimation, billing-cache behavior, and child-session aggregation semantics in the README.
- Update `AGENTS.md` with current provider scope, config layering, descendant aggregation rules, and usage-cache maintenance guidance.
- Add project-local `.opencode/skills` workflows for quota provider adapters, sidebar title formatting, and session usage aggregation.
- Clarify README wording for generic API-key providers versus built-in quota/balance adapters.

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
