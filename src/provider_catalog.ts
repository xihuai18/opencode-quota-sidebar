import type { HistoryUsageResult } from './usage_service.js'
import type { UsageSummary } from './usage.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type ProviderClient = {
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

function providerListFromResponse(response: unknown) {
  const data =
    isRecord(response) && Object.prototype.hasOwnProperty.call(response, 'data')
      ? (response as Record<string, unknown>).data
      : undefined
  const record = isRecord(data) ? data : undefined
  return Array.isArray(record?.providers)
    ? record.providers
    : Array.isArray(record?.all)
      ? record.all
      : Array.isArray(data)
        ? data
        : undefined
}

export async function listCurrentProviderIDs(input: {
  client: unknown
  directory: string
}) {
  const client = input.client as ProviderClient
  const ids = new Set<string>()

  const collect = (response: unknown) => {
    const list = providerListFromResponse(response)
    if (!list) return false
    for (const item of list) {
      if (!isRecord(item)) continue
      if (typeof item.id === 'string' && item.id) ids.add(item.id)
    }
    return ids.size > 0
  }

  if (client.config?.providers) {
    const response = await client.config.providers({
      query: { directory: input.directory },
      throwOnError: true,
    })
    if (collect(response)) return ids
  }

  if (client.provider?.list) {
    const response = await client.provider.list({
      query: { directory: input.directory },
      throwOnError: true,
    })
    collect(response)
  }

  return ids
}

export function filterUsageProvidersForDisplay(
  usage: UsageSummary,
  allowedProviderIDs: ReadonlySet<string>,
) {
  if (allowedProviderIDs.size === 0) return usage
  return {
    ...usage,
    providers: Object.fromEntries(
      Object.entries(usage.providers).filter(([providerID]) =>
        allowedProviderIDs.has(providerID),
      ),
    ),
  }
}

export function filterHistoryProvidersForDisplay(
  result: HistoryUsageResult,
  allowedProviderIDs: ReadonlySet<string>,
) {
  if (allowedProviderIDs.size === 0) return result
  return {
    ...result,
    rows: result.rows.map((row) => ({
      ...row,
      usage: filterUsageProvidersForDisplay(row.usage, allowedProviderIDs),
    })),
    total: filterUsageProvidersForDisplay(result.total, allowedProviderIDs),
  }
}
