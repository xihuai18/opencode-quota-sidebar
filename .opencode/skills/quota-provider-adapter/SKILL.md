---
name: quota-provider-adapter
description: Add or update built-in quota provider adapters for opencode-quota-sidebar. Use when implementing a new provider, changing adapter matching or auth handling, updating quota window or balance parsing, adjusting provider registration or default provider inclusion, or touching provider-specific tests under src/providers/, src/quota.ts, src/quota_service.ts, and src/quota_render.ts.
---

# Quota Provider Adapter

Use this workflow for any provider-facing quota change.

## Key files

- `src/providers/types.ts`
- `src/providers/registry.ts`
- `src/providers/index.ts`
- `src/quota.ts`
- `src/quota_service.ts`
- `src/quota_render.ts`
- `src/cost.ts`
- `src/__tests__/quota.test.ts`
- `src/__tests__/cost.test.ts`
- `src/__tests__/quota_service.test.ts`
- `src/__tests__/usage_service.test.ts`
- `src/__tests__/registry.test.ts`
- `src/__tests__/format.test.ts`

## Workflow

1. Inspect an existing adapter with similar auth and quota shape before coding.
2. Implement `QuotaProviderAdapter` with a narrow `matchScore()` to avoid registry collisions.
3. Register the adapter in `src/providers/index.ts` and confirm tie-break behavior remains intentional.
4. Check auth lookup and normalization flow in `src/quota.ts`; add `normalizeID()` when provider IDs have aliases or prefixes.
5. Check cache isolation in `src/quota_service.ts`; quota cache keys must separate tenants/base URLs/accounts when needed.
6. Decide whether the provider belongs in `listDefaultQuotaProviderIDs()` so `quota_summary` can show it without extra config.
7. If the provider should support `Cost as API`, decide whether its quota identity should map to another canonical pricing provider in `src/cost.ts` (for example a subscription adapter reusing an official API pricing table), then update lookup aliases and fallback pricing as needed.
8. Verify rendering through `src/quota_render.ts` and `src/format.ts`; prefer structured `windows` or `balance` data instead of encoding display logic inside the adapter.
9. Add or update tests for adapter matching, fetch parsing, cache behavior, rendered output, and any pricing alias / recompute paths touched.

## Guardrails

- Keep provider matching specific; overlapping positive `matchScore()` values are a regression risk.
- Do not hardcode display-only strings in multiple places; reuse adapter labels and shared render paths.
- Treat auth refresh and auth persistence as part of the adapter contract when the upstream API needs it.
- If the adapter is baseURL-driven, test both canonical and tolerated URL shapes.
- If quota and pricing provider IDs differ, document the canonical pricing mapping and cover it in `src/__tests__/cost.test.ts` plus stale-cache recompute coverage in `src/__tests__/usage_service.test.ts`.
- If the adapter changes supported-provider docs, update `AGENTS.md` section 5.5.

## Verify

- Run `npm run build`.
- Run `npm test`.
- If the change is narrow, still inspect provider-specific tests plus `src/__tests__/format.test.ts` for display regressions.
