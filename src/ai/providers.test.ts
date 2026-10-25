import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aiThread } from '@/test/fixtures'
import { LlmError, classifyPriority, setAiAccessPolicy, setLlmConfig, summarizeThread, testKey } from '.'

/** Records what is sent and answers each call in turn with `answers` (the last one repeats). */
function fakeFetch(...answers: { status?: number; json: unknown }[]) {
  const calls: { url: string; headers: Headers; body: any }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const { status = 200, json } = answers[Math.min(calls.length - 1, answers.length - 1)]!
      return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
    }),
  )
  return calls
}

const SUMMARY = { oneLine: 'The order is late.', bullets: ['Shipped Monday', 'Refund offered'] }
const gemini = (text: string) => ({ json: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] } })
const chat = (content: string, finish_reason = 'stop') => ({ json: { choices: [{ finish_reason, message: { content } }] } })

let n = 0
beforeEach(() => setAiAccessPolicy(() => true))
afterEach(() => {
  setLlmConfig(null)
  vi.unstubAllGlobals()
})

describe('Gemini with your own key', () => {
  beforeEach(() =>
    setLlmConfig({ provider: 'google', apiKey: ` AIza-${++n} `, model: 'gemini-flash-latest', triageModel: 'gemini-flash-lite-latest' }),
  )

  it('asks for JSON held to the schema, from the browser with the key in a header', async () => {
    const calls = fakeFetch(gemini(JSON.stringify(SUMMARY)))
    expect(await summarizeThread(aiThread('priya'))).toMatchObject(SUMMARY)
    const [call] = calls
    expect(call!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent')
    expect(call!.headers.get('x-goog-api-key')).toBe(`AIza-${n}`)
    expect(call!.body.generationConfig).toMatchObject({ responseMimeType: 'application/json', responseJsonSchema: { type: 'object' } })
  })

  it('sorts with the triage model', async () => {
    const calls = fakeFetch(gemini('{"priority":"urgent","expectsReply":true,"reason":"Waiting on you."}'))
    expect((await classifyPriority(aiThread('priya'))).priority).toBe('urgent')
    expect(calls[0]!.url).toContain('/models/gemini-flash-lite-latest:')
  })

  it('falls back to JSON in the instructions for a model that refuses the schema', async () => {
    setLlmConfig({ provider: 'google', apiKey: 'k', model: 'gemini-old', triageModel: 'gemini-old' })
    const calls = fakeFetch({ status: 400, json: { error: { message: 'Unknown name "responseJsonSchema"' } } }, gemini('```json\n' + JSON.stringify(SUMMARY) + '\n```'))
    expect(await summarizeThread(aiThread('priya'))).toMatchObject(SUMMARY)
    expect(calls[1]!.body.generationConfig.responseJsonSchema).toBeUndefined()
    expect(calls[1]!.body.systemInstruction.parts[0].text).toContain('JSON Schema')
  })

  it('explains a bad key, a refusal and an answer of the wrong shape', async () => {
    fakeFetch({ status: 400, json: { error: { code: 400, message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } } })
    await expect(summarizeThread(aiThread('priya'))).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('Gemini rejected') })
    fakeFetch({ json: { candidates: [{ finishReason: 'SAFETY' }] } })
    await expect(summarizeThread(aiThread('priya'))).rejects.toMatchObject({ kind: 'refusal' })
    fakeFetch(gemini('{"oneLine": "x"}'))
    await expect(summarizeThread(aiThread('priya'))).rejects.toMatchObject({ kind: 'bad_output' })
  })

  it('checks a key and model without generating anything', async () => {
    const calls = fakeFetch({ json: { name: 'models/gemini-flash-latest' } })
    await testKey('google', ' AIza-check ', 'gemini-flash-latest')
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest')
    expect(calls[0]!.headers.get('x-goog-api-key')).toBe('AIza-check')
    fakeFetch({ status: 404, json: { error: { message: 'not found' } } })
    await expect(testKey('google', 'k', 'gemini-nope')).rejects.toMatchObject({ kind: 'model' })
  })
})

describe('OpenAI-compatible services with your own key', () => {
  it('calls OpenAI with structured output', async () => {
    setLlmConfig({ provider: 'openai', apiKey: 'sk-1', model: 'gpt-5-mini', triageModel: 'gpt-5-nano' })
    const calls = fakeFetch(chat(JSON.stringify(SUMMARY)))
    expect(await summarizeThread(aiThread('priya'))).toMatchObject(SUMMARY)
    const [call] = calls
    expect(call!.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(call!.headers.get('authorization')).toBe('Bearer sk-1')
    expect(call!.body).toMatchObject({ model: 'gpt-5-mini', response_format: { type: 'json_schema', json_schema: { name: 'summary', strict: true } } })
    expect(call!.body.messages[0].role).toBe('system')
  })

  it('steps down to plain JSON for a service without structured output, and remembers', async () => {
    setLlmConfig({ provider: 'custom', apiKey: 'k', model: 'local-model', triageModel: 'local-model', baseUrl: 'https://llm.example.com/v1/' })
    const calls = fakeFetch(
      { status: 400, json: { error: { message: 'response_format json_schema is not supported' } } },
      // A sentence around the object is fine: the object is what counts.
      chat('Here you go: ' + JSON.stringify(SUMMARY) + ' Hope that helps!'),
      chat('Sorry, I cannot summarise this.'),
    )
    expect(await summarizeThread(aiThread('priya'))).toMatchObject(SUMMARY)
    expect(calls.map((c) => c.body.response_format?.type)).toEqual(['json_schema', 'json_object'])
    expect(calls[0]!.url).toBe('https://llm.example.com/v1/chat/completions')

    // Remembered; and an answer with no object in it is explained, not shown.
    await expect(summarizeThread(aiThread('priya'))).rejects.toMatchObject({ kind: 'bad_output', message: expect.stringContaining('Your AI service') })
    expect(calls.at(-1)!.body.response_format.type).toBe('json_object')
  })

  it('reports a cut-off answer and a rejected key', async () => {
    setLlmConfig({ provider: 'groq', apiKey: 'gsk', model: 'llama', triageModel: 'llama' })
    fakeFetch(chat('{"oneLine":', 'length'))
    await expect(summarizeThread(aiThread('priya'))).rejects.toMatchObject({ kind: 'bad_output', message: expect.stringContaining('ran out of room') })
    fakeFetch({ status: 401, json: { error: { message: 'Invalid API Key' } } })
    await expect(summarizeThread(aiThread('priya'))).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('Groq rejected') })
  })

  it('checks keys against the model list, and OpenRouter keys at its own address', async () => {
    const calls = fakeFetch({ json: { data: [{ id: 'gpt-5-mini' }] } })
    await testKey('openai', 'sk', 'gpt-5-mini')
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/models')
    await expect(testKey('openai', 'sk', 'gpt-typo')).rejects.toMatchObject({ kind: 'model' })

    const openRouter = fakeFetch({ json: { data: { label: 'key' } } })
    await testKey('openrouter', 'sk-or', 'openrouter/auto')
    expect(openRouter[0]!.url).toBe('https://openrouter.ai/api/v1/key')
  })

  it('says when a service refuses requests from a browser', async () => {
    setLlmConfig({ provider: 'mistral', apiKey: 'k', model: 'm', triageModel: 'm' })
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(summarizeThread(aiThread('priya'))).rejects.toMatchObject({ kind: 'network', message: expect.stringContaining('Mistral') })
  })
})

describe('the shared AI', () => {
  beforeEach(() => setLlmConfig({ provider: 'shared' }))

  it("goes through this app's server, without any key in the browser", async () => {
    const calls = fakeFetch({ json: { output: SUMMARY } })
    expect(await summarizeThread(aiThread('priya'))).toMatchObject(SUMMARY)
    expect(calls[0]!.url).toBe('/api/ai/generate')
    expect(calls[0]!.body).toMatchObject({ task: 'summary', effort: expect.any(String) })
    expect(calls[0]!.headers.get('authorization')).toBeNull()
  })

  it("passes on the server's explanation", async () => {
    fakeFetch({ status: 429, json: { kind: 'rate_limit', error: 'The shared AI is busy.' } })
    const error = await summarizeThread(aiThread('priya')).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ kind: 'rate_limit', message: 'The shared AI is busy.' })
    fakeFetch({ status: 401, json: { error: 'Sign in to continue.' } })
    await expect(summarizeThread(aiThread('priya'))).rejects.toMatchObject({ kind: 'auth' })
  })
})
