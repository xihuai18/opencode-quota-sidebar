# Contributing

Thanks for contributing to opencode-quota-sidebar.

The plugin now uses a provider adapter registry, so adding a new provider does not require editing core dispatch logic.

## Architecture overview

- Provider adapters live in `src/providers/`
- Built-in adapters live in `src/providers/core/`
- Third-party/community adapters live in `src/providers/third_party/`
- `src/providers/registry.ts` resolves which adapter handles a provider
- `src/quota.ts` provides `createQuotaRuntime()`; runtime methods delegate to resolved adapter and manage auth/cache glue
- `src/format.ts` renders generic sidebar/report output from `QuotaSnapshot`

## Common adapter patterns

- Direct provider ID match: best for first-party providers with stable IDs
- `baseURL` match: best for OpenAI-compatible relays such as RightCode or Buzz
- Prefix/variant normalization: best when one provider has multiple runtime IDs
- Balance-only providers should prefer `balance` over inventing fake percent windows
- Built-in API-key providers such as `kimi-for-coding` may need both: direct ID matching for the canonical provider and support for OpenCode's discovered `key -> options.apiKey` bridge

## Add a new provider

### 1) Create an adapter file

Add `src/providers/third_party/<your-provider>.ts` and implement `QuotaProviderAdapter`.

Minimal shape:

```ts
import type { QuotaProviderAdapter } from './types.js'

export const myProviderAdapter: QuotaProviderAdapter = {
  id: 'my-provider',
  label: 'My Provider',
  shortLabel: 'MyProv',
  sortOrder: 40,
  matchScore: ({ providerID, providerOptions }) => {
    if (providerID === 'my-provider') return 80
    if (providerOptions?.baseURL === 'https://api.example.com') return 100
    return 0
  },
  isEnabled: (config) =>
    config.quota.providers?.['my-provider']?.enabled ?? true,
  fetch: async ({ providerID, auth, config }) => {
    const checkedAt = Date.now()
    // ... call endpoint, parse payload, return QuotaSnapshot
    return {
      providerID,
      adapterID: 'my-provider',
      label: 'My Provider',
      shortLabel: 'MyProv',
      sortOrder: 40,
      status: 'ok',
      checkedAt,
      remainingPercent: 80,
    }
  },
}
```

### 2) Register the adapter

Edit `src/providers/index.ts` and add `registry.register(myProviderAdapter)`.

If your provider has ID variants, implement `normalizeID` in the adapter.

If your provider is an OpenAI-compatible relay, prefer matching on
`providerOptions.baseURL` instead of the runtime `providerID`; that keeps custom
aliases working without extra user config.

If your provider is built into OpenCode and already has a stable runtime ID
(for example `kimi-for-coding`), prefer a direct provider-ID match first, then
add a `baseURL` fallback only when it helps older/custom runtime shapes.

If the new provider should appear in default `quota_summary` reports even when
it has not yet been used in the current session, also update
`listDefaultQuotaProviderIDs()` in `src/quota.ts`.

### 3) Optional config toggle

Add to user config:

```json
{
  "quota": {
    "providers": {
      "my-provider": { "enabled": true }
    }
  }
}
```

### 4) Add tests

At minimum:

- adapter selection (`matchScore`)
- successful response parsing
- error/unavailable paths
- format output if using special fields (e.g. `balance`)
- cache compatibility if the change replaces an older snapshot shape
- mixed-provider rendering if the new provider will commonly appear next to
  OpenAI/Copilot/Kimi/RightCode in sidebar or toast output

If the provider introduces new rendering rules or multi-window behavior, add
coverage in both `src/__tests__/quota.test.ts` and `src/__tests__/format.test.ts`.

## QuotaSnapshot rules

- Always fill `status` (`ok`, `error`, `unavailable`, `unsupported`)
- Keep `providerID` as runtime provider identity
- Set `adapterID`, `label`, `shortLabel`, `sortOrder`
- Use `windows` for percent-based quota windows
- Use `balance` for balance-based providers
- Never throw in adapter `fetch`; return an error snapshot instead

## Development workflow

```bash
npm install
npm run build
npm test
```

Both build and tests must pass before submitting a PR.

If you change TypeScript types, config loading, or public behavior, also run:

```bash
npm run typecheck
```

## Documentation checklist

When a change affects users, update the relevant docs in the same PR:

- `README.md` for install, config, behavior, examples, or troubleshooting
- `CONTRIBUTING.md` if the change affects adapter patterns or provider authoring guidance
- `CHANGELOG.md` for released user-facing changes
- `SECURITY.md` if the change affects auth handling, external requests, or data storage
