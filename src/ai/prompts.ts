/**
 * Prompt builders for when a real model is connected (see llm.ts and the TODO(LLM) markers in
 * each AI function). They are complete and ready to use; the mock implementations don't need them.
 */
import { NETWORKS } from '@/lib/networks'
import type { LlmRequest } from './llm'
import type { AiSearchSource, AiThread, Tone } from './types'

export function formatTranscript(thread: AiThread, limit = 60): string {
  return thread.messages
    .slice(-limit)
    .map((m) => {
      const who = m.fromMe ? `${thread.me.name} (me)` : m.senderName
      const files = m.attachments?.length ? ` [attachments: ${m.attachments.join(', ')}]` : ''
      return `[${m.id}] ${m.sentAt} ${who}: ${m.body}${files}`
    })
    .join('\n')
}

function describeThread(thread: AiThread): string {
  const people = thread.participants
    .map((p) => [p.name, p.org && `(${p.org})`, p.label && `[${p.label}]`].filter(Boolean).join(' '))
    .join(', ')
  const kind = thread.isGroup ? 'Group chat' : 'Chat'
  return `${kind} "${thread.title}" on ${NETWORKS[thread.network].name}. Participants: ${people}.`
}

const TONE_GUIDE: Record<Tone, string> = {
  short: 'one or two short sentences, warm but to the point',
  friendly: 'warm and conversational; use emoji only if the other person does',
  professional: 'polite, clear and complete, without slang',
}

export function buildDraftPrompt(thread: AiThread, tone: Tone): LlmRequest {
  return {
    system: [
      `You draft chat replies for ${thread.me.name}. Reply to the latest messages addressed to them.`,
      'Match the language the other person writes in (English, Hindi or Hinglish).',
      'Never invent facts such as prices, dates, tracking numbers or promises that are not in the conversation;',
      'write a short [placeholder] in square brackets instead. Return only the reply text.',
    ].join(' '),
    user: `${describeThread(thread)}\n\n${formatTranscript(thread)}\n\nWrite a ${tone} reply: ${TONE_GUIDE[tone]}.`,
    temperature: 0.7,
    maxTokens: 220,
  }
}

export function buildPriorityPrompt(thread: AiThread, now: Date): LlmRequest {
  return {
    system: [
      'You triage a personal inbox. Decide whether the latest messages expect a reply from the user, and how urgent it is.',
      'Respond with JSON only: {"priority":"urgent"|"normal"|"low","expectsReply":boolean,"reason":string}.',
      '"reason" is one plain sentence under 90 characters.',
      'Urgent: money, customers, deadlines within 48 hours, or someone important waiting more than 2 days.',
      'Low: announcements, automated messages, acknowledgements and casual chatter.',
      'In group chats, only expect a reply when someone addresses the user.',
    ].join(' '),
    user: `Current time: ${now.toISOString()}\n${describeThread(thread)}\n\n${formatTranscript(thread, 30)}`,
    json: true,
    temperature: 0,
    maxTokens: 120,
  }
}

export function buildSummaryPrompt(thread: AiThread): LlmRequest {
  return {
    system: [
      'Summarise the chat for the user, who has not read it.',
      'Respond with JSON only: {"oneLine":string,"bullets":string[]}.',
      '"oneLine" is a single sentence under 160 characters. "bullets" has 3 to 5 items covering decisions,',
      'open questions and anything asked of the user. Keep amounts, dates and names exact.',
    ].join(' '),
    user: `${describeThread(thread)}\n\n${formatTranscript(thread)}`,
    json: true,
    temperature: 0.2,
    maxTokens: 400,
  }
}

export function buildTasksPrompt(thread: AiThread, now: Date, timeZone: string): LlmRequest {
  return {
    system: [
      'Extract things the user needs to do or attend from the chat.',
      'Respond with JSON only: {"tasks":[{"title":string,"dueAt":string|null,"dueText":string|null,"sourceMessageId":string}]}.',
      'Titles are short imperatives without the date. Resolve relative dates ("by Friday", "kal 11 baje")',
      `against the timestamp of the message they appear in, in the ${timeZone} time zone, and return ISO 8601`,
      'with offset. "dueText" is the exact date words from the message. Return {"tasks":[]} when there are none.',
    ].join(' '),
    user: `Current time: ${now.toISOString()}\n${describeThread(thread)}\n\n${formatTranscript(thread)}`,
    json: true,
    temperature: 0,
    maxTokens: 500,
  }
}

export function buildAnswerPrompt(question: string, sources: AiSearchSource[], now: Date): LlmRequest {
  const evidence = sources
    .map(
      (s) =>
        `[${s.messageId}] ${s.sentAt} · ${NETWORKS[s.network].name} · "${s.threadTitle}" · ${s.fromMe ? 'me' : s.senderName}: ${s.body}`,
    )
    .join('\n')
  return {
    system: [
      'Answer the user\'s question using only the messages provided. If they do not contain the answer, say so.',
      'Respond with JSON only: {"answer":string,"citedMessageIds":string[]}.',
      'Keep the answer to two or three sentences, put key figures and dates in **bold**,',
      'and cite the ids of the messages you relied on.',
    ].join(' '),
    user: `Current time: ${now.toISOString()}\nQuestion: ${question}\n\nMessages:\n${evidence}`,
    json: true,
    temperature: 0.1,
    maxTokens: 300,
  }
}
