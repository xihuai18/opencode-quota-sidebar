import type { QuotaSidebarConfig, QuotaSnapshot } from '../types.js'

export type OAuthAuth = {
  type: 'oauth'
  access?: string
  refresh?: string
  expires?: number
  accountId?: string
  enterpriseUrl?: string
}

export type ApiAuth = {
  type: 'api'
  key?: string
}

export type WellKnownAuth = {
  type: 'wellknown'
  key?: string
  token?: string
}

export type AuthValue = OAuthAuth | ApiAuth | WellKnownAuth

export type RefreshedOAuthAuth = {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
}

export type AuthUpdate = (
  providerID: string,
  auth: RefreshedOAuthAuth,
) => Promise<void>

export type ProviderResolveContext = {
  providerID: string
  providerOptions?: Record<string, unknown>
}

export type QuotaFetchContext = {
  /** Original provider ID before normalization (useful for adapter variants). */
  sourceProviderID?: string
  providerID: string
  providerOptions?: Record<string, unknown>
  auth: AuthValue | undefined
  config: QuotaSidebarConfig
  updateAuth?: AuthUpdate
}

export type QuotaProviderAdapter = {
  id: string
  label: string
  shortLabel: string
  sortOrder: number
  /** Higher score wins. 0 means no match. */
  matchScore: (ctx: ProviderResolveContext) => number
  /** Resolve provider ID variants to a canonical id when needed. */
  normalizeID?: (providerID: string) => string | undefined
  /** Provider-specific enable switch (supports backward-compatible flags). */
  isEnabled: (config: QuotaSidebarConfig) => boolean
  fetch: (ctx: QuotaFetchContext) => Promise<QuotaSnapshot>
}

export type ProviderMatch = {
  adapter: QuotaProviderAdapter
  score: number
}
