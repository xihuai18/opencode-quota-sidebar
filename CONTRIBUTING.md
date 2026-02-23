# Contributing

Thanks for your interest in contributing to opencode-quota-sidebar!

The most impactful contribution is adding quota connectors for new providers. This guide walks you through the process.

## Adding a new quota provider

The plugin has a clean provider architecture. Adding a new provider involves 3 files:

### Step 1: Write the fetch function in `src/quota.ts`

Each provider has a `fetch*Quota()` function that returns a `QuotaSnapshot`. Here's the pattern:

```typescript
async function fetchMyProviderQuota(
  auth: AuthValue | undefined,
  config: QuotaSidebarConfig,
): Promise<QuotaSnapshot> {
  const checkedAt = Date.now()

  // 1. Check auth availability
  if (!auth) {
    return {
      providerID: 'my-provider',
      label: 'My Provider',
      status: 'unavailable',
      checkedAt,
      note: 'auth not found',
    }
  }

  // 2. Check auth type (oauth / api / wellknown)
  if (auth.type !== 'oauth') {
    return {
      providerID: 'my-provider',
      label: 'My Provider',
      status: 'unsupported',
      checkedAt,
      note: 'requires oauth auth',
    }
  }

  // 3. Call the quota endpoint
  const response = await fetchWithTimeout(
    'https://api.example.com/quota',
    {
      headers: {
        Authorization: `Bearer ${auth.access}`,
        'User-Agent': 'opencode-quota-sidebar',
      },
    },
    config.quota.requestTimeoutMs,
  ).catch(swallow('fetchMyProviderQuota'))

  if (!response?.ok) {
    return {
      providerID: 'my-provider',
      label: 'My Provider',
      status: 'error',
      checkedAt,
      note: response ? `http ${response.status}` : 'network request failed',
    }
  }

  // 4. Parse the response
  const payload = await response
    .json()
    .catch(swallow('fetchMyProviderQuota:json'))
  // ... extract remainingPercent, resetAt, etc.

  // 5. Build multi-window array (optional)
  const windows: QuotaWindow[] = []
  // windows.push({ label: 'Monthly', remainingPercent: 75, resetAt: '...' })

  return {
    providerID: 'my-provider',
    label: 'My Provider',
    status: 'ok',
    checkedAt,
    remainingPercent,
    resetAt,
    windows: windows.length > 0 ? windows : undefined,
  }
}
```

Then register it in `fetchQuotaSnapshot()`:

```typescript
if (normalized === 'my-provider') {
  if (!config.quota.includeMyProvider) return undefined
  return fetchMyProviderQuota(authMap['my-provider'], config)
}
```

### Step 2: Update types in `src/types.ts`

Add a config toggle in `QuotaSidebarConfig.quota`:

```typescript
quota: {
  // ... existing fields
  includeMyProvider: boolean
}
```

And set the default in `src/storage.ts`:

```typescript
quota: {
  // ... existing defaults
  includeMyProvider: true,
}
```

### Step 3: Register in `src/index.ts`

Add your provider ID to `SUBSCRIPTION_QUOTA_PROVIDERS`:

```typescript
const SUBSCRIPTION_QUOTA_PROVIDERS = new Set([
  'openai',
  'github-copilot',
  'my-provider', // <-- add here
])
```

And add it to the default candidates in `getQuotaSnapshots()`:

```typescript
const candidates = normalized.length
  ? normalized
  : options?.allowDefault
    ? ['openai', 'github-copilot', 'anthropic', 'my-provider']
    : []
```

### Step 4: Update `normalizeProviderID()` in `src/quota.ts` (if needed)

If your provider has variant IDs (like `github-copilot` / `github-copilot-enterprise`), add normalization:

```typescript
export function normalizeProviderID(providerID: string) {
  if (providerID.startsWith('github-copilot')) return 'github-copilot'
  if (providerID.startsWith('my-provider')) return 'my-provider'
  return providerID
}
```

### Step 5: Update sidebar label in `src/format.ts`

Add a short label for the sidebar in `compactQuotaWide()`:

```typescript
const label =
  quota.providerID === 'openai'
    ? 'OpenAI'
    : quota.providerID === 'github-copilot'
      ? 'Copilot'
      : quota.providerID === 'my-provider'
        ? 'MyProv' // <-- max ~8 chars
        : quota.providerID.slice(0, 8)
```

### Step 6: Add sort order in `src/index.ts`

Update `quotaSort()` to control display order:

```typescript
const order: Record<string, number> = {
  openai: 0,
  'github-copilot': 1,
  'my-provider': 2, // <-- add here
  anthropic: 3,
}
```

## Auth discovery

The plugin reads credentials from OpenCode's `auth.json` at `<opencode-data>/auth.json`. Each provider entry has a `type` field:

- `oauth` — has `access`, `refresh`, `expires` fields
- `api` — has `key` field
- `wellknown` — has `key` or `token` field

Your provider's auth entry must be written by OpenCode core or an auth plugin. If your provider requires a separate auth flow (like Google Antigravity), you'll need to read from a separate credentials file — see how the community plugins handle `antigravity-accounts.json`.

## Known provider endpoints (from community research)

These endpoints have been confirmed working by multiple community plugins:

| Provider             | Endpoint                                                           | Notes                                                                            |
| -------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| OpenAI Codex         | `GET chatgpt.com/backend-api/wham/usage`                           | Undocumented ChatGPT internal API. Returns `primary_window` + `secondary_window` |
| GitHub Copilot       | `GET api.github.com/copilot_internal/user`                         | Internal API, needs VS Code Copilot headers                                      |
| GitHub Copilot (PAT) | `GET api.github.com/user/settings/billing/premium_request/usage`   | Public API, needs fine-grained PAT                                               |
| Google Antigravity   | `POST cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` | Internal Google API, needs Antigravity OAuth                                     |
| Zhipu AI             | `GET bigmodel.cn/api/monitor/usage/quota/limit`                    | API key auth (raw, no Bearer prefix)                                             |
| Firmware AI          | `GET app.firmware.ai/api/v1/quota`                                 | Bearer token auth                                                                |
| Chutes AI            | `GET api.chutes.ai/users/me/quota_usage/me`                        | Bearer token auth                                                                |

## Guidelines

- Use `fetchWithTimeout()` for all HTTP requests (prevents hanging on unresponsive endpoints)
- Return `QuotaSnapshot` with appropriate `status` for every code path (`ok`, `error`, `unavailable`, `unsupported`)
- Use `swallow()` for `.catch()` handlers — it logs in debug mode and returns `undefined`
- Never throw from a quota fetch function — always return a snapshot
- Use `normalizePercent()` to safely convert percentage values (handles 0-1 and 0-100 ranges)
- Keep sidebar labels short (max ~8 characters) — the sidebar is only 36 columns wide
- Add tests if your provider has complex parsing logic

## Development workflow

```bash
npm install
npm run build     # TypeScript compilation
npm test          # Run all tests (must pass)
```

Set `OPENCODE_QUOTA_DEBUG=1` to see debug logs during development.

## Code style

- TypeScript strict mode
- ES2022 target, NodeNext module resolution
- No external runtime dependencies (only `@opencode-ai/plugin` and `@opencode-ai/sdk` as peer deps)
- Prefer `isRecord()` type guard over `as` casts for unknown JSON
