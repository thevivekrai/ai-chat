import { assertAiCanRead } from './access'
import { simulateLatency } from './latency'
import { cannedBasePriority, cannedPriority } from './mock/canned'
import { heuristicPriority } from './mock/heuristics'
import type { AiThread, PriorityResult } from './types'

/**
 * Decides whether a thread needs a reply from me and how urgent it is. Feeds the "Needs reply"
 * queue (expectsReply) and its sort order (priority).
 */
export async function classifyPriority(thread: AiThread): Promise<PriorityResult> {
  assertAiCanRead(thread.id)

  // TODO(LLM): replace the mock below with a real model call:
  //   const raw = await complete(buildPriorityPrompt(thread, new Date()))
  //   return parseJson<PriorityResult>(raw)
  await simulateLatency('classify')
  const now = Date.now()
  return cannedPriority(thread, now) ?? heuristicPriority(thread, now, cannedBasePriority(thread.id))
}
