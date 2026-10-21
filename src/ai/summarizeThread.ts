import { assertAiCanRead } from './access'
import { simulateLatency } from './latency'
import { cannedSummary } from './mock/canned'
import { heuristicSummary } from './mock/heuristics'
import type { AiThread, ThreadSummary } from './types'

/** One-line summary (shown atop long threads) plus key points (for "Summarize" in group chats). */
export async function summarizeThread(thread: AiThread): Promise<ThreadSummary> {
  assertAiCanRead(thread.id)

  // TODO(LLM): replace the mock below with a real model call:
  //   const raw = await complete(buildSummaryPrompt(thread))
  //   return parseJson<ThreadSummary>(raw)
  await simulateLatency('summarize')
  const now = Date.now()
  return cannedSummary(thread, now) ?? heuristicSummary(thread, now)
}
