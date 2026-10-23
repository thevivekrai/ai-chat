/**
 * Prompts for each AI function when Claude is connected (see llm.ts). The response shapes are
 * enforced by structured outputs (claude.ts), so prompts describe judgement, not JSON syntax.
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

/** All three tones in one request, so the chat is only sent once. */
export function buildDraftsPrompt(thread: AiThread, variant: number): LlmRequest<'drafts'> {
  const tones = (Object.keys(TONE_GUIDE) as Tone[]).map((tone) => `- ${tone}: ${TONE_GUIDE[tone]}`).join('\n')
  const retry =
    variant > 0 ? `\n\nThe user asked for new wording (attempt ${variant + 1}): avoid the most obvious phrasing.` : ''
  return {
    task: 'drafts',
    system: [
      `You draft chat replies for ${thread.me.name}. Reply to the latest messages addressed to them.`,
      'Match the language the other person writes in (English, Hindi or Hinglish).',
      'Never invent facts such as prices, dates, tracking numbers or promises that are not in the conversation;',
      'write a short [placeholder] in square brackets instead. Each reply is only the text to send.',
    ].join(' '),
    user: `${describeThread(thread)}\n\n${formatTranscript(thread)}\n\nWrite three alternative replies:\n${tones}${retry}`,
    effort: 'medium',
  }
}

export function buildPriorityPrompt(thread: AiThread, now: Date): LlmRequest<'priority'> {
  return {
    task: 'priority',
    system: [
      'You triage a personal inbox. Decide whether the latest messages expect a reply from the user, and how urgent it is.',
      '"reason" is one plain sentence under 90 characters, written to the user.',
      'Urgent: money, customers, deadlines within 48 hours, or someone important waiting more than 2 days.',
      'Low: announcements, automated messages, acknowledgements and casual chatter.',
      'In group chats, only expect a reply when someone addresses the user.',
    ].join(' '),
    user: `Current time: ${now.toISOString()}\n${describeThread(thread)}\n\n${formatTranscript(thread, 30)}`,
    effort: 'low',
  }
}

export function buildSummaryPrompt(thread: AiThread): LlmRequest<'summary'> {
  return {
    task: 'summary',
    system: [
      'Summarise the chat for the user, who has not read it. Write in English, addressing the user as "you".',
      '"oneLine" is a single sentence under 160 characters. "bullets" has 3 to 5 items covering decisions,',
      'open questions and anything asked of the user. Keep amounts, dates and names exact.',
    ].join(' '),
    user: `${describeThread(thread)}\n\n${formatTranscript(thread)}`,
    effort: 'low',
  }
}

export function buildTasksPrompt(thread: AiThread, now: Date, timeZone: string): LlmRequest<'tasks'> {
  return {
    task: 'tasks',
    system: [
      'Extract things the user needs to do or attend from the chat; ignore what other people promised to do.',
      'Titles are short imperatives in English, without the date. Resolve relative dates ("by Friday", "kal 11 baje")',
      `against the timestamp of the message they appear in, in the ${timeZone} time zone, and return ISO 8601`,
      'with offset. "dueText" is the exact date words from the message. Return an empty list when there are none.',
    ].join(' '),
    user: `Current time: ${now.toISOString()}\n${describeThread(thread)}\n\n${formatTranscript(thread)}`,
    effort: 'low',
  }
}

export function buildAnswerPrompt(question: string, sources: AiSearchSource[], now: Date): LlmRequest<'answer'> {
  const evidence = sources
    .map((s) => {
      const task = s.task ? ` [open task: ${s.task.title}${s.task.dueAt ? `, due ${s.task.dueAt}` : ', no due date'}]` : ''
      return `[${s.messageId}] ${s.sentAt} · ${NETWORKS[s.network].name} · "${s.threadTitle}" · ${s.fromMe ? 'me' : s.senderName}: ${s.body}${task}`
    })
    .join('\n')
  return {
    task: 'answer',
    system: [
      'Answer the user\'s question using only the messages provided. If they do not contain the answer, say so.',
      'Some messages carry an open task found in them, with its due date: use those for questions about tasks.',
      'Keep the answer to two or three sentences, put key figures and dates in **bold**,',
      'and cite the ids of the messages you relied on.',
    ].join(' '),
    user: `Current time: ${now.toISOString()}\nQuestion: ${question}\n\nMessages:\n${evidence}`,
    effort: 'medium',
  }
}
