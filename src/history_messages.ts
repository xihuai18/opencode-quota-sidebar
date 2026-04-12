import type { Message } from '@opencode-ai/sdk'

import { debug } from './helpers.js'

export type MessageEntry = { info: Message }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

type Tokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

function decodeTokens(value: unknown): Tokens | undefined {
  if (!isRecord(value)) return undefined
  if (!isFiniteNumber(value.input)) return undefined
  if (!isFiniteNumber(value.output)) return undefined

  const reasoning = isFiniteNumber(value.reasoning) ? value.reasoning : 0
  const cacheRaw = isRecord(value.cache) ? value.cache : {}
  const read = isFiniteNumber(cacheRaw.read) ? cacheRaw.read : 0
  const write = isFiniteNumber(cacheRaw.write) ? cacheRaw.write : 0
  return {
    input: value.input,
    output: value.output,
    reasoning,
    cache: { read, write },
  }
}

export function decodeMessageInfo(value: unknown): Message | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.id !== 'string') return undefined
  if (typeof value.sessionID !== 'string') return undefined
  if (typeof value.role !== 'string') return undefined
  if (!isRecord(value.time)) return undefined
  if (!isFiniteNumber(value.time.created)) return undefined
  if (
    value.time.completed !== undefined &&
    !isFiniteNumber(value.time.completed)
  ) {
    return undefined
  }

  if (value.role !== 'assistant') {
    return {
      ...(value as any),
      time: {
        created: value.time.created,
        completed: value.time.completed,
      },
    } as Message
  }

  if (typeof value.providerID !== 'string') return undefined
  if (typeof value.modelID !== 'string') return undefined

  const tokens = decodeTokens(value.tokens)
  if (!tokens) return undefined

  return {
    ...(value as any),
    time: {
      created: value.time.created,
      completed: value.time.completed,
    },
    tokens,
  } as Message
}

export function decodeMessageEntries(
  value: unknown,
): MessageEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const decoded = value
    .map((item) => {
      if (!isRecord(item)) return undefined
      const info = decodeMessageInfo(item.info)
      if (!info) return undefined
      return { info }
    })
    .filter((item): item is MessageEntry => Boolean(item))

  if (decoded.length > 0 && decoded.length < value.length) {
    debug(
      `message entries partially decoded: kept ${decoded.length}/${value.length}`,
    )
    return undefined
  }

  if (decoded.length === 0 && value.length > 0) return undefined
  return decoded
}

export function nextCursorFromResponse(value: unknown) {
  if (!isRecord(value)) return undefined
  const response = value.response
  if (!isRecord(response)) return undefined
  const headers = response.headers
  if (!headers || typeof (headers as { get?: unknown }).get !== 'function') {
    return undefined
  }
  const next = (headers as { get: (name: string) => string | null }).get(
    'X-Next-Cursor',
  )
  return typeof next === 'string' && next ? next : undefined
}

function errorStatusCode(
  value: unknown,
  seen = new Set<unknown>(),
): number | undefined {
  if (!isRecord(value) || seen.has(value)) return undefined
  seen.add(value)

  const status = value.status
  if (typeof status === 'number' && Number.isFinite(status)) return status

  const statusCode = value.statusCode
  if (typeof statusCode === 'number' && Number.isFinite(statusCode)) {
    return statusCode
  }

  return (
    errorStatusCode(value.response, seen) ||
    errorStatusCode(value.cause, seen) ||
    errorStatusCode(value.error, seen)
  )
}

function errorText(value: unknown, seen = new Set<unknown>()): string {
  if (!value || seen.has(value)) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return `${value}`
  if (value instanceof Error) {
    seen.add(value)
    return [
      value.message,
      errorText((value as Error & { cause?: unknown }).cause, seen),
    ]
      .filter(Boolean)
      .join('\n')
  }
  if (!isRecord(value)) return ''

  seen.add(value)
  return [
    typeof value.message === 'string' ? value.message : '',
    typeof value.error === 'string' ? value.error : '',
    typeof value.detail === 'string' ? value.detail : '',
    typeof value.title === 'string' ? value.title : '',
    errorText(value.response, seen),
    errorText(value.data, seen),
    errorText(value.cause, seen),
  ]
    .filter(Boolean)
    .join('\n')
}

export function isMissingSessionError(error: unknown) {
  const status = errorStatusCode(error)
  if (status === 404 || status === 410) return true

  const text = errorText(error).toLowerCase()
  if (!text) return false

  return (
    /\b(session|conversation)\b.*\b(not found|missing|deleted|does not exist)\b/.test(
      text,
    ) ||
    /\b(not found|missing|deleted|does not exist)\b.*\b(session|conversation)\b/.test(
      text,
    )
  )
}
