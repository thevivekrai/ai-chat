import { NETWORKS } from '@/lib/networks'
import { formatDurationLong, toMs } from '@/lib/time'
import { assertAiCanRead } from './access'
import { simulateLatency } from './latency'
import { generate, llmConfigured } from './llm'
import { cannedAnswer } from './mock/canned'
import { truncate } from './mock/heuristics'
import { buildAnswerPrompt } from './prompts'
import type { AiSearchSource, SearchAnswer } from './types'

/**
 * Answers a question ("what did the supplier quote me?") from messages retrieved by search.
 * `sources` should be ordered best match first. Only AI-readable threads may be passed in.
 */
export async function answerQuestion(question: string, sources: AiSearchSource[]): Promise<SearchAnswer> {
  for (const threadId of new Set(sources.map((s) => s.threadId))) assertAiCanRead(threadId)

  if (llmConfigured()) {
    const { answer, citedMessageIds } = await generate(buildAnswerPrompt(question, sources, new Date()))
    const known = new Set(sources.map((s) => s.messageId))
    return { answer: answer.trim(), citedMessageIds: citedMessageIds.filter((id) => known.has(id)) }
  }

  await simulateLatency('answer')
  const now = Date.now()
  return taskAnswer(sources, now) ?? cannedAnswer(question, sources, now) ?? genericAnswer(sources, now)
}

/** Open tasks passed in (for a question about tasks): what's due today, or else what's open. */
function taskAnswer(sources: AiSearchSource[], now: number): SearchAnswer | null {
  const tasks = sources.filter((s) => s.task)
  if (!tasks.length) return null
  const endOfToday = new Date(now)
  endOfToday.setHours(23, 59, 59, 999)
  const today = tasks.filter((s) => s.task!.dueAt && toMs(s.task!.dueAt) <= endOfToday.getTime())
  const listed = (today.length ? today : tasks).slice(0, 5)
  const names = listed.map((s) => `**${s.task!.title}** (${s.threadTitle})`).join(', ')
  const count = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`
  return {
    answer: today.length
      ? `You have ${count(today.length)} due today or overdue: ${names}.`
      : `Nothing is due today. Your open ${count(tasks.length)}: ${names}.`,
    citedMessageIds: listed.map((s) => s.messageId),
  }
}

function genericAnswer(sources: AiSearchSource[], now: number): SearchAnswer {
  const top = sources[0]
  if (!top) {
    return { answer: "I couldn't find anything about that in the chats AI can read.", citedMessageIds: [] }
  }
  const who = top.fromMe ? 'You' : top.senderName
  const age = formatDurationLong(now - toMs(top.sentAt))
  const others = [...new Set(sources.slice(1, 4).map((s) => s.threadTitle))].filter((t) => t !== top.threadTitle)
  const also = others.length ? ` It also comes up in ${others.join(' and ')}.` : ''
  return {
    answer: `The closest match is in **${top.threadTitle}** on ${NETWORKS[top.network].name}, ${age} ago — ${who}: “${truncate(top.body, 120)}”.${also}`,
    citedMessageIds: [top.messageId],
  }
}
