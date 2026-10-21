import { assertAiCanRead } from './access'
import { simulateLatency } from './latency'
import { generate, llmConfigured } from './llm'
import { cannedBasePriority, cannedPriority } from './mock/canned'
import { heuristicPriority } from './mock/heuristics'
import { buildPriorityPrompt } from './prompts'
import type { AiThread, PriorityResult } from './types'

/**
 * Decides whether a thread needs a reply from me and how urgent it is. Feeds the "Needs reply"
 * queue (expectsReply) and its sort order (priority).
 */
export async function classifyPriority(thread: AiThread): Promise<PriorityResult> {
  assertAiCanRead(thread.id)

  if (llmConfigured()) {
    const result = await generate(buildPriorityPrompt(thread, new Date()))
    return { ...result, reason: result.reason.trim() }
  }

  await simulateLatency('classify')
  const now = Date.now()
  return cannedPriority(thread, now) ?? heuristicPriority(thread, now, cannedBasePriority(thread.id))
}
