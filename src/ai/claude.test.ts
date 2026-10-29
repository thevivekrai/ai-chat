import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aiThread } from '@/test/fixtures'
import { LlmError, classifyPriority, draftReply, extractTasks, setAiAccessPolicy, setLlmConfig } from '.'

/** A stand-in for api.anthropic.com that records what the SDK sends. */
function fakeApi(respond: (body: Record<string, unknown>) => { status?: number; json: unknown }) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ url: String(url), headers: new Headers(init?.headers), body })
    const { status = 200, json } = respond(body)
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

const message = (output: unknown, stop_reason = 'end_turn') => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text: JSON.stringify(output) }],
  stop_reason,
  stop_sequence: null,
  stop_details: null,
  usage: { input_tokens: 10, output_tokens: 10 },
})

// The SDK keeps one client per key, and a client keeps the fetch it was created with.
let keyCounter = 0
function useClaude() {
  setLlmConfig({ provider: 'anthropic', apiKey: `sk-test-${++keyCounter}`, model: 'claude-opus-5-5', triageModel: 'claude-haiku-5-5' })
}

beforeEach(() => {
  setAiAccessPolicy(() => true)
  useClaude()
})

afterEach(() => {
  setLlmConfig(null)
  vi.unstubAllGlobals()
})

describe('Claude requests', () => {
  it('sorts with the triage model, structured output and server-side fallbacks', async () => {
    const calls = fakeApi(() => ({
      json: message({
        priority: 'urgent',
        expectsReply: true,
        reason: ' Customer waiting on a late order. ',
        // Made-up and repeated tags are dropped.
        labels: ['order', 'follow-up', 'order', 'gossip', 'work', 'question'],
      }),
    }))

    const result = await classifyPriority(aiThread('priya'))

    expect(result).toMatchObject({
      priority: 'urgent',
      expectsReply: true,
      reason: 'Customer waiting on a late order.',
      // Unknown tags dropped, each once, at most three.
      labels: ['order', 'follow-up', 'work'],
    })
    // What the tags came from is kept, to tell later why a chat got them.
    expect(result.audit).toMatchObject({ model: 'anthropic:claude-haiku-5-5', messageIds: expect.arrayContaining(['priya-1']) })
    expect(result.audit?.promptHash).toMatch(/^[0-9a-f]{8}$/)
    expect(calls).toHaveLength(1)
    const [{ url, headers, body }] = calls
    expect(url).toBe('https://api.anthropic.com/v1/messages?beta=true')
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01')
    // Required for api.anthropic.com to accept calls from a web page.
    expect(headers.get('anthropic-dangerous-direct-browser-access')).toBe('true')
    expect(body).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 16000,
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    })
    // Sampling parameters and manual thinking budgets are rejected by current models.
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('thinking')
    expect(JSON.stringify(body.messages)).toContain('label created')
    // The tags it may choose from, and how long they've been waiting.
    expect(JSON.stringify(body.output_config)).toContain('follow-up')
    expect(JSON.stringify(body.messages)).toMatch(/messages? from others since the user last wrote/)
  })

  it('drafts all three tones in one call', async () => {
    const calls = fakeApi(() => ({
      json: message({ short: 'On it!', friendly: 'Checking now 😊', professional: 'I am looking into it.' }),
    }))
    const thread = aiThread('priya')

    const drafts = await Promise.all(['short', 'friendly', 'professional'].map((t) => draftReply(thread, t as never)))

    expect(drafts.map((d) => d.text)).toEqual(['On it!', 'Checking now 😊', 'I am looking into it.'])
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'medium' } })
  })

  it('drops task sources and dates the chat does not support', async () => {
    fakeApi(() => ({
      json: message({
        tasks: [
          { title: 'Ship order #MS-2041', dueAt: '2026-10-24T18:00:00+05:30', dueText: 'Saturday', sourceMessageId: 'priya-5' },
          { title: 'Call the courier', dueAt: 'someday', dueText: 'someday', sourceMessageId: 'made-up' },
        ],
      }),
    }))
    const thread = aiThread('priya')

    const tasks = await extractTasks(thread)

    expect(tasks[0]).toMatchObject({ title: 'Ship order #MS-2041', dueText: 'Saturday', sourceMessageId: 'priya-5' })
    expect(tasks[0].dueAt).toBe(new Date('2026-10-24T18:00:00+05:30').toISOString())
    expect(tasks[1]).toMatchObject({ dueAt: null, dueText: null })
    expect(thread.messages.some((m) => m.id === tasks[1].sourceMessageId)).toBe(true)
  })
})

describe('Claude errors', () => {
  it('reports a declined request', async () => {
    fakeApi(() => ({ json: { ...message({}), content: [], stop_reason: 'refusal' } }))
    await expect(classifyPriority(aiThread('priya'))).rejects.toMatchObject({ name: 'LlmError', kind: 'refusal' })
  })

  it('explains a rejected key', async () => {
    fakeApi(() => ({
      status: 401,
      json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    }))
    const error = await classifyPriority(aiThread('priya')).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ kind: 'auth' })
  })

  it('passes on what the API says about a bad request', async () => {
    fakeApi(() => ({
      status: 400,
      json: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low.' } },
    }))
    await expect(classifyPriority(aiThread('priya'))).rejects.toMatchObject({
      kind: 'bad_request',
      message: 'Your credit balance is too low.',
    })
  })

  it('never calls Claude for a chat AI may not read', async () => {
    const calls = fakeApi(() => ({ json: message({}) }))
    setAiAccessPolicy(() => false)
    await expect(classifyPriority(aiThread('priya'))).rejects.toMatchObject({ name: 'AiAccessError' })
    expect(calls).toHaveLength(0)
  })
})
