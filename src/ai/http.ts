/** Turns an AI provider's HTTP answer into an LlmError, for the providers called with fetch. */
import { LlmError } from './llm'

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  provider: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  return readJson(
    await send(provider, () =>
      fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    ),
    provider,
  )
}

export async function getJson(
  url: string,
  headers: Record<string, string>,
  provider: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  return readJson(await send(provider, () => fetchImpl(url, { headers })), provider)
}

async function send(provider: string, call: () => Promise<Response>): Promise<Response> {
  try {
    return await call()
  } catch {
    throw new LlmError(
      'network',
      `Couldn't reach ${provider}. Check your connection; some services also refuse requests from a browser.`,
    )
  }
}

async function readJson(res: Response, provider: string): Promise<unknown> {
  const data = (await res.json().catch(() => null)) as unknown
  if (res.ok) {
    if (data === null) throw new LlmError('bad_output', `${provider}'s answer couldn't be read. Try again.`)
    return data
  }
  throw httpError(res.status, data, provider)
}

export function httpError(status: number, data: unknown, provider: string): LlmError {
  const error = (data as { error?: { message?: unknown; details?: { reason?: unknown }[] } | string } | null)?.error
  const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : ''
  const reasons = typeof error === 'object' && Array.isArray(error?.details) ? error.details.map((d) => d?.reason) : []
  // Gemini answers 400 (not 401) for a bad key.
  if (status === 401 || reasons.includes('API_KEY_INVALID')) {
    return new LlmError('auth', `${provider} rejected this API key. Check it in Settings → AI.`)
  }
  if (status === 402) return new LlmError('permission', `${provider} needs credit on this account. ${message}`.trim())
  if (status === 403) return new LlmError('permission', `This API key can't do that. ${message}`.trim())
  if (status === 404) {
    return new LlmError('model', `That model is not available to this API key. Pick another one in Settings → AI.`)
  }
  if (status === 429) return new LlmError('rate_limit', `${provider} is rate-limiting this API key. Try again in a minute.`)
  if (status >= 400 && status < 500) return new LlmError('bad_request', message || `${provider} could not process this request.`)
  return new LlmError('overloaded', `${provider} is busy right now. Try again shortly.`)
}
