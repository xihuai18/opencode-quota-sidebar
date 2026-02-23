export type QuotaStatus = 'ok' | 'unavailable' | 'unsupported' | 'error'

export type QuotaSnapshot = {
  providerID: string
  label: string
  status: QuotaStatus
  checkedAt: number
  remainingPercent?: number
  usedPercent?: number
  resetAt?: string
  note?: string
}

export type SessionTitleState = {
  baseTitle: string
  lastAppliedTitle?: string
}

export type QuotaSidebarState = {
  version: 1
  /** Global toggle — when false, sidebar titles are not modified */
  titleEnabled: boolean
  sessions: Record<string, SessionTitleState>
  quotaCache: Record<string, QuotaSnapshot>
}

export type QuotaSidebarConfig = {
  sidebar: {
    enabled: boolean
    width: number
    showCost: boolean
    showQuota: boolean
    maxQuotaProviders: number
  }
  quota: {
    refreshMs: number
    includeOpenAI: boolean
    includeCopilot: boolean
    includeAnthropic: boolean
  }
  toast: {
    durationMs: number
  }
}
