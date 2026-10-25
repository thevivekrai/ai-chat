import { Router } from 'express'
import { runGemini } from '../src/ai/gemini.ts'
import { runOpenAi } from '../src/ai/openai.ts'
import { LlmError, type LlmRequest } from '../src/ai/llm.ts'
import { LLM_TASKS } from '../src/ai/schemas.ts'
import type { SessionTokens } from './auth/tokens.ts'
import type { Collections } from './db.ts'
import type { SharedAiProvider } from './config.ts'
import { HttpError, requireUser, userIdOf } from './http.ts'

/**
 * The shared AI: signed-in users' AI requests, answered with the server's own key (AI_API): by
 * free models on OpenRouter, or by Google's Gemini. Nobody needs a key of their own. The key never
 * leaves the server, and requests are passed on as they come, not stored or logged.
 */
export interface SharedAi {
  provider: SharedAiProvider
  apiKey: string
  /** Drafts, summaries, tasks and answers. */
  model: string
  /** Sorting the queue, which runs often: a lighter model with higher free limits. */
  triageModel: string
  /** Tests stand in for the provider's API. */
  fetch?: typeof fetch
}

/** Who answers, as the app tells its users. */
export const SHARED_AI_BY: Record<SharedAiProvider, string> = {
  openrouter: 'free AI models on OpenRouter',
  gemini: "Google's Gemini",
}

/** Per user: enough for normal use, while a free key's limits are shared by everyone. */
const PER_MINUTE = 30
const PER_DAY = 1500
/** Requests to the provider at once, across all users; the rest wait their turn. */
const AT_ONCE = 4
const MAX_WAITING = 200
const MAX_PROMPT_CHARS = 400_000

/** If a configured model isn't available to the key, these are tried in turn (free ones only). */
const FALLBACK_MODELS: Record<SharedAiProvider, string[]> = {
  openrouter: ['openrouter/free'],
  gemini: ['gemini-flash-latest', 'gemini-2.5-flash'],
}

function ask(ai: SharedAi, model: string, request: LlmRequest) {
  const name = 'The shared AI'
  if (ai.provider === 'gemini') return runGemini({ apiKey: ai.apiKey, model, fetch: ai.fetch, name }, request)
  return runOpenAi(
    {
      apiKey: ai.apiKey,
      model,
      baseUrl: 'https://openrouter.ai/api/v1',
      name,
      fetch: ai.fetch,
      // How OpenRouter names the app in its dashboard.
      headers: { 'X-Title': 'Sytext' },
    },
    request,
  )
}

export function aiRoutes({ col, tokens, ai }: { col: Collections; tokens: SessionTokens; ai: SharedAi | null }): Router {
  const router = Router()
  if (!ai) return router
  const signedIn = requireUser(tokens, col.users)
  const used = new Map<string, number[]>()
  const slots = semaphore(AT_ONCE, MAX_WAITING)
  // The first model of each list that worked, so a missing one is only tried once.
  const working = new Map<string, string>()

  router.post('/ai/generate', signedIn, async (req, res) => {
    const request = readRequest(req.body)
    const user = userIdOf(res).toHexString()
    const now = Date.now()
    const times = (used.get(user) ?? []).filter((t) => t > now - 86_400_000)
    if (times.filter((t) => t > now - 60_000).length >= PER_MINUTE || times.length >= PER_DAY) {
      res.setHeader('Retry-After', 60)
      res.status(429).json({ kind: 'rate_limit', error: 'You have used the shared AI a lot just now. Try again in a minute.' })
      return
    }
    times.push(now)
    used.set(user, times)

    const first = request.task === 'priority' ? ai.triageModel : ai.model
    const models = [...new Set([working.get(first) ?? first, first, ai.model, ...FALLBACK_MODELS[ai.provider]])]
    try {
      const output = await slots(async () => {
        for (const [i, model] of models.entries()) {
          try {
            const result = await ask(ai, model, request)
            working.set(first, model)
            return result
          } catch (error) {
            if (!(error instanceof LlmError && error.kind === 'model') || i === models.length - 1) throw error
          }
        }
        throw new LlmError('model', 'No model answered.')
      })
      res.json({ output })
    } catch (error) {
      const { status, kind, message } = sharedError(error)
      res.status(status).json({ kind, error: message })
    }
  })

  // Old prompts and everyone's counts don't need to be kept for long.
  setInterval(() => {
    const cutoff = Date.now() - 86_400_000
    for (const [user, times] of used) {
      const recent = times.filter((t) => t > cutoff)
      if (recent.length) used.set(user, recent)
      else used.delete(user)
    }
  }, 600_000).unref()

  return router
}

function readRequest(body: unknown): LlmRequest {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.task !== 'string' || !(LLM_TASKS as string[]).includes(b.task)) throw new HttpError(400, 'Unknown AI task.')
  if (typeof b.system !== 'string' || typeof b.user !== 'string' || !b.user.trim()) throw new HttpError(400, 'Missing prompt.')
  if (b.system.length + b.user.length > MAX_PROMPT_CHARS) throw new HttpError(413, 'This chat is too long for the shared AI.')
  const effort = b.effort === 'low' || b.effort === 'medium' || b.effort === 'high' ? b.effort : 'medium'
  return { task: b.task as LlmRequest['task'], system: b.system, user: b.user, effort }
}

/** What the user is told. A problem with the server's own key is the server's, not theirs. */
function sharedError(error: unknown): { status: number; kind: string; message: string } {
  if (error instanceof LlmError) {
    switch (error.kind) {
      case 'auth':
      case 'permission':
      case 'model':
        console.error(`[ai] the shared AI can't run: ${error.kind}`)
        return {
          status: 503,
          kind: 'permission',
          message: "The shared AI isn't available right now. You can use your own API key in Settings → AI.",
        }
      case 'rate_limit':
        return {
          status: 429,
          kind: 'rate_limit',
          message: 'The shared AI is busy (its free limit was reached). Try again in a minute, or use your own key.',
        }
      case 'network':
      case 'overloaded':
        return { status: 503, kind: 'overloaded', message: 'The shared AI is busy right now. Try again shortly.' }
      default:
        return { status: 502, kind: error.kind, message: error.message }
    }
  }
  if (error instanceof Error && error.message === 'busy') {
    return { status: 503, kind: 'overloaded', message: 'The shared AI is busy right now. Try again shortly.' }
  }
  console.error('[ai] shared AI request failed', error)
  return { status: 500, kind: 'overloaded', message: 'Something went wrong with the shared AI. Try again.' }
}

/** Runs at most `max` jobs at once; others wait, up to `maxWaiting` of them. */
function semaphore(max: number, maxWaiting: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      if (waiting.length >= maxWaiting) throw new Error('busy')
      await new Promise<void>((resolve) => waiting.push(resolve))
    } else active++
    try {
      return await job()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}
