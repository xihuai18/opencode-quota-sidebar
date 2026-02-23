import { configuredProviderEnabled } from './common.js'
import type { QuotaProviderAdapter } from './types.js'

export const anthropicAdapter: QuotaProviderAdapter = {
  id: 'anthropic',
  label: 'Anthropic',
  shortLabel: 'Anthropic',
  sortOrder: 30,
  matchScore: ({ providerID }) => (providerID === 'anthropic' ? 80 : 0),
  isEnabled: (config) =>
    configuredProviderEnabled(
      config.quota,
      'anthropic',
      config.quota.includeAnthropic,
    ),
  fetch: async ({ providerID, auth }) => {
    const checkedAt = Date.now()
    if (!auth) {
      return {
        providerID,
        adapterID: 'anthropic',
        label: 'Anthropic',
        shortLabel: 'Anthropic',
        sortOrder: 30,
        status: 'unavailable',
        checkedAt,
        note: 'auth not found',
      }
    }

    if (auth.type === 'api') {
      return {
        providerID,
        adapterID: 'anthropic',
        label: 'Anthropic',
        shortLabel: 'Anthropic',
        sortOrder: 30,
        status: 'unsupported',
        checkedAt,
        note: 'api key has no public quota endpoint',
      }
    }

    return {
      providerID,
      adapterID: 'anthropic',
      label: 'Anthropic',
      shortLabel: 'Anthropic',
      sortOrder: 30,
      status: 'unsupported',
      checkedAt,
      note: 'oauth quota endpoint is not publicly documented',
    }
  },
}
