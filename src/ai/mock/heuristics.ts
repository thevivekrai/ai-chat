/**
 * Rule-based stand-in for a language model, used whenever there is no hand-written result for a
 * thread (e.g. after a new message arrives). It reads the same AiThread a real model would get and
 * aims for plausible, conservative output. Delete it once a real model is connected.
 */
import {
  expectsReply,
  firstOpenMessage,
  hasQuestion,
  hasRequest,
  isAckOnly,
  isThanks,
  mentionsName,
} from '@/lib/replyRules'
import { shortName } from '@/lib/format'
import { DAY, formatDurationLong, toMs } from '@/lib/time'
import { MAX_LABELS, type AiMessage, type AiThread, type ChatLabel, type ExtractedTask, type Priority, type PriorityResult, type ThreadSummary, type Tone } from '../types'
import { findDateMention } from './dates'

/* ── Reading a thread ───────────────────────────────────────────────────── */

export const lastMessage = (t: AiThread): AiMessage | undefined => t.messages[t.messages.length - 1]

/** Messages from others since my last message: what I have not answered yet. */
function pendingInbound(t: AiThread): AiMessage[] {
  const pending: AiMessage[] = []
  for (let i = t.messages.length - 1; i >= 0 && !t.messages[i].fromMe; i--) pending.unshift(t.messages[i])
  return pending
}

/** When the person started waiting on me (see firstOpenMessage), or undefined if they aren't. */
export function waitingSince(t: AiThread): string | undefined {
  return firstOpenMessage(pendingInbound(t), { isGroup: t.isGroup, myName: t.me.name })?.sentAt
}

function counterpart(t: AiThread): string {
  if (t.isGroup) return t.title
  const person = t.participants[0]
  return person ? shortName(person.name) : t.title
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

/* ── Signals ────────────────────────────────────────────────────────────── */

export const isAutomated = (t: AiThread) => t.participants.some((p) => p.label?.toLowerCase() === 'automated')

const HINGLISH_WORDS = new Set(
  (
    'hai hain kya kab na ho bhai yaar kal nahi haan karo kar raha rahe rahi mein ka ki ke aa ji accha theek toh ' +
    'bhi beta chal milte karte hoon hu bhej dena lena wala kuch sab pe se ko baje aaunga rakhna gaye thoda'
  ).split(' '),
)

function isHinglish(text: string): boolean {
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean)
  const hits = words.filter((w) => HINGLISH_WORDS.has(w)).length
  return hits >= 2 || (hits >= 1 && words.length <= 6)
}

type Intent = 'order' | 'price' | 'feedback' | 'payment' | 'plans'

const INTENT_PATTERNS: [Intent, RegExp][] = [
  ['order', /\b(order|delivery|deliver|tracking|shipped|parcel|dispatch)\b|#[a-z]{2}-\d+/i],
  ['price', /\b(price|pricing|cost|rate|quote|quotation|how much|kitne|kitna)\b/i],
  ['feedback', /\b(feedback|review|thoughts|take a look)\b/i],
  ['payment', /\b(pay|payment|paid|upi|transfer|invoice)\b/i],
  ['plans', /\b(coffee|lunch|dinner|meet|milte|plan|free|weekend|party)\b/i],
]

function detectIntent(text: string): Intent | null {
  return INTENT_PATTERNS.find(([, re]) => re.test(text))?.[0] ?? null
}

/* ── Classification ─────────────────────────────────────────────────────── */

/** Someone says it can't wait (and doesn't say it can). */
const URGENT_WORDS =
  /\b(urgent|urgently|asap|emergency|immediately|right away|right now|critical|hospital|accident|jaldi|turant|abhi ke abhi|please call|call me)\b/i
const NOT_URGENT = /\b(not urgent|no rush|no hurry|whenever you can|koi jaldi nahi|aaram se)\b/i
/** Asking again, or asking where things are. */
const CHASING = /(\?\s*\?|^\s*(hello|hi|hey|helo)\s*\?+\s*$|\bany update|\bstill waiting|\bdid you (see|get|check)|\bwaiting for your)/im
const PROMO = /\b(offer|sale|discount|% off|cashback|coupon|deal|subscribe|newsletter|unsubscribe|limited time)\b/i
const WORK = /\b(client|customer|invoice|meeting|deadline|project|office|report|order|quote|proposal|contract|team)\b/i

export function saysUrgent(text: string): boolean {
  return URGENT_WORDS.test(text) && !NOT_URGENT.test(text)
}

/**
 * They're chasing a reply: they ask where things are ("any update?", "??"), or ask again an hour
 * or more after first asking. (Several messages in a row are just how people write.)
 */
export function isChasing(pending: AiMessage[]): boolean {
  if (pending.some((m) => CHASING.test(m.body))) return true
  const asks = pending.filter((m) => hasQuestion(m.body) || hasRequest(m.body))
  return asks.length >= 2 && toMs(asks[asks.length - 1]!.sentAt) - toMs(asks[0]!.sentAt) >= 60 * 60_000
}

/** Tags for what the chat is about, from the same signals the rules use. */
export function heuristicLabels(t: AiThread, now = Date.now()): ChatLabel[] {
  const pending = pendingInbound(t)
  const recent = t.messages.slice(-6)
  const text = (pending.length ? pending : recent).map((m) => m.body).join('\n')
  const labels: ChatLabel[] = []
  const add = (label: ChatLabel, when: boolean) => when && !labels.includes(label) && labels.push(label)
  const automated = isAutomated(t)
  add('promo', automated && PROMO.test(text))
  add('follow-up', !automated && isChasing(pending))
  add('question', !automated && pending.some((m) => hasQuestion(m.body) || hasRequest(m.body)))
  add(
    'deadline',
    !automated &&
      // Something due or happening within the week, not "in about 3 weeks".
      (pending.some((m) => {
        const d = findDateMention(m.body, toMs(m.sentAt))
        return !!d && d.at > now - DAY && d.at - now < 7 * DAY
      }) || /\b(today|tonight|tomorrow|kal|deadline|by (mon|tue|wed|thu|fri|sat|sun))/i.test(text)),
  )
  // Every topic that shows, not just the first (a message can ask for the invoice of an order).
  const about = (intent: Intent) => INTENT_PATTERNS.some(([i, re]) => i === intent && re.test(text))
  // Automated messages: what they're about (a bank alert, a delivery), but never asks or plans.
  add('payment', about('payment') || about('price') || /\b(refund|bill|amount|rs\.?|inr)\b|₹/i.test(text))
  add('order', about('order'))
  add('meeting', !automated && (about('plans') || /\b(call|meeting|zoom|meet)\b/i.test(text)))
  const work = t.participants.some((p) => /customer|client|lead|work|colleague|vendor|supplier/i.test(p.label ?? '')) || WORK.test(text)
  add('work', work)
  add('personal', !work && !automated && t.participants.some((p) => /family|friend|mom|dad|brother|sister/i.test(p.label ?? '')))
  add('fyi', !automated && !heuristicExpectsReply(t) && !lastMessage(t)?.fromMe)
  return labels.slice(0, MAX_LABELS)
}

export function heuristicExpectsReply(t: AiThread): boolean {
  return expectsReply({
    isGroup: t.isGroup,
    isAutomated: isAutomated(t),
    myName: t.me.name,
    pending: pendingInbound(t).map((m) => m.body),
  })
}

export function heuristicPriority(t: AiThread, now: number, prior?: Priority): PriorityResult {
  const last = lastMessage(t)
  const who = counterpart(t)
  if (!last) return { priority: 'low', expectsReply: false, reason: 'No messages yet.' }
  if (last.fromMe) {
    // The ball is in their court, so it's no longer urgent for me.
    const priority = prior === 'low' ? 'low' : 'normal'
    return { priority, expectsReply: false, reason: `You replied last — waiting on ${who}.` }
  }
  if (isAutomated(t)) return { priority: 'low', expectsReply: false, reason: 'Automated message — no reply needed.' }

  const pending = pendingInbound(t)
  if (!heuristicExpectsReply(t)) {
    const reason = isAckOnly(last.body)
      ? `Just a “${truncate(last.body, 24)}” — nothing to reply to.`
      : t.isGroup
        ? 'Group chatter — nobody asked you anything.'
        : `${who} wrapped up the conversation — no reply needed.`
    return { priority: 'low', expectsReply: false, reason }
  }

  const text = pending.map((m) => m.body).join('\n')
  const waitingMs = now - toMs(waitingSince(t) ?? last.sentAt)
  const isCustomer = t.participants.some((p) => /customer|client|lead/i.test(p.label ?? ''))
  const deadline = pending
    .map((m) => findDateMention(m.body, toMs(m.sentAt)))
    .find((d) => d && d.at > now - DAY && d.at - now < 2 * DAY)

  if (saysUrgent(text)) {
    return { priority: 'urgent', expectsReply: true, reason: `${who} flagged this as time-sensitive.` }
  }
  if (!t.isGroup && isChasing(pending)) {
    return { priority: 'urgent', expectsReply: true, reason: `${who} is chasing a reply.` }
  }
  if (/\b(refund|payment (failed|due|pending)|overdue|not paid|money back)\b/i.test(text)) {
    return { priority: 'urgent', expectsReply: true, reason: `Money is at stake: ${truncate(pending.at(-1)!.body, 50)}` }
  }
  if (isCustomer && /\b(late|delay|delayed|still|not received|refund|damaged|broken|wrong|update)\b/i.test(text)) {
    return { priority: 'urgent', expectsReply: true, reason: `A customer is chasing an update.` }
  }
  if ((isCustomer || !t.isGroup) && waitingMs > 2 * DAY && pending.some((m) => hasQuestion(m.body))) {
    return {
      priority: 'urgent',
      expectsReply: true,
      reason: `${who} has been waiting ${formatDurationLong(waitingMs)}.`,
    }
  }
  if (deadline) {
    return {
      // A near deadline bumps casual threads to normal and everything else to urgent.
      priority: prior === 'low' ? 'normal' : 'urgent',
      expectsReply: true,
      reason: `Mentions a deadline: “${deadline.phrases.join(' ')}”.`,
    }
  }

  const asker = t.isGroup ? shortName(pending.find((m) => mentionsName(m.body, t.me.name))?.senderName ?? who) : who
  const reason = t.isGroup
    ? `${asker} asked you directly.`
    : pending.some((m) => hasQuestion(m.body))
      ? `${who} asked you something ${formatDurationLong(waitingMs)} ago.`
      : `${who} is waiting to hear back from you.`
  return { priority: prior ?? 'normal', expectsReply: true, reason }
}

/* ── Summaries ──────────────────────────────────────────────────────────── */

export function heuristicSummary(t: AiThread, now: number): ThreadSummary {
  const last = lastMessage(t)
  if (!last) return { oneLine: 'No messages yet.', bullets: [] }
  const who = counterpart(t)
  const informative = t.messages.filter((m) => !m.fromMe && !isAckOnly(m.body)).slice(-4)
  const bullets = informative.map((m) => `${shortName(m.senderName)}: ${truncate(m.body, 90)}`)

  if (t.isGroup) {
    const recent = t.messages.filter((m) => now - toMs(m.sentAt) < 2 * DAY)
    const people = new Set(recent.filter((m) => !m.fromMe).map((m) => m.senderId)).size
    const lead = recent.length
      ? `${recent.length} message${recent.length === 1 ? '' : 's'} from ${people} ${people === 1 ? 'person' : 'people'} in the last 2 days.`
      : 'Quiet lately.'
    return { oneLine: `${lead} Latest — ${shortName(last.senderName)}: “${truncate(last.body, 60)}”`, bullets }
  }
  if (last.fromMe) {
    return { oneLine: `You wrote last: “${truncate(last.body, 70)}” — waiting on ${who}.`, bullets }
  }
  const pending = pendingInbound(t)
  const intent = detectIntent(pending.map((m) => m.body).join(' '))
  const verb =
    intent === 'order'
      ? 'is asking about an order'
      : intent === 'price'
        ? 'asked about pricing'
        : intent === 'feedback'
          ? 'is waiting on your feedback'
          : intent === 'plans'
            ? 'wants to make plans'
            : pending.some((m) => hasQuestion(m.body))
              ? 'asked you something'
              : 'sent an update'
  return { oneLine: `${who} ${verb}: “${truncate(last.body, 70)}”`, bullets }
}

/* ── Drafts ─────────────────────────────────────────────────────────────── */

type Templates = Record<Tone, ((name: string) => string)[]>

const TEMPLATES: Record<Intent | 'question' | 'request' | 'thanks' | 'nudge' | 'default', Templates> = {
  order: {
    short: [(n) => `Hi ${n}, checking on your order now — will update you shortly.`],
    friendly: [(n) => `Hey ${n}! Sorry for the wait 🙏 Let me check on your order and get back to you in a bit.`],
    professional: [
      (n) => `Hi ${n}, thank you for your patience. I'm checking the status of your order and will update you shortly.`,
    ],
  },
  price: {
    short: [(n) => `Hi ${n}! It's ₹[price]. Want me to set one aside?`],
    friendly: [(n) => `Hey ${n}, thanks for asking! 😊 It's ₹[price] — happy to send more photos if you'd like.`],
    professional: [
      (n) => `Hi ${n}, thank you for your interest. The price is ₹[price]. Please let me know if you'd like to go ahead.`,
    ],
  },
  feedback: {
    short: [(n) => `Thanks ${n}! Will take a look and get back to you.`],
    friendly: [(n) => `Thanks ${n}, this looks great! I'll go through it and send my notes soon 🙌`],
    professional: [(n) => `Hi ${n}, thank you for sharing. I'll review it and send feedback shortly.`],
  },
  payment: {
    short: [(n) => `Thanks ${n}, will check and confirm.`],
    friendly: [(n) => `Hey ${n}! Let me check on the payment and get back to you 🙂`],
    professional: [(n) => `Hi ${n}, thank you. I'll verify the payment details and confirm shortly.`],
  },
  plans: {
    short: [() => 'Sounds good! When works for you?'],
    friendly: [() => "Yes, let's do it! 😊 When are you free?"],
    professional: [(n) => `That sounds great, ${n}. Which day works best for you?`],
  },
  question: {
    short: [() => 'Let me check and get back to you!'],
    friendly: [(n) => `Hey ${n}! Good question — let me check and get back to you shortly 😊`],
    professional: [(n) => `Hi ${n}, thanks for your message. I'll look into this and get back to you shortly.`],
  },
  request: {
    short: [() => 'On it! Will get back to you shortly.'],
    friendly: [(n) => `Sure thing, ${n}! I'll take care of it soon 🙌`],
    professional: [(n) => `Hi ${n}, noted. I'll take care of this and confirm once it's done.`],
  },
  thanks: {
    short: [() => 'Anytime! 😊'],
    friendly: [(n) => `Happy to help, ${n}! 😊`],
    professional: [(n) => `You're welcome, ${n}. Let me know if you need anything else.`],
  },
  nudge: {
    short: [(n) => `Hi ${n}, just checking in on this 🙂`, (n) => `Hey ${n}, any update on this?`],
    friendly: [
      (n) => `Hey ${n}! Just bumping this up in case it got buried 😊 No rush!`,
      (n) => `Hi ${n}! Gentle nudge on my last message whenever you get a minute 🙏`,
    ],
    professional: [
      (n) => `Hi ${n}, following up on my earlier message. Let me know when you get a chance.`,
      (n) => `Hi ${n}, just checking whether you had a chance to look at my previous message.`,
    ],
  },
  default: {
    short: [(n) => `Got it, thanks ${n}!`],
    friendly: [(n) => `Thanks for the message, ${n}! 😊`],
    professional: [(n) => `Hi ${n}, thank you for the update.`],
  },
}

/** Casual replies in Hinglish when the other person writes that way. Professional stays English. */
const HINGLISH_TEMPLATES: Partial<Record<keyof typeof TEMPLATES, Partial<Templates>>> = {
  plans: { short: [() => 'Haan pakka! Kab milein?'], friendly: [() => 'Haan yaar, pakka milte hain! Kab free ho? 😊'] },
  question: {
    short: [() => 'Ruk, check karke batata hoon!'],
    friendly: [() => 'Achha, main check karke batata hoon thodi der mein 😊'],
  },
  request: { short: [() => 'Haan, kar deta hoon 👍'], friendly: [() => 'Haan bilkul, ho jayega! 🙌'] },
  thanks: { short: [() => 'Arre koi baat nahi! 😊'], friendly: [() => 'Arre koi baat nahi! 😊 Kabhi bhi'] },
  nudge: {
    short: [(n) => `${n}, bas check kar raha tha 🙂`],
    friendly: [(n) => `Hey ${n}! Bas yaad dila raha tha, koi jaldi nahi 😊`],
  },
  default: { short: [() => 'Theek hai, thanks!'], friendly: [(n) => `Achha, thanks ${n}! 😊`] },
}

export function heuristicDraft(t: AiThread, tone: Tone, variant = 0): string {
  const last = lastMessage(t)
  const pending = pendingInbound(t)
  const name = t.isGroup ? (tone === 'short' ? '' : 'everyone') : counterpart(t)

  let kind: keyof typeof TEMPLATES
  if (!last || last.fromMe) kind = 'nudge'
  else {
    const text = pending.map((m) => m.body).join(' ')
    kind =
      detectIntent(text) ??
      (pending.some((m) => hasQuestion(m.body))
        ? 'question'
        : pending.some((m) => hasRequest(m.body))
          ? 'request'
          : isThanks(text)
            ? 'thanks'
            : 'default')
  }

  const sample = (last?.fromMe ? t.messages : pending).map((m) => m.body).join(' ')
  const local = isHinglish(sample) ? HINGLISH_TEMPLATES[kind]?.[tone] : undefined
  const options = local ?? TEMPLATES[kind][tone]
  return options[variant % options.length](name).replace(/\s+([,!?.])/g, '$1').replace(/\s{2,}/g, ' ')
}

/* ── Tasks ──────────────────────────────────────────────────────────────── */

function taskTitleFrom(body: string, phrases: string[]): string | null {
  const sentences = body.split(/(?<=[.!?\n])\s+/)
  let title = sentences.find((s) => phrases.some((p) => s.includes(p))) ?? body
  for (const phrase of phrases) title = title.replace(phrase, ' ')
  title = title
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\b(by|on|before|till|until|at|for)\s*(?=[?.!,]|$)/gi, '')
    .replace(/^\s*(also|and|so|hey|hi|hello|ok|okay|reminder|heads-up)\b[,:!\s-]*/gi, '')
    .replace(/^\s*(can|could|would) you\s+/i, '')
    .replace(/^\s*(please|pls|kindly)\s+/i, '')
    .replace(/[?!.]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[,:;-]+$/, '')
  if (title.split(' ').length < 2) return null
  return truncate(title.charAt(0).toUpperCase() + title.slice(1), 70)
}

export function heuristicTasks(t: AiThread, now: number, messages: AiMessage[] = t.messages): ExtractedTask[] {
  const tasks: ExtractedTask[] = []
  for (const m of messages) {
    // Only read what others asked for; a real model could also pick up my own promises.
    if (m.fromMe || now - toMs(m.sentAt) > 14 * DAY || isAckOnly(m.body)) continue
    const mention = findDateMention(m.body, toMs(m.sentAt))
    if (!mention || mention.at < now - DAY) continue
    const title = taskTitleFrom(m.body, mention.phrases)
    if (!title) continue
    tasks.push({
      id: `${m.id}#auto`,
      title,
      dueAt: new Date(mention.at).toISOString(),
      dueText: mention.phrases[0] ?? null,
      sourceMessageId: m.id,
    })
  }
  return tasks.slice(-5)
}
