import type { PluginInput } from '@opencode-ai/plugin'

import { TtlValueCache } from './cache.js'
import { swallow } from './helpers.js'
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

    const configClient = deps.client as unknown as {
      config?: {
        providers?: (args: {
          query: { directory: string }
          throwOnError: true
        }) => Promise<unknown>
      }
    }

    if (!configClient.config?.providers) {
      return providerOptionsCache.set({}, 30_000)
    }

    const response = await configClient.config
      .providers({
        query: { directory: deps.directory },
        throwOnError: true,
      })
      .catch(swallow('getProviderOptionsMap'))

    const data =
      response &&
      typeof response === 'object' &&
      'data' in response &&
      response.data &&
      typeof response.data === 'object' &&
      'providers' in response.data
        ? ((response.data as { providers?: unknown }).providers as unknown)
        : undefined

    const map = Array.isArray(data)
      ? data.reduce<Record<string, Record<string, unknown>>>((acc, item) => {
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
      return true
    if (!snapshot.windows || snapshot.windows.length === 0) return true
    const primary = snapshot.windows[0]
    if (!primary.label.startsWith('Daily $')) return false
    if (primary.showPercent !== false) return false
    return true
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
      if (
        cached &&
        Date.now() - cached.checkedAt <= deps.config.quota.refreshMs
      ) {
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
