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
