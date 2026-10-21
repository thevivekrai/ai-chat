/**
 * The one place a real language model gets called. Nothing uses it yet: every AI function returns
 * canned results and has a TODO(LLM) showing the call that replaces them.
 *
 * TODO(LLM): implement `complete`. Recommended shape:
 *   - POST { system, user, json } to your own backend endpoint (e.g. /api/ai/complete), which holds
 *     the provider API key and forwards to the model. Never ship provider keys to the browser.
 *   - Or call a model running on the device for a fully local setup.
 * Return the model's text output. Use `parseJson` for the functions that ask for JSON.
 */
export interface LlmRequest {
  system: string
  user: string
  /** Ask for a single JSON object as the whole response. */
  json?: boolean
  maxTokens?: number
  temperature?: number
}

export async function complete(request: LlmRequest): Promise<string> {
  void request
  throw new Error('No language model is configured. See README → "Plugging in a real LLM".')
}

/** Extracts the first JSON object from a model response (tolerates ```json fences). */
export function parseJson<T>(text: string): T {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('Model response did not contain JSON')
  return JSON.parse(text.slice(start, end + 1)) as T
}
