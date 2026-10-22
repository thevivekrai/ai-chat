import { assertAiCanRead } from './access'
import { simulateLatency } from './latency'
import { generate, llmConfigured } from './llm'
import { cannedSummary } from './mock/canned'
import { heuristicSummary } from './mock/heuristics'
import { buildSummaryPrompt } from './prompts'
import type { AiThread, ThreadSummary } from './types'

/** One-line summary (shown atop long threads) plus key points (for "Summarize" in group chats). */
export async function summarizeThread(thread: AiThread): Promise<ThreadSummary> {
  assertAiCanRead(thread.id)

  if (llmConfigured()) {
    const { oneLine, bullets } = await generate(buildSummaryPrompt(thread))
    return { oneLine: oneLine.trim(), bullets: bullets.map((b) => b.trim()).filter(Boolean).slice(0, 6) }
  }

  await simulateLatency('summarize')
  const now = Date.now()
  return cannedSummary(thread, now) ?? heuristicSummary(thread, now)
}
