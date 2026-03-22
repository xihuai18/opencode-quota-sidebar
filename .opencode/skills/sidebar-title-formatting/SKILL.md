---
name: sidebar-title-formatting
description: Maintain sidebar title rendering and decoration detection for opencode-quota-sidebar. Use when changing multiline title layout, quota wrapping, fitLine width handling, title normalization, decorated-title detection, restore/apply behavior, or related tests in src/format.ts and src/title*.ts.
---

# Sidebar Title Formatting

Use this workflow for any title-format or title-lifecycle change.

## Key files

- `src/format.ts`
- `src/title.ts`
- `src/title_apply.ts`
- `src/title_refresh.ts`
- `src/quota_render.ts`
- `src/__tests__/format.test.ts`
- `src/__tests__/title.test.ts`
- `src/__tests__/title_apply.test.ts`
- `src/__tests__/title_refresh.test.ts`

## Non-negotiable rules

- Sidebar title content is plain text only; do not inject JSX, HTML, or ANSI styling.
- Every rendered sidebar line must go through `fitLine()` and stay within `sidebar.width` terminal cells.
- Do not rely on trailing spaces for alignment.
- Wrapped quota lines must remain recognizable by title decoration detection and restore logic.

## Workflow

1. Read the current render path in `src/format.ts` and the detection path in `src/title.ts` before changing either.
2. If you change quota line wording or structure, update detection rules in `src/title.ts` in the same patch.
3. If you change apply/restore behavior, inspect `src/title_apply.ts` and `src/title_refresh.ts` for scheduler or echo-protection side effects.
4. Prefer changing shared formatting helpers instead of adding one-off provider formatting branches.
5. Keep sidebar, toast, and markdown output intentionally aligned where they share business rules, but do not force identical wording across all surfaces.
6. Add tests for width truncation, wrap behavior, decorated-title detection, and restore/apply flows.

## Guardrails

- Resize safety beats visual cleverness.
- If a new format is hard for `title.ts` to detect, simplify the format instead of adding brittle regexes.
- Do not introduce ANSI reset codes; historical resize corruption is a known failure mode.
- If provider examples in docs become stale after the change, update `AGENTS.md` and `README.md` together.

## Verify

- Run `npm run build`.
- Run `npm test`.
- Inspect `src/__tests__/format.test.ts` and `src/__tests__/title.test.ts` expectations for exact text changes.
