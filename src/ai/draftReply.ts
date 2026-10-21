import { assertAiCanRead } from './access'
import { simulateLatency } from './latency'
import { cannedDraft } from './mock/canned'
import { heuristicDraft } from './mock/heuristics'
import type { AiThread, DraftReply, Tone } from './types'

/**
 * Drafts a reply in the given tone. Drafts only ever fill the composer; sending is always a
 * separate, explicit action by the user.
 *
 * `variant` asks for a different wording of the same tone ("Regenerate"); a real model gets the
 * same effect from sampling temperature.
 */
export async function draftReply(thread: AiThread, tone: Tone, variant = 0): Promise<DraftReply> {
  assertAiCanRead(thread.id)

  // TODO(LLM): replace the mock below with a real model call:
  //   const text = await complete(buildDraftPrompt(thread, tone))
  //   return { tone, text: text.trim() }
  await simulateLatency('draft')
  const text = cannedDraft(thread, tone, variant, Date.now()) ?? heuristicDraft(thread, tone, variant)
  return { tone, text }
}
