import { NETWORKS } from '@/lib/networks'
import { formatDurationLong, toMs } from '@/lib/time'
import { assertAiCanRead } from './access'
import { simulateLatency } from './latency'
import { cannedAnswer } from './mock/canned'
import { truncate } from './mock/heuristics'
import type { AiSearchSource, SearchAnswer } from './types'

/**
 * Answers a question ("what did the supplier quote me?") from messages retrieved by search.
 * `sources` should be ordered best match first. Only AI-readable threads may be passed in.
 */
export async function answerQuestion(question: string, sources: AiSearchSource[]): Promise<SearchAnswer> {
  for (const threadId of new Set(sources.map((s) => s.threadId))) assertAiCanRead(threadId)

  // TODO(LLM): replace the mock below with a real model call:
  //   const raw = await complete(buildAnswerPrompt(question, sources, new Date()))
  //   return parseJson<SearchAnswer>(raw)
  await simulateLatency('answer')
  const now = Date.now()
  return cannedAnswer(question, sources, now) ?? genericAnswer(sources, now)
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
