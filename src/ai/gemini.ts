/**
 * Google Gemini, through its REST API: from the browser with the user's own key, and from the
 * server for the shared AI (server/ai.ts). Answers are JSON held to the task's schema.
 */
import { getJson, postJson } from './http'
import { LlmError, type LlmOutputs, type LlmRequest, type LlmTask } from './llm'
import { jsonSchemaOf, parseOutput, withSchemaInstructions } from './schemas'

const API = 'https://generativelanguage.googleapis.com/v1beta'

export interface GeminiOptions {
  apiKey: string
  model: string
  fetch?: typeof fetch
  /** The name used in messages. */
  name?: string
}

interface GeminiResponse {
  promptFeedback?: { blockReason?: string }
  candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[]
}

/** Models that don't take a JSON Schema yet are asked for JSON in the instructions instead. */
const schemaRefused = new Set<string>()

export async function runGemini<K extends LlmTask>(options: GeminiOptions, request: LlmRequest<K>): Promise<LlmOutputs[K]> {
  const name = options.name ?? 'Gemini'
  const url = `${API}/models/${encodeURIComponent(options.model)}:generateContent`
  const headers = { 'x-goog-api-key': options.apiKey }
  const body = (withSchema: boolean) => ({
    systemInstruction: { parts: [{ text: withSchema ? request.system : withSchemaInstructions(request.system, request.task) }] },
    contents: [{ role: 'user', parts: [{ text: request.user }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      ...(withSchema ? { responseJsonSchema: jsonSchemaOf(request.task) } : {}),
    },
  })

  let data: GeminiResponse
  const withSchema = !schemaRefused.has(options.model)
  try {
    data = (await postJson(url, headers, body(withSchema), name, options.fetch)) as GeminiResponse
  } catch (error) {
    if (!(withSchema && error instanceof LlmError && error.kind === 'bad_request')) throw error
    schemaRefused.add(options.model)
    data = (await postJson(url, headers, body(false), name, options.fetch)) as GeminiResponse
  }

  if (data.promptFeedback?.blockReason) throw new LlmError('refusal', `${name} declined to help with this chat.`)
  const candidate = data.candidates?.[0]
  const finish = candidate?.finishReason
  if (finish && ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'].includes(finish)) {
    throw new LlmError('refusal', `${name} declined to help with this chat.`)
  }
  if (finish === 'MAX_TOKENS') throw new LlmError('bad_output', `${name} ran out of room before finishing. Try again.`)
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
  return parseOutput(request.task, text, name)
}

/** Checks a key and model without generating anything. */
export async function checkGeminiKey(options: GeminiOptions): Promise<void> {
  await getJson(
    `${API}/models/${encodeURIComponent(options.model)}`,
    { 'x-goog-api-key': options.apiKey },
    options.name ?? 'Gemini',
    options.fetch,
  )
}
