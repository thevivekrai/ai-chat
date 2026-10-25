/**
 * Prompts for each AI function when a real AI is chosen (see llm.ts). The response shapes are
 * enforced by structured output (see schemas.ts), so prompts describe judgement, not JSON syntax.
 */
import { NETWORKS } from '@/lib/networks'
import type { LlmRequest } from './llm'
import { MAX_LABELS, type AiSearchSource, type AiTask, type AiThread, type Tone } from './types'

/** At most this many open tasks go with a question about tasks. */
const TASKS_IN_ANSWER = 30

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

const LABEL_GUIDE = [
  'question: they asked the user something',
  'follow-up: they are chasing the user (asked again, "??", "any update?", several messages in a row)',
  'deadline: a date or time something is due or happens (today, by Friday, kal 11 baje)',
  'payment: money, bills, invoices, refunds, UPI, prices or quotes',
  'order: an order, delivery, parcel, booking or tracking',
  'meeting: a call, meeting, visit or plan to meet',
  'work: work, business or customers',
  'personal: family and friends',
  'promo: marketing, offers, newsletters and other automated messages',
  'fyi: news or an update that needs nothing from the user',
].join('; ')

/** Facts a model is easy to get wrong from timestamps alone: who is waiting, and for how long. */
export function waitingFacts(thread: AiThread, now: Date): string {
  const pending: AiThread['messages'] = []
  for (let i = thread.messages.length - 1; i >= 0 && !thread.messages[i]!.fromMe; i--) pending.unshift(thread.messages[i]!)
  const last = thread.messages[thread.messages.length - 1]
  if (!last) return 'The chat is empty.'
  if (last.fromMe) return 'The user wrote last; nothing new has come in since.'
  const since = Math.max(0, now.getTime() - Date.parse(pending[0]!.sentAt))
  const hours = since / 3_600_000
  const waited = hours < 1 ? `${Math.max(1, Math.round(since / 60_000))} minutes` : hours < 48 ? `${Math.round(hours)} hours` : `${Math.round(hours / 24)} days`
  const mentioned = thread.isGroup && pending.some((m) => m.body.toLowerCase().includes(thread.me.name.split(' ')[0]!.toLowerCase()))
  return [
    `${pending.length} message${pending.length === 1 ? '' : 's'} from others since the user last wrote, the first ${waited} ago.`,
    thread.isGroup ? (mentioned ? 'Someone mentions the user by name.' : 'Nobody mentions the user by name.') : '',
  ]
    .filter(Boolean)
    .join(' ')
}

export function buildPriorityPrompt(thread: AiThread, now: Date): LlmRequest<'priority'> {
  return {
    task: 'priority',
    system: [
      "You triage the user's personal inbox (WhatsApp, Telegram and similar; English, Hindi or Hinglish).",
      'Decide whether the latest messages expect a reply or action from the user, how urgent that is, and tag the chat.',
      '',
      'priority:',
      '- urgent: needs the user soon. An emergency, health or safety matter; someone says it is urgent',
      '  (urgent, asap, important, right now, jaldi, turant, abhi, "call me"); a deadline, appointment or',
      '  payment due within 48 hours (today, tonight, tomorrow, kal); money at stake (a failed or due',
      '  payment, refund, overdue invoice); a customer or client with a problem or complaint; someone',
      '  chasing the user ("??", "hello?", "any update?", asking again); or a direct question left',
      '  unanswered for more than a day.',
      '- normal: a reply is expected but nothing presses: a question, request or plan without a near deadline.',
      '- low: nothing is needed from the user: news, announcements, forwards, greetings, "ok"/"thanks"/👍,',
      '  casual chatter, automated messages (OTPs, bank alerts, offers, newsletters), or the user wrote last.',
      'When a reply is expected and it is unclear whether it is urgent or normal, choose urgent if any of',
      'the urgent signals above is present, and normal otherwise. Do not mark a chat low while a question',
      'to the user is unanswered.',
      '',
      'expectsReply: true when the latest messages ask or need something from the user. In group chats, only',
      'when someone addresses the user (by name, or replying to them). False when the user wrote last.',
      '',
      '"reason" is one plain sentence under 90 characters, written to the user, naming the concrete reason',
      '(who is waiting, for what, and any deadline).',
      '',
      `labels: up to ${MAX_LABELS} tags, most telling first, only ones that clearly apply: ${LABEL_GUIDE}.`,
    ].join('\n'),
    user: `Current time: ${now.toISOString()}\n${describeThread(thread)}\n${waitingFacts(thread, now)}\n\n${formatTranscript(thread, 30)}`,
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

export function buildAnswerPrompt(question: string, sources: AiSearchSource[], now: Date, timeZone: string, tasks: AiTask[] = []): LlmRequest<'answer'> {
  const evidence = sources
    .map((s) => `[${s.messageId}] ${s.sentAt} · ${NETWORKS[s.network].name} · "${s.threadTitle}" · ${s.fromMe ? 'me' : s.senderName}: ${s.body}`)
    .join('\n')
  const listed = tasks.slice(0, TASKS_IN_ANSWER)
  const open = listed
    .map((t) => {
      const from = t.messageId ? `[${t.messageId}] from ${t.threadTitle ? `"${t.threadTitle}"` : 'a chat'}` : 'added by hand'
      return `- ${t.title} · ${t.dueAt ? `due ${t.dueAt}` : 'no due date'} · ${from}`
    })
    .join('\n')
  const taskList = tasks.length
    ? `\n\nOpen tasks (${tasks.length} in all${tasks.length > listed.length ? `; the ${listed.length} due soonest` : ''}):\n${open}`
    : ''
  return {
    task: 'answer',
    system: [
      'Answer the user\'s question using only the messages and tasks provided. If they do not contain the answer, say so.',
      'For questions about tasks, use the open tasks and their due dates, judging "today" in the user\'s time zone.',
      'Keep the answer to two or three sentences, put key figures and dates in **bold**,',
      'and cite the ids of the messages you relied on.',
    ].join(' '),
    user: `Current time: ${now.toISOString()} (the user's time zone: ${timeZone})\nQuestion: ${question}\n\nMessages:\n${evidence}${taskList}`,
    effort: 'medium',
  }
}
