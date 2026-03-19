export type QuotaStatus = 'ok' | 'unavailable' | 'unsupported' | 'error'

export type QuotaWindow = {
  label: string
  /** Set false when this window line should not render a trailing percentage. */
  showPercent?: boolean
  /** Prefix for reset/expiry time text in sidebar (default: Rst). */
  resetLabel?: string
  remainingPercent?: number
  usedPercent?: number
  resetAt?: string
}

export type QuotaSnapshot = {
  providerID: string
  /** Adapter ID that produced this snapshot (e.g. openai, rightcode). */
  adapterID?: string
  label: string
  /** Short sidebar label (e.g. OpenAI, Copilot, RC). */
  shortLabel?: string
  /** Sort priority: smaller values appear first. */
  sortOrder?: number
  status: QuotaStatus
  checkedAt: number
  remainingPercent?: number
  usedPercent?: number
  resetAt?: string
  /** Balance-style quota (for providers that expose balance instead of percent). */
  balance?: {
    amount: number
    currency: string
  }
  note?: string
  /** Multi-window quota (e.g. OpenAI short-term + weekly). */
  windows?: QuotaWindow[]
}

export type SessionTitleState = {
  baseTitle: string
  lastAppliedTitle?: string
}

export type CacheCoverageMode = 'none' | 'read-only' | 'read-write'

export type CacheUsageBucket = {
  input: number
  cacheRead: number
  cacheWrite: number
  assistantMessages: number
}

export type CacheUsageBuckets = {
  readOnly: CacheUsageBucket
  readWrite: CacheUsageBucket
}

/**
 * Derived cache coverage metrics.
 *
 * - `cacheCoverage`: fraction of prompt surface covered by read-write cache
 *   (`(cacheRead + cacheWrite) / (input + cacheRead + cacheWrite)`).
 *   Only defined when the read-write bucket has traffic.
 * - `cacheReadCoverage`: fraction of prompt surface served from read-only cache
 *   (`cacheRead / (input + cacheRead)`).
 *   Only defined when the read-only bucket has traffic.
 */
export type CacheCoverageMetrics = {
  cacheCoverage: number | undefined
  cacheReadCoverage: number | undefined
}

export type CachedProviderUsage = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  cost: number
  /** Equivalent API billing cost (USD) computed from model pricing. */
  apiCost: number
  assistantMessages: number
}

export type CachedSessionUsage = {
  /** Billing aggregation cache version for cost/apiCost refresh migrations. */
  billingVersion?: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  cost: number
  /** Equivalent API billing cost (USD) computed from model pricing. */
  apiCost: number
  assistantMessages: number
  /**
   * Cache coverage buckets grouped by model cache behavior.
   *
   * `undefined` when no cache-capable models were used or data predates
   * billingVersion 3. The fallback in `resolvedCacheUsageBuckets()` derives
   * approximate buckets from top-level `cacheRead`/`cacheWrite` when missing.
   */
  cacheBuckets?: CacheUsageBuckets
  providers: Record<string, CachedProviderUsage>
}

/** Tracks incremental aggregation cursor for a session (P1). */
export type IncrementalCursor = {
  /** ID of the last processed assistant message. */
  lastMessageId?: string
  /** Timestamp of the last processed assistant message. */
  lastMessageTime?: number
  /** IDs processed at lastMessageTime (for same-timestamp correctness). */
  lastMessageIdsAtTime?: string[]
}

export type SessionState = SessionTitleState & {
  createdAt: number
  /** Parent session ID for subagent child sessions. */
  parentID?: string
  usage?: CachedSessionUsage
  /** Persisted dirtiness flag so descendant aggregation survives restart. */
  dirty?: boolean
  /** Incremental aggregation cursor (P1). */
  cursor?: IncrementalCursor
}

export type SessionDayChunk = {
  version: 1
  dateKey: string
  sessions: Record<string, SessionState>
}

export type QuotaSidebarState = {
  version: 2
  /** Global toggle — when false, sidebar titles are not modified */
  titleEnabled: boolean
  sessionDateMap: Record<string, string>
  sessions: Record<string, SessionState>
  /** Tombstones for sessions deleted from memory but not yet purged from day chunks. */
  deletedSessionDateMap: Record<string, string>
  quotaCache: Record<string, QuotaSnapshot>
}

export type QuotaSidebarConfig = {
  sidebar: {
    enabled: boolean
    width: number
    /**
     * When true, render multi-line decorated session titles.
     * Enabled by default for clearer token/quota layout in sidebar.
     * Set false to keep a compact single-line title.
     */
    multilineTitle?: boolean
    showCost: boolean
    showQuota: boolean
    /** When true, wrap long quota lines and indent continuations. */
    wrapQuotaLines: boolean
    /** Include descendant subagent sessions in session-scoped usage/quota. */
    includeChildren: boolean
    /** Max descendant traversal depth when includeChildren is enabled. */
    childrenMaxDepth: number
    /** Max number of descendant sessions to include when includeChildren is enabled. */
    childrenMaxSessions: number
    /** Concurrency for fetching descendant session messages (bounded). */
    childrenConcurrency: number
  }
  quota: {
    refreshMs: number
    includeOpenAI: boolean
    includeCopilot: boolean
    includeAnthropic: boolean
    /** Generic per-adapter switches (e.g. rightcode). */
    providers?: Record<string, { enabled?: boolean }>
    /** When true, refreshes OpenAI OAuth access token using refresh token */
    refreshAccessToken: boolean
    /** Timeout for external quota fetches */
    requestTimeoutMs: number
  }
  toast: {
    durationMs: number
  }
  /** Session retention in days. Sessions older than this are evicted from memory (M2). */
  retentionDays: number
}
