/**
 * The one place a language model gets called.
 *
 * Every AI function sends its prompt through `generate()` to the engine chosen in Settings → AI:
 * the app's shared AI (Gemini, through this app's server), or a provider the user brought their
 * own key for (Claude, Gemini, OpenAI or any OpenAI-compatible service). With neither, the
 * functions fall back to the built-in demo AI in ./mock, which knows the demo chats and uses simple
 * rules for everything else.
 *
 * Each provider's code is only downloaded once it is chosen.
 */
import type { ExtractedTask, PriorityCall, SearchAnswer, ThreadSummary, Tone } from './types'
import { keyProvider, type KeyProviderId } from './providers'

export type LlmConfig =
  | { provider: 'shared' }
  | {
      provider: KeyProviderId
      apiKey: string
      /** Drafts, summaries, tasks and answers. */
      model: string
      /** Sorting the queue, which runs for every allowed chat whenever it changes. */
      triageModel: string
      /** For "Other (OpenAI-compatible)": the service's address. */
      baseUrl?: string
    }

/** What each kind of request returns (see ./schemas). */
export interface LlmOutputs {
  priority: PriorityCall
  summary: ThreadSummary
  tasks: { tasks: Omit<ExtractedTask, 'id'>[] }
  drafts: Record<Tone, string>
  answer: SearchAnswer
  translate: { text: string; from: string }
}

export type LlmTask = keyof LlmOutputs

export interface LlmRequest<K extends LlmTask = LlmTask> {
  task: K
  system: string
  user: string
  /** How hard the model thinks before answering. */
  effort: 'low' | 'medium' | 'high'
}

export type LlmErrorKind =
  | 'auth'
  | 'permission'
  | 'model'
  | 'rate_limit'
  | 'overloaded'
  | 'network'
  | 'bad_request'
  | 'refusal'
  | 'bad_output'

export class LlmError extends Error {
  readonly kind: LlmErrorKind

  constructor(kind: LlmErrorKind, message: string) {
    super(message)
    this.name = 'LlmError'
    this.kind = kind
  }
}

let config: LlmConfig | null = null

/** Set whenever the chosen engine, key or model changes; null means the built-in demo AI. */
export function setLlmConfig(next: LlmConfig | null) {
  config = next?.provider === 'shared' || next?.apiKey.trim() ? withTrimmedKey(next) : null
}

const withTrimmedKey = (next: LlmConfig): LlmConfig => (next.provider === 'shared' ? next : { ...next, apiKey: next.apiKey.trim() })

/** Which model answers a task, for the record kept with each tagging run ("demo": the built-in AI). */
export function modelFor(task: LlmTask): string {
  if (!config) return 'demo'
  if (config.provider === 'shared') return 'shared'
  return `${config.provider}:${task === 'priority' ? config.triageModel || config.model : config.model}`
}

/** Whether AI functions call a real model (true) or use the built-in demo AI (false). */
export function llmConfigured(): boolean {
  return config !== null
}

export async function generate<K extends LlmTask>(request: LlmRequest<K>): Promise<LlmOutputs[K]> {
  const current = config
  if (!current) throw new LlmError('auth', 'Choose an AI in Settings → AI.')
  // Typing in the chat or opening it beats re-sorting the whole queue in the background.
  const lane = request.task === 'priority' ? 'background' : 'interactive'
  return limiter.run(lane, async () => {
    if (current.provider === 'shared') {
      const { runShared } = await import('./shared')
      return runShared(request)
    }
    const model = request.task === 'priority' ? current.triageModel || current.model : current.model
    const provider = keyProvider(current.provider)
    if (current.provider === 'anthropic') {
      const { runClaude } = await import('./claude')
      return runClaude({ apiKey: current.apiKey, model }, request)
    }
    if (current.provider === 'google') {
      const { runGemini } = await import('./gemini')
      return runGemini({ apiKey: current.apiKey, model }, request)
    }
    const { runOpenAi } = await import('./openai')
    return runOpenAi({ apiKey: current.apiKey, model, baseUrl: current.baseUrl || provider.baseUrl || '', name: provider.name }, request)
  })
}

/** Checks a key and model without generating anything. */
export async function testKey(provider: KeyProviderId, apiKey: string, model: string, baseUrl?: string): Promise<void> {
  const key = apiKey.trim()
  const { name } = keyProvider(provider)
  if (provider === 'anthropic') {
    const { checkClaudeKey } = await import('./claude')
    return checkClaudeKey(key, model)
  }
  if (provider === 'google') {
    const { checkGeminiKey } = await import('./gemini')
    return checkGeminiKey({ apiKey: key, model })
  }
  const { checkOpenAiKey } = await import('./openai')
  return checkOpenAiKey({
    apiKey: key,
    model,
    name,
    baseUrl: baseUrl || keyProvider(provider).baseUrl || '',
    keyPath: provider === 'openrouter' ? '/key' : undefined,
  })
}

/**
 * Turning AI on for many chats queues a sort for each of them. Running a few at a time keeps
 * personal-tier rate limits happy, and interactive requests skip ahead of background ones.
 */
class Limiter {
  private active = 0
  private readonly queues = { interactive: [] as (() => void)[], background: [] as (() => void)[] }
  private readonly max: number

  constructor(max: number) {
    this.max = max
  }

  async run<T>(lane: 'interactive' | 'background', job: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queues[lane].push(resolve))
    else this.active++
    try {
      return await job()
    } finally {
      // Hand the slot straight to the next job, or release it.
      const next = this.queues.interactive.shift() ?? this.queues.background.shift()
      if (next) next()
      else this.active--
    }
  }
}

const limiter = new Limiter(3)
