import { debugError, isRecord, swallow } from '../../helpers.js'
import type {
  QuotaProviderConfig,
  QuotaSidebarConfig,
  QuotaSnapshot,
  QuotaWindow,
} from '../../types.js'
import {
  asNumber,
  configuredProviderEnabled,
  fetchWithTimeout,
  sanitizeBaseURL,
  toIso,
} from '../common.js'
import type { AuthValue, QuotaFetchContext, QuotaProviderAdapter } from '../types.js'

const XYAI_BASE_URL = 'https://new.xychatai.com'

type XyaiServiceType = 'codex' | 'claudecode'

type XyaiProviderConfig = QuotaProviderConfig & {
  baseURL?: unknown
  sessionCookie?: unknown
  serviceType?: unknown
  login?: {
    username?: unknown
    password?: unknown
  }
}

function resolveSiteOrigin(value: unknown) {
  const normalized = sanitizeBaseURL(value)
  if (!normalized) return XYAI_BASE_URL
  try {
    return new URL(normalized).origin
  } catch {
    return XYAI_BASE_URL
  }
}

function isXyaiBaseURL(value: unknown) {
  const normalized = sanitizeBaseURL(value)
  if (!normalized) return false
  try {
    const parsed = new URL(normalized)
    return parsed.protocol === 'https:' && parsed.host === 'new.xychatai.com'
  } catch {
    return false
  }
}

function providerConfigFor(
  config: QuotaSidebarConfig,
  providerIDs: Array<string | undefined>,
) {
  for (const providerID of providerIDs) {
    if (!providerID) continue
    const value = config.quota.providers?.[providerID]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as XyaiProviderConfig
    }
  }
  return undefined
}

function resolveSessionCookie(
  auth: AuthValue | undefined,
  providerConfig: XyaiProviderConfig | undefined,
) {
  if (
    typeof providerConfig?.sessionCookie === 'string' &&
    providerConfig.sessionCookie
  ) {
    return providerConfig.sessionCookie
  }
  if (!auth) return undefined
  if (auth.type === 'wellknown') {
    if (typeof auth.token === 'string' && auth.token) return auth.token
  }
  return undefined
}

function resolveServiceType(providerConfig: XyaiProviderConfig | undefined) {
  return providerConfig?.serviceType === 'claudecode' ? 'claudecode' : 'codex'
}

function resolveLogin(providerConfig: XyaiProviderConfig | undefined) {
  const login = providerConfig?.login
  if (!login || typeof login !== 'object' || Array.isArray(login)) {
    return undefined
  }
  const username = typeof login.username === 'string' ? login.username.trim() : ''
  const password = typeof login.password === 'string' ? login.password : ''
  if (!username || !password) return undefined
  return { username, password }
}

function headerCookies(response: Response) {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[]
  }
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie().filter(Boolean)
  }
  const joined = response.headers.get('set-cookie')
  return joined ? [joined] : []
}

function extractShareSession(response: Response) {
  for (const value of headerCookies(response)) {
    const match = value.match(/share-session=("?)([^;"]+)\1/)
    if (match?.[2]) return match[2]
  }
  return undefined
}

async function loginAndPersistSession(
  siteOrigin: string,
  login: { username: string; password: string },
  providerID: string,
  updateAuth: QuotaFetchContext['updateAuth'],
  timeoutMs: number,
) {
  const response = await fetchWithTimeout(
    `${siteOrigin}/frontend-api/login`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'opencode-quota-sidebar',
      },
      body: JSON.stringify({
        userToken: login.username,
        password: login.password,
        token: '',
      }),
    },
    timeoutMs,
  ).catch(swallow('fetchXyaiVibeQuota:login'))

  if (!response) {
    return { error: 'login request failed' } as const
  }

  if (!response.ok) {
    return { error: `login http ${response.status}` } as const
  }

  const payload = await response.json().catch(swallow('fetchXyaiVibeQuota:loginJson'))
  if (!isRecord(payload)) {
    return { error: 'invalid login response' } as const
  }

  if (payload.code !== 1) {
    const msg = typeof payload.msg === 'string' && payload.msg ? payload.msg : 'login failed'
    return { error: msg } as const
  }

  const session = extractShareSession(response)
  if (!session) {
    return { error: 'missing share-session cookie' } as const
  }

  if (updateAuth) {
    try {
      await updateAuth(providerID, { type: 'wellknown', token: session })
    } catch (error) {
      debugError('updateAuth:xyai-vibe', error)
      return {
        session,
        warning: 'session refreshed but failed to persist; using in-memory session',
      } as const
    }
  }

  return { session } as const
}

async function fetchQuotaPayload(
  siteOrigin: string,
  session: string,
  timeoutMs: number,
) {
  const response = await fetchWithTimeout(
    `${siteOrigin}/frontend-api/vibe-code/quota`,
    {
      headers: {
        Accept: 'application/json',
        Cookie: `share-session=${session}`,
        'User-Agent': 'opencode-quota-sidebar',
      },
    },
    timeoutMs,
  ).catch(swallow('fetchXyaiVibeQuota:quota'))

  if (!response) return { error: 'network request failed' } as const
  if (!response.ok) return { error: `http ${response.status}` } as const

  const payload = await response.json().catch(swallow('fetchXyaiVibeQuota:quotaJson'))
  if (!isRecord(payload)) return { error: 'invalid response' } as const

  return { payload } as const
}

function isAuthFailure(payload: Record<string, unknown>) {
  return payload.code === -1 || payload.msg === '认证失败，请重新登录'
}

function formatAmount(value: number) {
  if (!Number.isFinite(value)) return '0'
  if (Math.abs(value) >= 10) {
    const one = value.toFixed(1)
    return one.endsWith('.0') ? one.slice(0, -2) : one
  }
  return value.toFixed(2)
}

function pickServicePayload(
  payload: Record<string, unknown>,
  preferred: XyaiServiceType,
) {
  const source = isRecord(payload.data) ? payload.data : payload
  const ordered: XyaiServiceType[] =
    preferred === 'claudecode' ? ['claudecode', 'codex'] : ['codex', 'claudecode']
  for (const key of ordered) {
    const value = source[key]
    if (isRecord(value)) return { serviceType: key, value }
  }
  return undefined
}

function parseQuotaSnapshot(args: {
  providerID: string
  serviceType: XyaiServiceType
  payload: Record<string, unknown>
  checkedAt: number
  warning?: string
}): QuotaSnapshot {
  const base: Pick<
    QuotaSnapshot,
    'providerID' | 'adapterID' | 'label' | 'shortLabel' | 'sortOrder'
  > = {
    providerID: args.providerID,
    adapterID: 'xyai-vibe',
    label: 'XYAI Vibe',
    shortLabel: 'XYAI',
    sortOrder: 7,
  }

  const subscriptions = isRecord(args.payload.subscriptions)
    ? args.payload.subscriptions
    : undefined
  const usage = isRecord(args.payload.currentUsage) ? args.payload.currentUsage : undefined

  const amountLimit = asNumber(subscriptions?.amountLimit)
  const remainingAmount = asNumber(subscriptions?.remainingAmount)
  const periodResetTime = toIso(subscriptions?.periodResetTime)
  const expireTime = toIso(subscriptions?.expireTime)

  if (amountLimit === undefined || remainingAmount === undefined) {
    return {
      ...base,
      status: 'error',
      checkedAt: args.checkedAt,
      note: 'missing quota fields',
    }
  }

  const remainingPercent =
    amountLimit > 0 ? Math.max(0, Math.min(100, (remainingAmount / amountLimit) * 100)) : undefined
  const windows: QuotaWindow[] = [
    {
      label: `Daily $${formatAmount(remainingAmount)}/$${formatAmount(amountLimit)}`,
      showPercent: false,
      remainingPercent,
      resetAt: periodResetTime,
      resetLabel: 'Rst',
    },
  ]

  const noteParts = [
    expireTime ? `exp ${expireTime.slice(5, 10)}` : undefined,
    args.serviceType === 'claudecode' ? 'service=claudecode' : undefined,
    args.warning,
  ].filter((value): value is string => Boolean(value))

  return {
    ...base,
    status: 'ok',
    checkedAt: args.checkedAt,
    remainingPercent,
    resetAt: periodResetTime,
    expiresAt: expireTime,
    note: noteParts.join(' | ') || undefined,
    windows,
  }
}

async function fetchXyaiVibeQuota(ctx: QuotaFetchContext): Promise<QuotaSnapshot> {
  const checkedAt = Date.now()
  const runtimeProviderID =
    typeof ctx.sourceProviderID === 'string' && ctx.sourceProviderID
      ? ctx.sourceProviderID
      : ctx.providerID
  const providerConfig = providerConfigFor(ctx.config, [
    runtimeProviderID,
    ctx.providerID,
    'xyai-vibe',
  ])
  const siteOrigin = resolveSiteOrigin(providerConfig?.baseURL ?? ctx.providerOptions?.baseURL)
  const serviceType = resolveServiceType(providerConfig)

  const base: Pick<
    QuotaSnapshot,
    'providerID' | 'adapterID' | 'label' | 'shortLabel' | 'sortOrder'
  > = {
    providerID: runtimeProviderID,
    adapterID: 'xyai-vibe',
    label: 'XYAI Vibe',
    shortLabel: 'XYAI',
    sortOrder: 7,
  }

  let session = resolveSessionCookie(ctx.auth, providerConfig)
  const login = resolveLogin(providerConfig)
  let warning: string | undefined

  if (!session && login) {
    const loginResult = await loginAndPersistSession(
      siteOrigin,
      login,
      ctx.providerID,
      ctx.updateAuth,
      ctx.config.quota.requestTimeoutMs,
    )
    if ('error' in loginResult) {
      return {
        ...base,
        status: 'unavailable',
        checkedAt,
        note: loginResult.error,
      }
    }
    session = loginResult.session
    warning = loginResult.warning
  }

  if (!session) {
    return {
      ...base,
      status: 'unavailable',
      checkedAt,
      note: 'missing share-session or login credentials',
    }
  }

  let quotaResult = await fetchQuotaPayload(
    siteOrigin,
    session,
    ctx.config.quota.requestTimeoutMs,
  )

  if (!('error' in quotaResult) && isAuthFailure(quotaResult.payload) && login) {
    const loginResult = await loginAndPersistSession(
      siteOrigin,
      login,
      ctx.providerID,
      ctx.updateAuth,
      ctx.config.quota.requestTimeoutMs,
    )
    if (!('error' in loginResult)) {
      session = loginResult.session
      warning = loginResult.warning ?? warning
      quotaResult = await fetchQuotaPayload(
        siteOrigin,
        session,
        ctx.config.quota.requestTimeoutMs,
      )
    }
  }

  if ('error' in quotaResult) {
    return {
      ...base,
      status: 'error',
      checkedAt,
      note: quotaResult.error,
    }
  }

  if (isAuthFailure(quotaResult.payload)) {
    return {
      ...base,
      status: 'unavailable',
      checkedAt,
      note: 'auth expired',
    }
  }

  const service = pickServicePayload(quotaResult.payload, serviceType)
  if (!service) {
    return {
      ...base,
      status: 'error',
      checkedAt,
      note: 'missing service payload',
    }
  }

  return parseQuotaSnapshot({
    providerID: runtimeProviderID,
    serviceType: service.serviceType,
    payload: service.value,
    checkedAt,
    warning,
  })
}

export const xyaiVibeAdapter: QuotaProviderAdapter = {
  id: 'xyai-vibe',
  label: 'XYAI Vibe',
  shortLabel: 'XYAI',
  sortOrder: 7,
  normalizeID: (providerID) => (providerID === 'xyai-vibe' ? 'xyai-vibe' : undefined),
  matchScore: ({ providerID, providerOptions }) => {
    if (providerID === 'xyai-vibe') return 100
    return isXyaiBaseURL(providerOptions?.baseURL) ? 95 : 0
  },
  isEnabled: (config) => configuredProviderEnabled(config.quota, 'xyai-vibe', false),
  fetch: fetchXyaiVibeQuota,
}
