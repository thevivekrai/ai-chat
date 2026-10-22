/**
 * The one place a language model gets called.
 *
 * With a Claude API key configured (Settings → AI), every AI function sends its prompt to Claude
 * through `generate()`. Without one, the functions fall back to the built-in demo AI in ./mock,
 * which knows the demo chats and uses simple rules for everything else.
 *
 * The Claude client itself lives in ./claude.ts and is only downloaded once a key is set.
 */
import type { ExtractedTask, PriorityResult, SearchAnswer, ThreadSummary, Tone } from './types'

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', note: 'Most capable' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', note: 'Balanced' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', note: 'Fastest' },
] as const

export type ClaudeModel = (typeof CLAUDE_MODELS)[number]['id']

export interface LlmConfig {
  apiKey: string
  /** Drafts, summaries, tasks and answers. */
  model: ClaudeModel
  /** Sorting the queue, which runs for every allowed chat whenever it changes. */
  triageModel: ClaudeModel
}

/** What each kind of request returns. Claude is held to these shapes by structured outputs. */
export interface LlmOutputs {
  priority: PriorityResult
  summary: ThreadSummary
  tasks: { tasks: Omit<ExtractedTask, 'id'>[] }
  drafts: Record<Tone, string>
  answer: SearchAnswer
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

/** Set by the settings store whenever the key or model choice changes. */
export function setLlmConfig(next: LlmConfig | null) {
  config = next?.apiKey.trim() ? { ...next, apiKey: next.apiKey.trim() } : null
}

/** Whether AI functions should call Claude (true) or use the built-in demo AI (false). */
export function llmConfigured(): boolean {
  return config !== null
}

export async function generate<K extends LlmTask>(request: LlmRequest<K>): Promise<LlmOutputs[K]> {
  const current = config
  if (!current) throw new LlmError('auth', 'Add a Claude API key in Settings → AI to use Claude.')
  const model = request.task === 'priority' ? current.triageModel : current.model
  // Typing in the chat or opening it beats re-sorting the whole queue in the background.
  const lane = request.task === 'priority' ? 'background' : 'interactive'
  return limiter.run(lane, async () => {
    const { runClaude } = await import('./claude')
    return runClaude({ apiKey: current.apiKey, model }, request)
  })
}

/** Checks a key and model with one cheap call that generates nothing. */
export async function testClaudeKey(apiKey: string, model: ClaudeModel): Promise<void> {
  const { checkClaudeKey } = await import('./claude')
  await checkClaudeKey(apiKey.trim(), model)
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
