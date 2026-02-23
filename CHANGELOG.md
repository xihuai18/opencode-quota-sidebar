# Changelog

## Unreleased

### Bug Fixes (Critical)

- H1: Fix `saveState` empty dirty keys triggering full writeAll on every save.
- H2: Fix `persistState` dirty-key race condition — delete captured keys instead of clearing the whole set.
- H3: Fix `pendingAppliedTitle` TTL corruption — detect decorated titles to prevent double-decoration; increase TTL to 15s.
- H4: Fix `updateAuth` silently dropping token persistence — log and return error snapshot on failure.
- H5: Add per-session concurrency lock for `applyTitle` to prevent conflicting concurrent updates.

### Bug Fixes (Medium)

- M1: `refreshTimer` entries are now cleaned up when timers fire.
- M2: Sessions older than `retentionDays` (default 730 days) are evicted from memory on startup.
- M3: v1→v2 migration now recovers `createdAt` from v1 data when available.
- M4: State and chunk file writes are now atomic (write to temp + rename).
- M5: `flushSave` now flushes current dirty keys even when no timer is pending.
- M6: `shortNumber` now handles negative, NaN, and Infinity values gracefully.
- M7: `dateKeysInRange` is capped at 400 iterations to prevent runaway loops.
- M8: Deduplicated `isRecord`/`asNumber`/`asBoolean` into shared `helpers.ts`.
- M9: `scanSessionsByCreatedRange` now prefers in-memory state over disk reads.
- M10: `summarizeRangeUsage` now fetches session messages in parallel (concurrency 5).
- M11: `saveState` now only iterates sessions belonging to dirty date keys.
- M12: Removed double timestamp normalization in `dateKeyFromTimestamp`.

### Performance

- P1: Incremental usage aggregation — tracks last processed message cursor per session.
- P2: LRU chunk cache (64 entries) for loaded day chunks.
- P3: `restoreAllVisibleTitles` limited to concurrency 5.
- P4: `sessionDateMap` dirty tracking integrated with chunk-level dirty keys.

### Security

- S1: Replaced 15+ silent `.catch(() => undefined)` with debug-mode logging via `swallow()`.
- S2: Added screen-sharing privacy warning to README.
- S3: State file writes now refuse to follow symlinks.
- S4: Renamed `OPENCODE_TEST_HOME` env var to `OPENCODE_QUOTA_DATA_HOME`.

### Open-Source Prep

- O1: Added `repository`, `homepage`, `bugs`, `author` to package.json; moved SDK deps to `peerDependencies`.
- O2: Added `*.tsbuildinfo`, `.DS_Store`, `coverage/`, `.env` to `.gitignore`.
- O3: README config example now includes `sidebar.enabled` and `retentionDays`.
- O4: Added unit tests for helpers, storage, and usage modules.
- O5: Main entry now exports consumer types (`QuotaSidebarConfig`, `QuotaSnapshot`, etc.).

## 0.1.0

- Initial release.
