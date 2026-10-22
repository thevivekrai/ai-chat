import { assertAiCanRead } from './access'
import { simulateLatency } from './latency'
import { generate, llmConfigured, type LlmOutputs } from './llm'
import { cannedDraft } from './mock/canned'
import { heuristicDraft } from './mock/heuristics'
import { buildDraftsPrompt } from './prompts'
import type { AiThread, DraftReply, Tone } from './types'

/** In-flight Claude requests: the three tones of one chat share a single call. */
const pending = new Map<string, Promise<LlmOutputs['drafts']>>()

/**
 * Drafts a reply in the given tone. Drafts only ever fill the composer; sending is always a
 * separate, explicit action by the user.
 *
 * `variant` asks for a different wording of the same tone ("Regenerate").
 */
export async function draftReply(thread: AiThread, tone: Tone, variant = 0): Promise<DraftReply> {
  assertAiCanRead(thread.id)

  if (llmConfigured()) {
    const key = `${thread.id}|${thread.messages.at(-1)?.id ?? ''}|${variant}`
    let drafts = pending.get(key)
    if (!drafts) {
      drafts = generate(buildDraftsPrompt(thread, variant))
      pending.set(key, drafts)
      const forget = () => pending.delete(key)
      drafts.then(forget, forget)
    }
    return { tone, text: (await drafts)[tone].trim() }
  }

  await simulateLatency('draft')
  const text = cannedDraft(thread, tone, variant, Date.now()) ?? heuristicDraft(thread, tone, variant)
  return { tone, text }
}
