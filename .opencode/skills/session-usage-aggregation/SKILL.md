---
name: session-usage-aggregation
description: Maintain session usage aggregation, descendant subagent rollups, and usage-cache invalidation for opencode-quota-sidebar. Use when changing incremental cursor logic, includeChildren behavior, range-vs-session semantics, persisted CachedSessionUsage fields, billingVersion invalidation, or related tests in src/usage.ts, src/usage_service.ts, src/descendants.ts, and storage parsing.
---

# Session Usage Aggregation

Use this workflow for any change to token aggregation or session-scope rollups.

## Key files

- `src/usage.ts`
- `src/usage_service.ts`
- `src/descendants.ts`
- `src/index.ts`
- `src/events.ts`
- `src/types.ts`
- `src/storage_parse.ts`
- `src/__tests__/usage.test.ts`
- `src/__tests__/usage.incremental.test.ts`
- `src/__tests__/usage_service.test.ts`
- `src/__tests__/subagent.integration.test.ts`
- `src/__tests__/range_persist.test.ts`

## Behavioral rules

- Session scope may include descendant subagent sessions when `sidebar.includeChildren` is enabled.
- Day/week/month range reports do not merge descendant sessions.
- `message.removed` is a full-rescan path, not an incremental update path.
- Parent session titles may need a refresh when child-session usage changes.

## billingVersion rule

- `USAGE_BILLING_CACHE_VERSION` in `src/usage.ts` controls cached usage staleness only.
- Bump it whenever persisted `CachedSessionUsage` fields or recomputation semantics change in a way that requires rebuilding old cached usage.
- Typical triggers: new aggregate fields, changed `cost`/`apiCost` math, changed `cacheBuckets` derivation, or changed provider-level persisted usage layout.
- When you bump it, also inspect `src/types.ts`, `src/storage_parse.ts`, `src/__tests__/usage_service.test.ts`, and `src/__tests__/range_persist.test.ts`.

## Workflow

1. Decide first whether the change affects message summarization, descendant traversal, persisted usage shape, or only display.
2. Trace the change across `src/usage.ts` and `src/usage_service.ts`; most aggregation bugs are caused by changing one side only.
3. If descendant behavior changes, inspect `src/descendants.ts` and the parent-refresh logic in `src/index.ts`.
4. If persisted usage shape or semantics change, evaluate whether `USAGE_BILLING_CACHE_VERSION` must be bumped.
5. Keep session-scope and range-scope behavior intentionally different; do not accidentally merge descendants into day/week/month reports.
6. Update tests for incremental flow, full rescan, persisted cache reuse, and descendant aggregation.

## Verify

- Run `npm run build`.
- Run `npm test`.
- Pay special attention to `src/__tests__/usage_service.test.ts`, `src/__tests__/subagent.integration.test.ts`, and `src/__tests__/range_persist.test.ts`.
