import type { NetworkId } from '@/data/types'

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

export interface PriorityResult {
  priority: Priority
  /** Whether the latest messages expect something from me. Drives the Needs-reply queue. */
  expectsReply: boolean
  /** One short sentence shown in the AI panel. */
  reason: string
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
  threadTitle?: string
  messageId?: string
}

export interface SearchAnswer {
  /** May contain **bold** spans. */
  answer: string
  citedMessageIds: string[]
}
