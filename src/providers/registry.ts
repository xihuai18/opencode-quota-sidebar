import type {
  ProviderMatch,
  ProviderResolveContext,
  QuotaProviderAdapter,
} from './types.js'

export class QuotaProviderRegistry {
  private adapters: QuotaProviderAdapter[] = []

  register(adapter: QuotaProviderAdapter) {
    this.adapters.push(adapter)
  }

  all() {
    return [...this.adapters]
  }

  normalizeProviderID(providerID: string) {
    for (const adapter of this.adapters) {
      if (!adapter.normalizeID) continue
      const normalized = adapter.normalizeID(providerID)
      if (normalized !== undefined) return normalized
    }
    return providerID
  }

  resolveWithScore(ctx: ProviderResolveContext): ProviderMatch | undefined {
    let best: ProviderMatch | undefined
    for (const adapter of this.adapters) {
      const score = adapter.matchScore(ctx)
      if (score <= 0) continue
      if (!best || score > best.score) {
        best = { adapter, score }
        continue
      }
      if (score === best.score && adapter.sortOrder < best.adapter.sortOrder) {
        best = { adapter, score }
      }
    }
    return best
  }

  resolve(ctx: ProviderResolveContext) {
    return this.resolveWithScore(ctx)?.adapter
  }
}
