import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Message } from '@opencode-ai/sdk'

import {
  summarizeMessages,
  summarizeMessagesIncremental,
  toCachedSessionUsage,
} from '../usage.js'

function assistantMessage(
  id: string,
  created: number,
  completed: number,
  overrides?: Partial<{
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
    cost: number
    providerID: string
    modelID: string
  }>,
): Message {
  return {
    id,
    role: 'assistant',
    providerID: overrides?.providerID ?? 'openai',
    modelID: overrides?.modelID ?? 'gpt-5',
    sessionID: 's1',
    time: { created, completed },
    tokens: {
      input: overrides?.input ?? 100,
      output: overrides?.output ?? 50,
      reasoning: overrides?.reasoning ?? 0,
      cache: {
        read: overrides?.cacheRead ?? 0,
        write: overrides?.cacheWrite ?? 0,
      },
    },
    cost: overrides?.cost ?? 0.01,
  } as unknown as Message
}

function userMessage(id: string, created: number): Message {
  return {
    id,
    role: 'user',
    sessionID: 's1',
    time: { created, completed: created + 1 },
  } as unknown as Message
}

describe('summarizeMessages', () => {
  it('counts only completed assistant messages after startAt', () => {
    const entries = [
      { info: assistantMessage('a1', 1000, 1100, { input: 10, output: 20 }) },
      { info: userMessage('u1', 1200) },
      {
        info: {
          ...assistantMessage('a2', 1300, 1400, { input: 30, output: 40 }),
          time: { created: 1300, completed: undefined },
        } as unknown as Message,
      },
      { info: assistantMessage('a3', 2000, 2100, { input: 50, output: 60 }) },
    ]

    const summary = summarizeMessages(entries, 1500, 1)
    assert.equal(summary.assistantMessages, 1)
    assert.equal(summary.input, 50)
    assert.equal(summary.output, 60)
    assert.equal(summary.total, 110)
  })

  it('uses message.cost directly and falls back to 0 for non-finite', () => {
    const entries = [
      { info: assistantMessage('a1', 1000, 1100, { cost: 0.123 }) },
      { info: assistantMessage('a2', 1200, 1300, { cost: Number.NaN }) },
    ]
    const summary = summarizeMessages(entries, 0, 1)
    assert.equal(summary.cost, 0.123)
  })
})

describe('summarizeMessagesIncremental', () => {
  it('does full scan when cursor/usage is missing', () => {
    const entries = [
      { info: assistantMessage('a1', 1000, 1100, { input: 10 }) },
      { info: assistantMessage('a2', 1200, 1300, { input: 20 }) },
    ]
    const { usage, cursor } = summarizeMessagesIncremental(
      entries,
      undefined,
      undefined,
      false,
    )
    assert.equal(usage.assistantMessages, 2)
    assert.equal(usage.input, 30)
    assert.equal(cursor.lastMessageId, 'a2')
  })

  it('processes only messages after cursor', () => {
    const baselineEntries = [
      { info: assistantMessage('a1', 1000, 1100, { input: 10 }) },
      { info: assistantMessage('a2', 1200, 1300, { input: 20 }) },
    ]
    const baseline = summarizeMessages(baselineEntries, 0, 1)

    const nextEntries = [
      { info: assistantMessage('a1', 1000, 1100, { input: 10 }) },
      { info: assistantMessage('a2', 1200, 1300, { input: 20 }) },
      { info: assistantMessage('a3', 1400, 1500, { input: 30, output: 1 }) },
    ]
    const { usage, cursor } = summarizeMessagesIncremental(
      nextEntries,
      toCachedSessionUsage(baseline),
      { lastMessageId: 'a2', lastMessageTime: 1300 },
      false,
    )

    assert.equal(usage.assistantMessages, 3)
    assert.equal(usage.input, 60)
    assert.equal(cursor.lastMessageId, 'a3')
  })

  it('falls back to full rescan when cursor message is missing', () => {
    const entries = [
      { info: assistantMessage('a1', 1000, 1100, { input: 10 }) },
      { info: assistantMessage('a2', 1200, 1300, { input: 20 }) },
    ]

    const existing = toCachedSessionUsage(summarizeMessages(entries, 0, 1))
    const { usage, cursor } = summarizeMessagesIncremental(
      entries,
      existing,
      { lastMessageId: 'missing-id', lastMessageTime: 9999 },
      false,
    )

    assert.equal(usage.assistantMessages, 2)
    assert.equal(usage.input, 30)
    assert.equal(cursor.lastMessageId, 'a2')
  })

  it('forceRescan ignores cursor and recomputes', () => {
    const entries = [
      { info: assistantMessage('a1', 1000, 1100, { input: 10 }) },
      { info: assistantMessage('a2', 1200, 1300, { input: 20 }) },
    ]
    const existing = toCachedSessionUsage(
      summarizeMessages([{ info: assistantMessage('a1', 1000, 1100) }], 0, 1),
    )
    const { usage, cursor } = summarizeMessagesIncremental(
      entries,
      existing,
      { lastMessageId: 'a1', lastMessageTime: 1100 },
      true,
    )
    assert.equal(usage.assistantMessages, 2)
    assert.equal(usage.input, 30)
    assert.equal(cursor.lastMessageId, 'a2')
  })
})
