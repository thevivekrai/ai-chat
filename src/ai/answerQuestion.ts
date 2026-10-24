import { NETWORKS } from '@/lib/networks'
import { addDays, formatDurationLong, startOfDay, toMs } from '@/lib/time'
import { assertAiCanRead } from './access'
import { simulateLatency } from './latency'
import { generate, llmConfigured } from './llm'
import { cannedAnswer } from './mock/canned'
import { truncate } from './mock/heuristics'
import { buildAnswerPrompt } from './prompts'
import type { AiSearchSource, AiTask, SearchAnswer } from './types'

/**
 * Answers a question ("what did the supplier quote me?") from messages retrieved by search.
 * `sources` should be ordered best match first. Only AI-readable threads may be passed in. For a
 * question about tasks, `tasks` are the open ones (see openTasks), soonest due first.
 */
export async function answerQuestion(question: string, sources: AiSearchSource[], tasks: AiTask[] = []): Promise<SearchAnswer> {
  for (const threadId of new Set(sources.map((s) => s.threadId))) assertAiCanRead(threadId)

  if (llmConfigured()) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const { answer, citedMessageIds } = await generate(buildAnswerPrompt(question, sources, new Date(), timeZone, tasks))
    const known = new Set([...sources.map((s) => s.messageId), ...tasks.flatMap((t) => (t.messageId ? [t.messageId] : []))])
    return { answer: answer.trim(), citedMessageIds: citedMessageIds.filter((id) => known.has(id)) }
  }

  await simulateLatency('answer')
  const now = Date.now()
  return (tasks.length ? taskAnswer(tasks, now) : null) ?? cannedAnswer(question, sources, now) ?? genericAnswer(sources, now)
}

/** The open tasks: what's due today (or overdue), or else what's open. */
function taskAnswer(tasks: AiTask[], now: number): SearchAnswer {
  const endOfToday = startOfDay(addDays(now, 1))
  const today = tasks.filter((t) => t.dueAt && toMs(t.dueAt) < endOfToday)
  const listed = (today.length ? today : tasks).slice(0, 5)
  const names = listed.map((t) => `**${t.title}**${t.threadTitle ? ` (${t.threadTitle})` : ''}`).join(', ')
  const count = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`
  const more = (shown: number, all: number) => (all > shown ? `, and ${all - shown} more` : '')
  return {
    answer: today.length
      ? `You have ${count(today.length)} due today or overdue: ${names}${more(listed.length, today.length)}.`
      : `Nothing is due today. You have ${count(tasks.length)} open: ${names}${more(listed.length, tasks.length)}.`,
    citedMessageIds: listed.flatMap((t) => (t.messageId ? [t.messageId] : [])),
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
