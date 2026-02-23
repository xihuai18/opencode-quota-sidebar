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
  providers: Record<string, CachedProviderUsage>
}

/** Tracks incremental aggregation cursor for a session (P1). */
export type IncrementalCursor = {
  /** ID of the last processed assistant message. */
  lastMessageId?: string
  /** Timestamp of the last processed assistant message. */
  lastMessageTime?: number
}

export type SessionState = SessionTitleState & {
  createdAt: number
  usage?: CachedSessionUsage
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
  quotaCache: Record<string, QuotaSnapshot>
}

export type QuotaSidebarConfig = {
  sidebar: {
    enabled: boolean
    width: number
    showCost: boolean
    showQuota: boolean
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
