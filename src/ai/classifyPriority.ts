import { assertAiCanRead } from './access'
import { simulateLatency } from './latency'
import { generate, llmConfigured } from './llm'
import { cannedBasePriority, cannedPriority } from './mock/canned'
import { heuristicLabels, heuristicPriority, saysUrgent } from './mock/heuristics'
import { buildPriorityPrompt } from './prompts'
import { CHAT_LABELS, MAX_LABELS, type AiThread, type ChatLabel, type PriorityResult } from './types'

/**
 * Decides whether a thread needs a reply from me and how urgent it is. Feeds the "Needs reply"
 * queue (expectsReply) and its sort order (priority).
 */
export async function classifyPriority(thread: AiThread): Promise<PriorityResult> {
  assertAiCanRead(thread.id)

  if (llmConfigured()) {
    const result = await generate(buildPriorityPrompt(thread, new Date()))
    return checked(thread, { ...result, reason: result.reason.trim(), labels: tidy(result.labels) })
  }

  await simulateLatency('classify')
  const now = Date.now()
  const result = cannedPriority(thread, now) ?? heuristicPriority(thread, now, cannedBasePriority(thread.id))
  return { ...result, labels: result.labels ?? heuristicLabels(thread, now) }
}

/** Known tags only, each once, at most MAX_LABELS. */
function tidy(labels: readonly string[] | undefined): ChatLabel[] {
  const known = (labels ?? []).filter((l): l is ChatLabel => (CHAT_LABELS as readonly string[]).includes(l))
  return [...new Set(known)].slice(0, MAX_LABELS)
}

/**
 * A safety net under the model: someone who says outright that it's urgent (and is still waiting
 * on the user) is never shown as normal or low.
 */
function checked(thread: AiThread, result: PriorityResult): PriorityResult {
  // In a group, "urgent" may be meant for someone else: only when the model saw it's for the user.
  if (result.priority === 'urgent' || (thread.isGroup && !result.expectsReply)) return result
  const pending: string[] = []
  for (let i = thread.messages.length - 1; i >= 0 && !thread.messages[i]!.fromMe; i--) pending.unshift(thread.messages[i]!.body)
  if (!pending.length || !saysUrgent(pending.join('\n'))) return result
  return { ...result, priority: 'urgent', expectsReply: true }
}
