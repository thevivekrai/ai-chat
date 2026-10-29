/**
 * The shape of every AI result, shared by all providers (and by the server's shared AI). Providers
 * that support structured output are held to these schemas; every answer is checked against them.
 */
import { z } from 'zod'
import { LlmError, type LlmOutputs, type LlmTask } from './llm'
import { CHAT_LABELS } from './types'

const PrioritySchema = z.object({
  priority: z.enum(['urgent', 'normal', 'low']),
  expectsReply: z.boolean().describe('Whether the latest messages expect a reply from the user.'),
  reason: z.string().describe('One plain sentence, under 90 characters.'),
  /**
   * Tags, each with how sure the model is and why. Anything made up, malformed or unsure is
   * dropped here rather than failing the whole answer; a model that answers with plain strings
   * (an older or smaller one) is read as "sure, no reason given".
   */
  labels: z
    .preprocess(
      (v) =>
        (Array.isArray(v) ? v : [])
          .map((l) => (typeof l === 'string' ? { tag: l, confidence: 1 } : l))
          .filter((l): l is { tag: string; confidence?: unknown; why?: unknown } => !!l && typeof l === 'object' && 'tag' in l)
          .filter((l) => (CHAT_LABELS as readonly unknown[]).includes(l.tag))
          .map((l) => ({
            tag: l.tag,
            confidence: typeof l.confidence === 'number' && l.confidence >= 0 && l.confidence <= 1 ? l.confidence : 0,
            ...(typeof l.why === 'string' && l.why.trim() ? { why: l.why.trim().slice(0, 80) } : {}),
          })),
      z.array(z.object({ tag: z.enum(CHAT_LABELS), confidence: z.number().min(0).max(1), why: z.string().optional() })),
    )
    .describe('Tags that clearly apply, each with a confidence from 0 to 1 and a few words on why. Empty when none does.'),
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

export const SCHEMAS: { [K in LlmTask]: z.ZodType<LlmOutputs[K]> } = {
  priority: PrioritySchema,
  summary: SummarySchema,
  tasks: TasksSchema,
  drafts: DraftsSchema,
  answer: AnswerSchema,
}

export const LLM_TASKS = Object.keys(SCHEMAS) as LlmTask[]

/** The result's JSON Schema, for providers that take one. */
export function jsonSchemaOf(task: LlmTask): Record<string, unknown> {
  const { $schema: _, ...schema } = z.toJSONSchema(SCHEMAS[task]) as Record<string, unknown>
  return schema
}

/** For providers without structured output: the schema, spelled out in the instructions. */
export function withSchemaInstructions(system: string, task: LlmTask): string {
  return `${system}\n\nAnswer with one JSON object only, no other text, matching this JSON Schema:\n${JSON.stringify(jsonSchemaOf(task))}`
}

/** Reads a model's JSON answer (with or without a ```json fence) and checks its shape. */
export function parseOutput<K extends LlmTask>(task: K, text: string, provider: string): LlmOutputs[K] {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    // Some models put a sentence before or after the object: the object is what counts.
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    try {
      if (start === -1 || end <= start) throw new Error('No object')
      value = JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      throw new LlmError('bad_output', `${provider}'s answer couldn't be read. Try again.`)
    }
  }
  const parsed = (SCHEMAS[task] as z.ZodType<LlmOutputs[K]>).safeParse(value)
  if (!parsed.success) throw new LlmError('bad_output', `${provider}'s answer was missing something. Try again.`)
  return parsed.data
}
