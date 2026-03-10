import type { PluginInput } from '@opencode-ai/plugin'

import { TtlValueCache } from './cache.js'
import { isRecord, swallow } from './helpers.js'
import { listDefaultQuotaProviderIDs, loadAuthMap, quotaSort } from './quota.js'
import type {
  QuotaSidebarConfig,
  QuotaSidebarState,
  QuotaSnapshot,
} from './types.js'
import type { AuthValue } from './providers/types.js'

export function createQuotaService(deps: {
  quotaRuntime: {
    normalizeProviderID: (providerID: string) => string
    resolveQuotaAdapter: (
      providerID: string,
      providerOptions?: Record<string, unknown>,
    ) => { id: string } | undefined
    quotaCacheKey: (
      providerID: string,
      providerOptions?: Record<string, unknown>,
    ) => string
    fetchQuotaSnapshot: (
      providerID: string,
      authMap: Record<string, AuthValue>,
      config: QuotaSidebarConfig,
      updateAuth?: (providerID: string, next: unknown) => Promise<void>,
      providerOptions?: Record<string, unknown>,
    ) => Promise<QuotaSnapshot | undefined>
  }
  config: QuotaSidebarConfig
  state: QuotaSidebarState
  authPath: string
  client: PluginInput['client']
  directory: string
  scheduleSave: () => void
}) {
  const ERROR_CACHE_TTL_MS = 30_000
  const ZERO_QUOTA_CACHE_TTL_MS = 15_000
  const LOW_QUOTA_CACHE_TTL_MS = 30_000
  const SOON_RESET_CACHE_TTL_MS = 15_000
  const SOON_RESET_WINDOW_MS = 2 * 60 * 1000

  const authCache = new TtlValueCache<Record<string, AuthValue>>()
  const providerOptionsCache = new TtlValueCache<
    Record<string, Record<string, unknown>>
  >()

  const inFlight = new Map<string, Promise<QuotaSnapshot | undefined>>()

  const getAuthMap = async () => {
    const cached = authCache.get()
    if (cached) return cached
    const value = await loadAuthMap(deps.authPath)
    return authCache.set(value, 30_000)
  }

  const getProviderOptionsMap = async () => {
    const cached = providerOptionsCache.get()
    if (cached) return cached

    const client = deps.client as unknown as {
      config?: {
        providers?: (args: {
          query: { directory: string }
          throwOnError: true
        }) => Promise<unknown>
      }
      provider?: {
        list?: (args?: {
          query?: { directory: string }
          throwOnError?: true
        }) => Promise<unknown>
      }
    }

    if (!client.config?.providers && !client.provider?.list) {
      return providerOptionsCache.set({}, 30_000)
    }

    // Newer runtimes expose config.providers; older clients may only expose
    // provider.list with a slightly different response shape.
    const response = await (
      client.config?.providers
        ? client.config.providers({
            query: { directory: deps.directory },
            throwOnError: true,
          })
        : client.provider!.list!({
            query: { directory: deps.directory },
            throwOnError: true,
          })
    ).catch(swallow('getProviderOptionsMap'))

    const data =
      isRecord(response) && isRecord(response.data) ? response.data : undefined

    const list = Array.isArray(data?.providers)
      ? data.providers
      : Array.isArray(data?.all)
        ? data.all
        : Array.isArray(data)
          ? data
          : undefined

    const map = Array.isArray(list)
      ? list.reduce<Record<string, Record<string, unknown>>>((acc, item) => {
          if (!item || typeof item !== 'object') return acc
          const record = item as Record<string, unknown>
          const id = record.id
          const options = record.options
          if (typeof id !== 'string') return acc
          if (
            !options ||
            typeof options !== 'object' ||
            Array.isArray(options)
          ) {
            acc[id] = {}
            return acc
          }
          acc[id] = options as Record<string, unknown>
          return acc
        }, {})
      : {}

    return providerOptionsCache.set(map, 30_000)
  }

  const isValidQuotaCache = (snapshot: QuotaSnapshot) => {
    // Guard against stale RightCode cache entries from pre-daily format.
    if (snapshot.adapterID !== 'rightcode' || snapshot.status !== 'ok')
      return !(
        snapshot.adapterID === 'anthropic' &&
        snapshot.status === 'unsupported' &&
        snapshot.note === 'oauth quota endpoint is not publicly documented'
      )
    if (!snapshot.windows || snapshot.windows.length === 0) return true
    const primary = snapshot.windows[0]
    if (!primary.label.startsWith('Daily $')) return false
    if (primary.showPercent !== false) return false
    return true
  }

  const parseResetAtMs = (value: string | undefined) => {
    if (!value) return undefined
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }

  const snapshotRemainingPercents = (snapshot: QuotaSnapshot) => {
    const values: number[] = []
    if (
      typeof snapshot.remainingPercent === 'number' &&
      Number.isFinite(snapshot.remainingPercent)
    ) {
      values.push(snapshot.remainingPercent)
    }
    if (snapshot.windows && snapshot.windows.length > 0) {
      for (const window of snapshot.windows) {
        if (
          typeof window.remainingPercent === 'number' &&
          Number.isFinite(window.remainingPercent)
        ) {
          values.push(window.remainingPercent)
        }
      }
    }
    return values
  }

  const snapshotResetTimes = (snapshot: QuotaSnapshot) => {
    const values: number[] = []
    const topLevel = parseResetAtMs(snapshot.resetAt)
    if (topLevel !== undefined) values.push(topLevel)
    if (snapshot.windows && snapshot.windows.length > 0) {
      for (const window of snapshot.windows) {
        const parsed = parseResetAtMs(window.resetAt)
        if (parsed !== undefined) values.push(parsed)
      }
    }
    return values
  }

  const effectiveQuotaCacheTtl = (
    snapshot: QuotaSnapshot,
    now = Date.now(),
  ) => {
    let ttlMs = deps.config.quota.refreshMs

    if (snapshot.status !== 'ok') {
      ttlMs = Math.min(ttlMs, ERROR_CACHE_TTL_MS)
    }

    const remainingPercents = snapshotRemainingPercents(snapshot)
    if (remainingPercents.some((value) => value <= 0)) {
      ttlMs = Math.min(ttlMs, ZERO_QUOTA_CACHE_TTL_MS)
    } else if (remainingPercents.some((value) => value <= 1)) {
      ttlMs = Math.min(ttlMs, LOW_QUOTA_CACHE_TTL_MS)
    }

    const resetTimes = snapshotResetTimes(snapshot)
    if (resetTimes.some((resetAt) => resetAt <= now)) return 0
    if (resetTimes.some((resetAt) => resetAt - now <= SOON_RESET_WINDOW_MS)) {
      ttlMs = Math.min(ttlMs, SOON_RESET_CACHE_TTL_MS)
    }

    return Math.max(0, ttlMs)
  }

  const getQuotaSnapshots = async (
    providerIDs: string[],
    options?: { allowDefault?: boolean },
  ) => {
    const allowDefault = options?.allowDefault === true

    const [authMap, providerOptionsMap] = await Promise.all([
      getAuthMap(),
      getProviderOptionsMap(),
    ])

    const optionsForProvider = (providerID: string) => {
      return (
        providerOptionsMap[providerID] ||
        providerOptionsMap[deps.quotaRuntime.normalizeProviderID(providerID)]
      )
    }

    const directCandidates = providerIDs.map((providerID) => ({
      providerID,
      providerOptions: optionsForProvider(providerID),
    }))

    const defaultCandidates = allowDefault
      ? [
          ...Object.keys(providerOptionsMap).map((providerID) => ({
            providerID,
            providerOptions: providerOptionsMap[providerID],
          })),
          ...listDefaultQuotaProviderIDs().map((providerID) => ({
            providerID,
            providerOptions: optionsForProvider(providerID),
          })),
        ]
      : []

    const rawCandidates = directCandidates.length
      ? directCandidates
      : defaultCandidates

    const matchedCandidates = rawCandidates.filter((candidate) =>
      Boolean(
        deps.quotaRuntime.resolveQuotaAdapter(
          candidate.providerID,
          candidate.providerOptions,
        ),
      ),
    )

    const dedupedCandidates = Array.from(
      matchedCandidates
        .reduce((acc, candidate) => {
          const key = deps.quotaRuntime.quotaCacheKey(
            candidate.providerID,
            candidate.providerOptions,
          )
          if (!acc.has(key)) acc.set(key, candidate)
          return acc
        }, new Map<string, { providerID: string; providerOptions?: Record<string, unknown> }>())
        .values(),
    )

    function authScopeFor(
      providerID: string,
      providerOptions?: Record<string, unknown>,
    ) {
      const adapter = deps.quotaRuntime.resolveQuotaAdapter(
        providerID,
        providerOptions,
      )
      const normalized = deps.quotaRuntime.normalizeProviderID(providerID)
      const adapterID = adapter?.id

      const candidates: string[] = []
      const push = (value: string | undefined) => {
        if (!value) return
        if (!candidates.includes(value)) candidates.push(value)
      }
      push(providerID)
      push(normalized)
      push(adapterID)
      if (adapterID === 'github-copilot') push('github-copilot-enterprise')

      for (const key of candidates) {
        const auth = authMap[key]
        if (!auth) continue
        if (
          key === 'openai' &&
          auth.type === 'oauth' &&
          typeof auth.accountId === 'string' &&
          auth.accountId
        ) {
          return `${key}@${auth.accountId}`
        }
        return key
      }

      return 'none'
    }

    let cacheChanged = false

    const fetchSnapshot = (
      providerID: string,
      providerOptions?: Record<string, unknown>,
    ) => {
      const baseKey = deps.quotaRuntime.quotaCacheKey(
        providerID,
        providerOptions,
      )
      const cacheKey = `${baseKey}#${authScopeFor(providerID, providerOptions)}`

      const cached = deps.state.quotaCache[cacheKey]
      const now = Date.now()
      const cacheTtl = cached ? effectiveQuotaCacheTtl(cached, now) : 0
      if (cached && cacheTtl > 0 && now - cached.checkedAt <= cacheTtl) {
        if (isValidQuotaCache(cached)) return Promise.resolve(cached)
        delete deps.state.quotaCache[cacheKey]
        cacheChanged = true
      }

      const existing = inFlight.get(cacheKey)
      if (existing) return existing

      const promise = deps.quotaRuntime
        .fetchQuotaSnapshot(
          providerID,
          authMap as unknown as Record<string, AuthValue>,
          deps.config,
          async (id, next) => {
            await deps.client.auth
              .set({
                path: { id },
                query: { directory: deps.directory },
                body: next as any,
                throwOnError: true,
              })
              .catch(swallow('getQuotaSnapshots:authSet'))
          },
          providerOptions,
        )
        .then((latest) => {
          if (!latest) return undefined
          deps.state.quotaCache[cacheKey] = latest
          cacheChanged = true
          return latest
        })
        .finally(() => {
          if (inFlight.get(cacheKey) === promise) {
            inFlight.delete(cacheKey)
          }
        })

      inFlight.set(cacheKey, promise)
      return promise
    }

    const fetched = await Promise.all(
      dedupedCandidates.map(({ providerID, providerOptions }) =>
        fetchSnapshot(providerID, providerOptions),
      ),
    )

    const snapshots = fetched.filter((value): value is QuotaSnapshot =>
      Boolean(value),
    )
    snapshots.sort(quotaSort)
    if (cacheChanged) deps.scheduleSave()
    return snapshots
  }

  return { getQuotaSnapshots }
}
