import fs from 'node:fs/promises'

import { isRecord, swallow } from './helpers.js'
import { createDefaultProviderRegistry } from './providers/index.js'
import { sanitizeBaseURL } from './providers/common.js'
import type {
  AuthUpdate,
  AuthValue,
  ProviderResolveContext,
} from './providers/types.js'
import type { QuotaSidebarConfig, QuotaSnapshot } from './types.js'

function resolveContext(
  providerID: string,
  providerOptions?: Record<string, unknown>,
): ProviderResolveContext {
  return { providerID, providerOptions }
}

function authCandidates(
  providerID: string,
  normalizedProviderID: string,
  adapterID: string,
) {
  const candidates = new Set<string>([
    providerID,
    normalizedProviderID,
    adapterID,
  ])
  if (adapterID === 'github-copilot') {
    candidates.add('github-copilot-enterprise')
  }
  return [...candidates]
}

function pickAuth(
  providerID: string,
  normalizedProviderID: string,
  adapterID: string,
  authMap: Record<string, AuthValue>,
) {
  for (const key of authCandidates(
    providerID,
    normalizedProviderID,
    adapterID,
  )) {
    const auth = authMap[key]
    if (auth) return auth
  }
  return undefined
}

export function quotaSort(left: QuotaSnapshot, right: QuotaSnapshot) {
  const leftOrder = left.sortOrder ?? 99
  const rightOrder = right.sortOrder ?? 99
  if (leftOrder !== rightOrder) return leftOrder - rightOrder
  const leftKey = left.adapterID || left.providerID
  const rightKey = right.adapterID || right.providerID
  return leftKey.localeCompare(rightKey)
}

export function listDefaultQuotaProviderIDs() {
  // Keep default report behavior stable for built-in subscription providers.
  return ['openai', 'github-copilot', 'anthropic']
}

export function createQuotaRuntime() {
  const providerRegistry = createDefaultProviderRegistry()

  const normalizeProviderID = (providerID: string) =>
    providerRegistry.normalizeProviderID(providerID)

  const resolveQuotaAdapter = (
    providerID: string,
    providerOptions?: Record<string, unknown>,
  ) => {
    return providerRegistry.resolve(resolveContext(providerID, providerOptions))
  }

  const quotaCacheKey = (
    providerID: string,
    providerOptions?: Record<string, unknown>,
  ) => {
    const adapter = resolveQuotaAdapter(providerID, providerOptions)
    const normalizedProviderID = normalizeProviderID(providerID)
    const baseURL = sanitizeBaseURL(providerOptions?.baseURL)
    const keyBase = adapter?.id || normalizedProviderID
    return baseURL ? `${keyBase}@${baseURL}` : keyBase
  }

  const fetchQuotaSnapshot = async (
    providerID: string,
    authMap: Record<string, AuthValue>,
    config: QuotaSidebarConfig,
    updateAuth?: AuthUpdate,
    providerOptions?: Record<string, unknown>,
  ) => {
    const context = resolveContext(providerID, providerOptions)
    const adapter = providerRegistry.resolve(context)
    if (!adapter) return undefined
    if (!adapter.isEnabled(config)) return undefined

    const normalizedProviderID =
      adapter.normalizeID?.(providerID) ?? normalizeProviderID(providerID)
    const auth = pickAuth(providerID, normalizedProviderID, adapter.id, authMap)

    const snapshot = await adapter.fetch({
      sourceProviderID: providerID,
      providerID: normalizedProviderID,
      providerOptions,
      auth,
      config,
      updateAuth,
    })

    return {
      ...snapshot,
      adapterID: snapshot.adapterID || adapter.id,
      shortLabel: snapshot.shortLabel || adapter.shortLabel,
      sortOrder: snapshot.sortOrder ?? adapter.sortOrder,
      label: snapshot.label || adapter.label,
    }
  }

  return {
    normalizeProviderID,
    resolveQuotaAdapter,
    quotaCacheKey,
    fetchQuotaSnapshot,
  }
}

type QuotaRuntime = ReturnType<typeof createQuotaRuntime>

function withRuntime<T>(fn: (runtime: QuotaRuntime) => T) {
  return fn(createQuotaRuntime())
}

export function normalizeProviderID(providerID: string) {
  return withRuntime((runtime) => runtime.normalizeProviderID(providerID))
}

export function resolveQuotaAdapter(
  providerID: string,
  providerOptions?: Record<string, unknown>,
) {
  return withRuntime((runtime) =>
    runtime.resolveQuotaAdapter(providerID, providerOptions),
  )
}

export function quotaCacheKey(
  providerID: string,
  providerOptions?: Record<string, unknown>,
) {
  return withRuntime((runtime) =>
    runtime.quotaCacheKey(providerID, providerOptions),
  )
}

export async function loadAuthMap(authPath: string) {
  const parsed = await fs
    .readFile(authPath, 'utf8')
    .then((value) => JSON.parse(value) as unknown)
    .catch(swallow('loadAuthMap'))

  if (!isRecord(parsed)) return {} as Record<string, AuthValue>

  return Object.entries(parsed).reduce<Record<string, AuthValue>>(
    (acc, [key, value]) => {
      if (!isRecord(value)) return acc
      const type = value.type
      if (type !== 'oauth' && type !== 'api' && type !== 'wellknown') return acc
      acc[key] = value as AuthValue
      return acc
    },
    {},
  )
}

export async function fetchQuotaSnapshot(
  providerID: string,
  authMap: Record<string, AuthValue>,
  config: QuotaSidebarConfig,
  updateAuth?: AuthUpdate,
  providerOptions?: Record<string, unknown>,
) {
  return withRuntime((runtime) =>
    runtime.fetchQuotaSnapshot(
      providerID,
      authMap,
      config,
      updateAuth,
      providerOptions,
    ),
  )
}
