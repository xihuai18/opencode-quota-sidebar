import type { AssistantMessage, Message } from "@opencode-ai/sdk";

import {
  parseSince,
  periodRanges,
  type HistoryPeriod,
  type PeriodRange,
  type SinceSpec,
} from "./period.js";
import { mapConcurrent } from "./helpers.js";
import {
  accumulateMessagesAcrossCompletedRanges,
  accumulateMessagesInCompletedRange,
  emptyUsageSummary,
  fromCachedSessionUsage,
  mergeCursorFromEntries,
  mergeUsage,
  USAGE_BILLING_CACHE_VERSION,
  type UsageSummary,
} from "./usage.js";
import type {
  CacheCoverageMode,
  CachedSessionUsage,
  IncrementalCursor,
} from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type HistoryDialogRow = {
  label: string;
  isCurrent: boolean;
  usage: UsageSummary;
};

export type HistoryDialogData = {
  period: HistoryPeriod;
  since: string;
  rows: HistoryDialogRow[];
  total: UsageSummary;
  warning?: string;
};

export type HistoryUsageRow = {
  range: PeriodRange;
  usage: UsageSummary;
};

export type HistoryUsageResult = {
  period: HistoryPeriod;
  since: SinceSpec;
  rows: HistoryUsageRow[];
  total: UsageSummary;
  warning?: string;
  persistenceHints?: HistoryPersistenceHint[];
};

type MessageEntry = { info: Message };

export type HistoryPersistenceHint = {
  sessionID: string;
  dateKey: string;
  lastMessageTime: number | undefined;
  dirty: boolean;
  ranges: UsageSummary[];
  totalUsage: UsageSummary;
  fullUsage: UsageSummary | undefined;
  pricingFingerprint?: string;
  pricingKeys?: string[];
  persist: boolean;
  cursor: IncrementalCursor | undefined;
  missing: boolean;
  loadFailed: boolean;
};

export type LoadMessagesPageResult =
  | { status: "ok"; entries: MessageEntry[]; nextBefore?: string }
  | { status: "missing" }
  | { status: "error" };

type SessionEntry = {
  sessionID: string;
  dateKey: string;
  state: {
    createdAt: number;
    cursor?: IncrementalCursor;
    dirty?: boolean;
    usage?: CachedSessionUsage;
  };
};

// ── Deps ───────────────────────────────────────────────────────────────────

export type ComputeHistoryUsageDeps = {
  /** All known sessions (from memory state + disk chunks). */
  sessions: SessionEntry[];
  /** Paged message loader — injected so both server and TUI can provide their own implementation. */
  loadMessagesPage: (
    sessionID: string,
    before?: string,
  ) => Promise<LoadMessagesPageResult>;
  /** Model pricing map for API-cost estimation. */
  getModelCostMap: () => Promise<Record<string, unknown>>;
  /** Calculate equivalent API cost for a single assistant message. */
  calcApiCost: (
    message: AssistantMessage,
    modelCostMap: Record<string, unknown>,
  ) => number;
  /** Classify cache coverage mode for a single assistant message. */
  classifyCacheMode: (
    message: AssistantMessage,
    modelCostMap: Record<string, unknown>,
  ) => CacheCoverageMode;
  /** Check whether a set of entries has at least one resolvable API-cost message. */
  hasResolvableApiCostMessages: (
    entries: MessageEntry[],
    modelCostMap: Record<string, unknown>,
  ) => boolean;
  /** Build a pricing fingerprint from provider/model keys and current rates. */
  pricingFingerprintForKeys: (
    pricingKeys: string[],
    modelCostMap: Record<string, unknown>,
  ) => string;
  /** Whether cached usage still matches current billing + pricing semantics. */
  isUsageBillingCurrent: (
    cached: CachedSessionUsage | undefined,
    modelCostMap: Record<string, unknown>,
  ) => boolean;
  /** Whether the cached usage for a session needs a full recompute. */
  shouldTrackFullUsage: (
    cached: CachedSessionUsage | undefined,
    modelCostMap: Record<string, unknown>,
  ) => boolean;
  /** Whether cached usage needs recompute (for persistence decision). */
  shouldRecomputeUsageCache: (
    cached: CachedSessionUsage,
    pricingFingerprint: string | undefined,
  ) => boolean;
  throwOnLoadFailure?: boolean;
};

// ── Constants ──────────────────────────────────────────────────────────────

const RANGE_USAGE_CONCURRENCY = 5;

// ── Core ───────────────────────────────────────────────────────────────────

function filterRangeSessions(
  sessions: SessionEntry[],
  startAt: number,
  endAt: number,
) {
  return sessions.filter((session) => {
    if (session.state.createdAt > endAt) return false;
    if (session.state.dirty === true) return true;
    const lastMessageTime = session.state.cursor?.lastMessageTime;
    if (
      typeof lastMessageTime === "number" &&
      Number.isFinite(lastMessageTime) &&
      lastMessageTime < startAt
    ) {
      return false;
    }
    return true;
  });
}

function pageLatestTimestamp(entries: MessageEntry[]) {
  let latest = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const info = entry.info as Message & {
      time?: { created?: number; completed?: number };
    };
    const completed = info.time?.completed;
    if (typeof completed === "number" && Number.isFinite(completed)) {
      if (completed > latest) latest = completed;
      continue;
    }
    const created = info.time?.created;
    if (typeof created === "number" && Number.isFinite(created)) {
      if (created > latest) latest = created;
    }
  }
  return latest;
}

function rangeIndexForTimestamp(
  ranges: Array<{ startAt: number; endAt: number }>,
  timestamp: number,
) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const range = ranges[mid];
    if (timestamp < range.startAt) {
      high = mid - 1;
      continue;
    }
    if (timestamp >= range.endAt) {
      low = mid + 1;
      continue;
    }
    return mid;
  }
  return -1;
}

function canUseCurrentSessionCache(
  cached: CachedSessionUsage | undefined,
  session: SessionEntry,
  ranges: Array<{ startAt: number; endAt: number }>,
  deps: Pick<ComputeHistoryUsageDeps, "isUsageBillingCurrent">,
  modelCostMap: Record<string, unknown>,
) {
  if (!cached) return undefined;
  if (!deps.isUsageBillingCurrent(cached, modelCostMap)) return undefined;
  if (session.state.dirty === true) return undefined;
  const lastMessageTime = session.state.cursor?.lastMessageTime;
  if (
    typeof lastMessageTime !== "number" ||
    !Number.isFinite(lastMessageTime)
  ) {
    return undefined;
  }
  if (
    typeof session.state.createdAt !== "number" ||
    !Number.isFinite(session.state.createdAt)
  ) {
    return undefined;
  }

  const startIndex = rangeIndexForTimestamp(ranges, session.state.createdAt);
  const endIndex = rangeIndexForTimestamp(ranges, lastMessageTime);
  if (startIndex < 0 || endIndex < 0 || startIndex !== endIndex) {
    return undefined;
  }

  return {
    index: startIndex,
    usage: fromCachedSessionUsage(cached, 1),
    lastMessageTime,
  };
}

/**
 * Compute day/week/month history usage by paging through session messages.
 *
 * This is the shared core used by both the server-side `quota_summary` tool
 * and the TUI-local `/qday /qweek /qmonth` popup.
 *
 * Callers inject their own `loadMessagesPage` implementation so the function
 * does not depend on any specific runtime context.
 */
export async function computeHistoryUsage(
  deps: ComputeHistoryUsageDeps,
  period: HistoryPeriod,
  rawSince: string,
): Promise<HistoryUsageResult> {
  const now = Date.now();
  const since = parseSince(rawSince, now);
  const ranges = periodRanges(period, since, now);
  const total = emptyUsageSummary();
  const rows: HistoryUsageRow[] = ranges.map((range) => ({
    range,
    usage: emptyUsageSummary(),
  }));

  if (ranges.length === 0) {
    return { period, since, rows, total };
  }

  const startAt = ranges[0].startAt;
  const endAt = ranges[ranges.length - 1].endAt;
  const sessions = filterRangeSessions(deps.sessions, startAt, endAt);
  const modelCostMap = await deps.getModelCostMap();

  if (sessions.length > 0) {
    const fetched: HistoryPersistenceHint[] = await mapConcurrent(
      sessions,
      RANGE_USAGE_CONCURRENCY,
      async (session) => {
        const cachedHit = canUseCurrentSessionCache(
          session.state.usage,
          session,
          rows.map((row) => ({
            startAt: row.range.startAt,
            endAt: row.range.endAt,
          })),
          deps,
          modelCostMap,
        );
        if (cachedHit) {
          const rangeUsage = rows.map(() => emptyUsageSummary());
          rangeUsage[cachedHit.index] = cachedHit.usage;
          return {
            sessionID: session.sessionID,
            dateKey: session.dateKey,
            lastMessageTime: cachedHit.lastMessageTime,
            dirty: false,
            ranges: rangeUsage,
            totalUsage: cachedHit.usage,
            fullUsage: undefined,
            loadFailed: false,
            missing: false,
            persist: false,
            cursor: session.state.cursor,
          };
        }

        const usageOptions = {
          calcApiCost: (message: AssistantMessage) =>
            deps.calcApiCost(message, modelCostMap),
          classifyCacheMode: (message: AssistantMessage) =>
            deps.classifyCacheMode(message, modelCostMap),
        };
        const rangeUsage = rows.map(() => emptyUsageSummary());
        const totalUsage = emptyUsageSummary();
        const trackFullUsage = deps.shouldTrackFullUsage(
          session.state.usage,
          modelCostMap,
        );
        const fullUsage = trackFullUsage ? emptyUsageSummary() : undefined;
        let cursor: IncrementalCursor | undefined;
        const pricingKeys = new Set<string>();
        let before: string | undefined;

        while (true) {
          const load = await deps.loadMessagesPage(session.sessionID, before);
          if (load.status !== "ok") {
            return {
              sessionID: session.sessionID,
              dateKey: session.dateKey,
              lastMessageTime: session.state.cursor?.lastMessageTime,
              dirty: session.state.dirty === true,
              ranges: rows.map(() => emptyUsageSummary()),
              totalUsage: emptyUsageSummary(),
              fullUsage: undefined,
              loadFailed: load.status === "error",
              missing: load.status === "missing",
              persist: false,
              cursor: undefined,
            };
          }

          const entries = load.entries;
          if (entries.length === 0) break;

          accumulateMessagesAcrossCompletedRanges(
            rangeUsage,
            entries,
            rows.map((row) => ({
              startAt: row.range.startAt,
              endAt: row.range.endAt,
            })),
            usageOptions,
          );

          if (fullUsage) {
            accumulateMessagesInCompletedRange(
              fullUsage,
              entries,
              0,
              Number.POSITIVE_INFINITY,
              usageOptions,
            );
            cursor = mergeCursorFromEntries(cursor, entries);
            for (const { info } of entries) {
              if (info.role !== "assistant") continue;
              pricingKeys.add(`${info.providerID}:${info.modelID}`);
            }
          }

          // `session.messages(limit, before)` pages from newest to oldest.
          // When we are only computing range usage (no full-session persistence),
          // we can stop as soon as this page's newest timestamp is already older
          // than the earliest requested range boundary.
          if (!fullUsage) {
            const latestInPage = pageLatestTimestamp(entries);
            if (Number.isFinite(latestInPage) && latestInPage < startAt) {
              break;
            }
          }

          if (!load.nextBefore) break;
          before = load.nextBefore;
        }

        for (const item of rangeUsage) {
          if (item.assistantMessages > 0) {
            mergeUsage(totalUsage, item);
          }
        }
        if (totalUsage.assistantMessages > 0) {
          totalUsage.sessionCount = 1;
        }

        const pricingFingerprint = fullUsage
          ? deps.pricingFingerprintForKeys([...pricingKeys], modelCostMap)
          : undefined;
        const shouldPersist =
          !!fullUsage &&
          (!session.state.usage ||
            deps.shouldRecomputeUsageCache(
              session.state.usage,
              pricingFingerprint,
            ));

        return {
          sessionID: session.sessionID,
          dateKey: session.dateKey,
          lastMessageTime: cursor?.lastMessageTime,
          dirty: session.state.dirty === true,
          ranges: rangeUsage,
          totalUsage,
          fullUsage: shouldPersist ? fullUsage : undefined,
          pricingFingerprint,
          pricingKeys: fullUsage ? [...pricingKeys].sort() : undefined,
          loadFailed: false,
          missing: false,
          persist: shouldPersist,
          cursor,
        };
      },
    );

    const failedLoads = fetched.filter((item) => {
      if (!item.loadFailed) return false;
      if (item.dirty) return true;
      const lastMessageTime = item.lastMessageTime;
      if (typeof lastMessageTime === "number" && lastMessageTime < startAt) {
        return false;
      }
      return true;
    });
    if (failedLoads.length > 0 && deps.throwOnLoadFailure !== false) {
      throw new Error(
        `history usage unavailable: failed to load ${failedLoads.length} session(s)`,
      );
    }

    for (const item of fetched) {
      for (let index = 0; index < rows.length; index++) {
        if (item.ranges[index].assistantMessages > 0) {
          mergeUsage(rows[index].usage, item.ranges[index]);
        }
      }
      if (item.totalUsage.assistantMessages > 0) {
        mergeUsage(total, item.totalUsage);
      }
    }

    return {
      period,
      since,
      rows,
      total,
      warning:
        deps.throwOnLoadFailure === false && failedLoads.length > 0
          ? `Skipped ${failedLoads.length} session(s) that could not be loaded.`
          : undefined,
      persistenceHints: fetched,
    };
  }

  return { period, since, rows, total };
}
