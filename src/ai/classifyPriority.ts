import { assertAiCanRead } from './access'
import { simulateLatency } from './latency'
import { generate, llmConfigured, modelFor } from './llm'
import { cannedBasePriority, cannedPriority } from './mock/canned'
import { heuristicLabels, heuristicPriority, saysUrgent } from './mock/heuristics'
import { buildPriorityPrompt } from './prompts'
import { LABEL_CONFIDENCE, MAX_LABELS, TAGGING_WINDOW, type AiThread, type ChatLabel, type LabelCall, type PriorityResult, type TagAudit } from './types'

/**
 * Decides whether a thread needs a reply from me and how urgent it is. Feeds the "Needs reply"
 * queue (expectsReply) and its sort order (priority).
 */
export async function classifyPriority(thread: AiThread): Promise<PriorityResult> {
  assertAiCanRead(thread.id)

  const messageIds = thread.messages.slice(-TAGGING_WINDOW).map((m) => m.id)
  if (llmConfigured()) {
    const request = buildPriorityPrompt(thread, new Date())
    const answer = await generate(request)
    const audit = record('priority', `${request.system}\n${request.user}`, messageIds, answer)
    return checked(thread, { ...answer, reason: answer.reason.trim(), ...applied(answer.labels), audit })
  }

  await simulateLatency('classify')
  const now = Date.now()
  const result = cannedPriority(thread, now) ?? heuristicPriority(thread, now, cannedBasePriority(thread.id))
  const calls = result.labels ? result.labels.map((tag) => ({ tag, confidence: 1, why: 'Set for this demo chat' })) : heuristicLabels(thread, now)
  return { ...result, ...applied(calls), audit: record('priority', DEMO_RULES, messageIds, { ...result, labels: calls }) }
}

/** The demo AI's rules have no prompt; their version stands in for one in the record. */
const DEMO_RULES = 'demo-rules:2'

function record(task: 'priority', prompt: string, messageIds: string[], answer: unknown): TagAudit {
  return { model: modelFor(task), promptHash: hash(prompt), messageIds, raw: JSON.stringify(answer).slice(0, 2000), at: new Date().toISOString() }
}

/** FNV-1a: a short fingerprint of the prompt, enough to tell two prompts apart in the record. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * The tags that are used, out of the ones the AI considered: sure enough, each once, most sure
 * first, and never more than MAX_LABELS. Nothing sure enough means no tags — a chat with none
 * reads better than a chat with the wrong one. The rest are kept to answer "why this tag?".
 */
function applied(calls: readonly LabelCall[]): { labels: ChatLabel[]; labelCalls: LabelCall[] } {
  const seen = new Set<string>()
  const ranked = [...calls].sort((a, b) => b.confidence - a.confidence).filter((c) => !seen.has(c.tag) && seen.add(c.tag))
  return {
    labels: ranked.filter((c) => c.confidence >= LABEL_CONFIDENCE).slice(0, MAX_LABELS).map((c) => c.tag),
    labelCalls: ranked,
  }
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
