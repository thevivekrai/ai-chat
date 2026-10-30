import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, startTestServer, TEST_MONGODB_URI, type TestServer } from './testing/helpers.ts'

/** A stand-in for Google's Gemini API: records each call and answers with `respond`. */
function fakeGemini() {
  const calls: { url: string; key: string | null; body: any }[] = []
  let respond: (url: string, body: any) => { status: number; json: unknown } = () => ({
    status: 200,
    json: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(SUMMARY) }] } }] },
  })
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ url: String(url), key: new Headers(init?.headers).get('x-goog-api-key'), body })
    const { status, json } = respond(String(url), body)
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { calls, fetch, answer: (next: typeof respond) => (respond = next) }
}

const SUMMARY = { oneLine: 'Dinner moved to Friday.', bullets: ['Friday at 8', 'Asha books the table'] }
const REQUEST = { task: 'summary', system: 'Summarize.', user: 'Chat text', effort: 'low' }

describe.skipIf(!TEST_MONGODB_URI)('shared AI', () => {
  let server: TestServer
  const gemini = fakeGemini()

  beforeAll(async () => {
    server = await startTestServer({
      ai: { provider: 'gemini', apiKey: 'server-key', model: 'gemini-main', triageModel: 'gemini-light', fetch: gemini.fetch },
    })
  })
  afterAll(() => server?.close())

  const signedIn = async (email: string) => {
    const browser = new Browser(server.url)
    expect((await browser.post('/api/auth/register', { name: 'Ai', email, password: 'long enough', acceptedTerms: true })).status).toBe(200)
    return browser
  }

  it('is offered, to signed-in users only', async () => {
    const visitor = new Browser(server.url)
    expect((await visitor.get('/api/config')).json.ai).toBe(true)
    expect((await visitor.post('/api/ai/generate', REQUEST)).status).toBe(401)
  })

  it("answers with Gemini and the server's key, held to the task's schema", async () => {
    const browser = await signedIn('ai-shared@example.com')
    gemini.calls.length = 0
    const res = await browser.post('/api/ai/generate', REQUEST)
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ output: SUMMARY })
    const [call] = gemini.calls
    expect(call!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-main:generateContent')
    expect(call!.key).toBe('server-key')
    expect(call!.body.systemInstruction.parts[0].text).toBe('Summarize.')
    expect(call!.body.contents[0].parts[0].text).toBe('Chat text')
    expect(call!.body.generationConfig.responseMimeType).toBe('application/json')
    expect(call!.body.generationConfig.responseJsonSchema.required).toEqual(['oneLine', 'bullets'])
    // The key never reaches the browser.
    expect(res.text).not.toContain('server-key')

    // Sorting uses the lighter model.
    gemini.answer(() => ({
      status: 200,
      json: { candidates: [{ content: { parts: [{ text: '{"priority":"low","expectsReply":false,"reason":"FYI only."}' }] } }] },
    }))
    const sorted = await browser.post('/api/ai/generate', { ...REQUEST, task: 'priority' })
    expect(sorted.json.output).toEqual({ priority: 'low', expectsReply: false, reason: 'FYI only.', labels: [] })
    expect(gemini.calls.at(-1)!.url).toContain('/models/gemini-light:generateContent')
  })

  it('moves on to another model when one is not available, and remembers it', async () => {
    const browser = await signedIn('ai-fallback@example.com')
    gemini.calls.length = 0
    gemini.answer((url) =>
      url.includes('gemini-light')
        ? { status: 404, json: { error: { code: 404, message: 'models/gemini-light is not found', status: 'NOT_FOUND' } } }
        : { status: 200, json: { candidates: [{ content: { parts: [{ text: '{"priority":"urgent","expectsReply":true,"reason":"Asked twice."}' }] } }] } },
    )
    const res = await browser.post('/api/ai/generate', { ...REQUEST, task: 'priority' })
    expect(res.json.output.priority).toBe('urgent')
    expect(gemini.calls.map((c) => c.url.split('/models/')[1])).toEqual(['gemini-light:generateContent', 'gemini-main:generateContent'])

    gemini.calls.length = 0
    await browser.post('/api/ai/generate', { ...REQUEST, task: 'priority' })
    expect(gemini.calls.map((c) => c.url.split('/models/')[1])).toEqual(['gemini-main:generateContent'])
  })

  it("explains problems without blaming the user's own setup", async () => {
    const browser = await signedIn('ai-errors@example.com')
    gemini.answer(() => ({
      status: 400,
      json: { error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } },
    }))
    const badKey = await browser.post('/api/ai/generate', REQUEST)
    expect(badKey.status).toBe(503)
    expect(badKey.json).toEqual({ kind: 'permission', error: expect.stringMatching(/shared AI isn't available.*your own API key/) })

    gemini.answer(() => ({ status: 429, json: { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } } }))
    const limited = await browser.post('/api/ai/generate', REQUEST)
    expect(limited.status).toBe(429)
    expect(limited.json.kind).toBe('rate_limit')

    gemini.answer(() => ({ status: 200, json: { candidates: [{ content: { parts: [{ text: '{"oneLine": 3}' }] } }] } }))
    const garbled = await browser.post('/api/ai/generate', REQUEST)
    expect(garbled.status).toBe(502)
    expect(garbled.json.kind).toBe('bad_output')

    gemini.answer(() => ({ status: 200, json: { promptFeedback: { blockReason: 'SAFETY' } } }))
    expect((await browser.post('/api/ai/generate', REQUEST)).json.kind).toBe('refusal')

    expect((await browser.post('/api/ai/generate', { ...REQUEST, task: 'hack' })).status).toBe(400)
    expect((await browser.post('/api/ai/generate', { ...REQUEST, user: 'x'.repeat(400_001) })).status).toBe(413)
  })

  it('limits how much one user can use it', async () => {
    const browser = await signedIn('ai-busy@example.com')
    gemini.answer(() => ({ status: 200, json: { candidates: [{ content: { parts: [{ text: JSON.stringify(SUMMARY) }] } }] } }))
    const statuses: number[] = []
    for (let i = 0; i < 31; i++) statuses.push((await browser.post('/api/ai/generate', REQUEST)).status)
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true)
    expect(statuses[30]).toBe(429)
    // Others aren't affected.
    expect((await (await signedIn('ai-other@example.com')).post('/api/ai/generate', REQUEST)).status).toBe(200)
  })
})

describe.skipIf(!TEST_MONGODB_URI)('without AI_API', () => {
  it('offers no shared AI', async () => {
    const server = await startTestServer()
    try {
      const browser = new Browser(server.url)
      expect((await browser.get('/api/config')).json.ai).toBe(false)
      expect((await browser.post('/api/ai/generate', REQUEST)).status).toBe(404)
    } finally {
      await server.close()
    }
  })
})

describe.skipIf(!TEST_MONGODB_URI)('shared AI on OpenRouter', () => {
  let server: TestServer
  const calls: { url: string; headers: Headers; body: any }[] = []
  let reply: { status: number; json: unknown } = { status: 200, json: {} }
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(JSON.stringify(reply.json), { status: reply.status, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch

  beforeAll(async () => {
    server = await startTestServer({
      ai: { provider: 'openrouter', apiKey: 'sk-or-server', model: 'openrouter/free', triageModel: 'openrouter/free', fetch },
    })
  })
  afterAll(() => server?.close())

  it("answers with free models on OpenRouter and the server's key", async () => {
    const browser = new Browser(server.url)
    expect((await browser.post('/api/auth/register', { name: 'Or', email: 'ai-or@example.com', password: 'long enough', acceptedTerms: true })).status).toBe(200)
    expect((await browser.get('/api/config')).json).toMatchObject({ ai: true, aiBy: 'free AI models on OpenRouter' })

    reply = { status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(SUMMARY) } }] } }
    const res = await browser.post('/api/ai/generate', REQUEST)
    expect(res.json).toEqual({ output: SUMMARY })
    const [call] = calls
    expect(call!.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(call!.headers.get('authorization')).toBe('Bearer sk-or-server')
    expect(call!.headers.get('x-title')).toBe('Sytext')
    expect(call!.body).toMatchObject({ model: 'openrouter/free', response_format: { type: 'json_schema', json_schema: { name: 'summary' } } })
    expect(res.text).not.toContain('sk-or-server')

    // A free model's own quota, and a bad key, are explained as the shared AI's.
    reply = { status: 429, json: { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } } }
    expect((await browser.post('/api/ai/generate', REQUEST)).json.kind).toBe('rate_limit')
    reply = { status: 401, json: { error: { code: 401, message: 'No auth credentials found' } } }
    expect((await browser.post('/api/ai/generate', REQUEST)).json).toMatchObject({ kind: 'permission' })
  })
})
