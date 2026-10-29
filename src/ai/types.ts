import type { ChatLabel, LabelCall, NetworkId } from '../data/types'

export type Priority = 'urgent' | 'normal' | 'low'
export type Tone = 'short' | 'friendly' | 'professional'

export const TONES: Tone[] = ['short', 'friendly', 'professional']

/**
 * Exactly what an AI function gets to see about a chat. Keeping this explicit makes the privacy
 * story auditable: when a real model is connected, this object is the payload that leaves the app.
 */
export interface AiThread {
  id: string
  title: string
  network: NetworkId
  isGroup: boolean
  me: { name: string }
  participants: AiParticipant[]
  /** Oldest first. */
  messages: AiMessage[]
}

export interface AiParticipant {
  id: string
  name: string
  label?: string
  org?: string
}

export interface AiMessage {
  id: string
  senderId: string
  senderName: string
  fromMe: boolean
  body: string
  sentAt: string
  attachments?: string[]
}

// Relative, not '@/': the server loads this file directly, where that alias isn't resolved.
export { CALM_LABELS, CHAT_LABELS, LABEL_CONFIDENCE, MAX_LABELS, type ChatLabel, type LabelCall } from '../data/types'

/**
 * How much of a chat is read before it is tagged or sorted. The messages that still want a reply
 * are rarely the last two: what came before them is what says whether it's a payment, a plan or a
 * complaint.
 */
export const TAGGING_WINDOW = 30

export interface PriorityResult {
  priority: Priority
  /** Whether the latest messages expect something from me. Drives the Needs-reply queue. */
  expectsReply: boolean
  /** One short sentence shown in the AI panel. */
  reason: string
  /** The tags that are used: sure enough, most sure first. Older results have none. */
  labels?: ChatLabel[]
  /** Every tag the AI considered, with how sure it was and why — shown when someone asks. */
  labelCalls?: LabelCall[]
  /** What this answer came from, to tell later why a chat got the tags it did. */
  audit?: TagAudit
}

/**
 * The record kept of each tagging run: which model, given which prompt and which messages, said
 * what. The same model, prompt and messages give the same tags, so a wrong tag can be traced.
 */
export interface TagAudit {
  model: string
  /** A short hash of the exact prompt sent (or of the rules' version, for the demo AI). */
  promptHash: string
  /** The messages it read, oldest first. */
  messageIds: string[]
  /** The model's answer as it came back, before unsure tags were dropped. */
  raw: string
  /** When it ran. */
  at: string
}

/**
 * What a model answers for a chat's priority: the same, except that its tags still carry their
 * confidence. `classifyPriority` turns this into a `PriorityResult`, dropping unsure tags.
 */
export interface PriorityCall extends Omit<PriorityResult, 'labels' | 'labelCalls'> {
  labels: LabelCall[]
}

export interface ThreadSummary {
  oneLine: string
  /** Key points, used by "Summarize" in group chats. */
  bullets: string[]
}

export interface ExtractedTask {
  id: string
  title: string
  /** ISO timestamp, or null when no date was mentioned. */
  dueAt: string | null
  /** The words in the message that set the date ("by Friday"), for highlighting. */
  dueText: string | null
  sourceMessageId: string
}

export interface DraftReply {
  tone: Tone
  text: string
}

/** A message offered to `answerQuestion` as evidence. */
export interface AiSearchSource {
  messageId: string
  threadId: string
  threadTitle: string
  network: NetworkId
  senderName: string
  fromMe: boolean
  body: string
  sentAt: string
}

/** An open task, for questions about tasks ("what are my tasks for today?"). */
export interface AiTask {
  title: string
  dueAt: string | null
  /** The chat it was found in, and the message, when it came from one (not added by hand). */
  threadId?: string
  threadTitle?: string
  messageId?: string
}

export interface SearchAnswer {
  /** May contain **bold** spans. */
  answer: string
  citedMessageIds: string[]
}
