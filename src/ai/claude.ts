/**
 * Claude, called straight from the browser with the user's own API key (Settings → AI).
 * Loaded on demand by llm.ts, so the SDK is only downloaded once a key is configured.
 *
 * Every request asks for structured output, so results arrive already parsed and shaped like the
 * mock ones. Server-side fallbacks are on: if the chosen model declines a request on policy
 * grounds, the API retries it on a fallback model within the same call.
 */
import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import { LlmError, type ClaudeModel, type LlmOutputs, type LlmRequest, type LlmTask } from './llm'

const PrioritySchema = z.object({
  priority: z.enum(['urgent', 'normal', 'low']),
  expectsReply: z.boolean().describe('Whether the latest messages expect a reply from the user.'),
  reason: z.string().describe('One plain sentence, under 90 characters.'),
})

const SummarySchema = z.object({
  oneLine: z.string().describe('A single sentence under 160 characters.'),
  bullets: z.array(z.string()).describe('3 to 5 key points: decisions, open questions, anything asked of the user.'),
})

const TasksSchema = z.object({
  tasks: z.array(
    z.object({
      title: z.string().describe('Short imperative, without the date.'),
      dueAt: z.string().nullable().describe('ISO 8601 with offset, or null when no date was mentioned.'),
      dueText: z.string().nullable().describe('The exact date words from the message, or null.'),
      sourceMessageId: z.string().describe('Id of the message the task comes from, as written in [brackets].'),
    }),
  ),
})

const DraftsSchema = z.object({
  short: z.string(),
  friendly: z.string(),
  professional: z.string(),
})

const AnswerSchema = z.object({
  answer: z.string().describe('Two or three sentences; key figures and dates in **bold**.'),
  citedMessageIds: z.array(z.string()).describe('Ids of the messages the answer relies on.'),
})

const SCHEMAS: { [K in LlmTask]: z.ZodType<LlmOutputs[K]> } = {
  priority: PrioritySchema,
  summary: SummarySchema,
  tasks: TasksSchema,
  drafts: DraftsSchema,
  answer: AnswerSchema,
}

let cached: { apiKey: string; client: Anthropic } | null = null

function clientFor(apiKey: string): Anthropic {
  if (cached?.apiKey !== apiKey) {
    // The key belongs to the user and is used only from their own browser; see Settings → AI.
    cached = { apiKey, client: new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 }) }
  }
  return cached.client
}

export async function runClaude<K extends LlmTask>(
  { apiKey, model }: { apiKey: string; model: ClaudeModel },
  request: LlmRequest<K>,
): Promise<LlmOutputs[K]> {
  const schema = SCHEMAS[request.task] as z.ZodType<LlmOutputs[K]>
  let response
  try {
    response = await clientFor(apiKey).beta.messages.parse({
      model,
      max_tokens: 16000,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
      output_config: { effort: request.effort, format: betaZodOutputFormat(schema) },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    })
  } catch (error) {
    throw toLlmError(error)
  }

  if (response.stop_reason === 'refusal') {
    throw new LlmError('refusal', 'Claude declined to help with this chat.')
  }
  if (response.stop_reason === 'max_tokens') {
    throw new LlmError('bad_output', 'Claude ran out of room before finishing. Try again.')
  }
  if (response.parsed_output == null) {
    throw new LlmError('bad_output', "Claude's answer couldn't be read. Try again.")
  }
  return response.parsed_output
}

export async function checkClaudeKey(apiKey: string, model: ClaudeModel): Promise<void> {
  try {
    await clientFor(apiKey).models.retrieve(model)
  } catch (error) {
    throw toLlmError(error)
  }
}

function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof AuthenticationError) {
    return new LlmError('auth', 'Claude rejected this API key. Check it in Settings → AI.')
  }
  if (error instanceof PermissionDeniedError) {
    return new LlmError('permission', `This API key can't use that model. ${apiMessage(error)}`.trim())
  }
  if (error instanceof NotFoundError) {
    return new LlmError('model', 'That model is not available to this API key. Pick another one in Settings → AI.')
  }
  if (error instanceof RateLimitError) {
    return new LlmError('rate_limit', 'Claude is rate-limiting this API key. Try again in a minute.')
  }
  if (error instanceof BadRequestError) {
    return new LlmError('bad_request', apiMessage(error) || 'Claude could not process this request.')
  }
  if (error instanceof APIConnectionError) {
    return new LlmError('network', "Couldn't reach Claude. Check your connection and try again.")
  }
  if (error instanceof APIError) {
    return new LlmError('overloaded', 'Claude is busy right now. Try again shortly.')
  }
  return new LlmError('bad_output', error instanceof Error ? error.message : 'Something went wrong calling Claude.')
}

/** The API's own explanation, e.g. "credit balance is too low". */
function apiMessage(error: APIError): string {
  const body = error.error as { error?: { message?: unknown } } | undefined
  return typeof body?.error?.message === 'string' ? body.error.message : ''
}
