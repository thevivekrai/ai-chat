/**
 * OpenAI and every service with an OpenAI-compatible chat API (OpenRouter, Groq, Mistral,
 * DeepSeek, xAI, or one the user names), called from the browser with the user's own key.
 *
 * The schema is spelled out in the instructions, since some services ignore what they don't
 * support. Structured output is asked for first; a service that refuses it is asked for plain JSON,
 * and failing that for nothing more. Every answer is checked against the schema.
 */
import { getJson, postJson } from './http'
import { LlmError, type LlmOutputs, type LlmRequest, type LlmTask } from './llm'
import { jsonSchemaOf, parseOutput, withSchemaInstructions } from './schemas'

export interface OpenAiOptions {
  apiKey: string
  model: string
  baseUrl: string
  /** The name used in messages. */
  name: string
}

type Mode = 'schema' | 'json' | 'plain'
const MODES: Mode[] = ['schema', 'json', 'plain']

/** The first mode each service and model accepted, so later calls skip the ones it refused. */
const accepted = new Map<string, Mode>()

interface ChatResponse {
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[]
}

export async function runOpenAi<K extends LlmTask>(options: OpenAiOptions, request: LlmRequest<K>): Promise<LlmOutputs[K]> {
  const url = `${trimSlash(options.baseUrl)}/chat/completions`
  const known = `${url} ${options.model}`
  const headers = { authorization: `Bearer ${options.apiKey}` }

  let data: ChatResponse | undefined
  for (const mode of MODES.slice(MODES.indexOf(accepted.get(known) ?? 'schema'))) {
    try {
      data = (await postJson(url, headers, body(options.model, request, mode), options.name)) as ChatResponse
      accepted.set(known, mode)
      break
    } catch (error) {
      if (mode === 'plain' || !(error instanceof LlmError && error.kind === 'bad_request')) throw error
    }
  }

  const choice = data?.choices?.[0]
  if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') {
    throw new LlmError('refusal', `${options.name} declined to help with this chat.`)
  }
  if (choice?.finish_reason === 'length') {
    throw new LlmError('bad_output', `${options.name} ran out of room before finishing. Try again.`)
  }
  return parseOutput(request.task, choice?.message?.content ?? '', options.name)
}

function body(model: string, request: LlmRequest, mode: Mode) {
  return {
    model,
    messages: [
      { role: 'system', content: withSchemaInstructions(request.system, request.task) },
      { role: 'user', content: request.user },
    ],
    ...(mode === 'schema'
      ? { response_format: { type: 'json_schema', json_schema: { name: request.task, strict: true, schema: jsonSchemaOf(request.task) } } }
      : mode === 'json'
        ? { response_format: { type: 'json_object' } }
        : {}),
  }
}

/** Checks the key, and the model where the service lists its models. */
export async function checkOpenAiKey(options: OpenAiOptions & { keyPath?: string }): Promise<void> {
  const base = trimSlash(options.baseUrl)
  const auth = { authorization: `Bearer ${options.apiKey}` }
  // OpenRouter lists models to anyone, and has its own address for checking a key.
  if (options.keyPath) {
    await getJson(`${base}${options.keyPath}`, auth, options.name)
    return
  }
  let data: unknown
  try {
    data = await getJson(`${base}/models`, auth, options.name)
  } catch (error) {
    // A service without a model list can't be checked this way; the first request will tell.
    if (error instanceof LlmError && error.kind === 'model') return
    throw error
  }
  const ids = ((data as { data?: { id?: unknown }[] }).data ?? []).map((m) => m?.id)
  if (ids.length && !ids.includes(options.model)) {
    throw new LlmError('model', `${options.name} has no model called "${options.model}" for this key.`)
  }
}

const trimSlash = (url: string) => url.trim().replace(/\/+$/, '')
