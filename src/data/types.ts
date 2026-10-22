/**
 * Domain model for the unified inbox.
 *
 * These types are what the UI consumes, independent of where the data comes from: the demo inbox
 * (./mock), a Telegram bot (./connectors/telegram) or a Matrix account (./connectors/matrix), where
 *   Thread  ← a room; bridged "portal" rooms carry the network they bridge (WhatsApp, Slack, …)
 *   Contact ← a room member; for bridges, the "ghost" user standing in for the remote person
 *   Message ← an m.room.message event
 */

export type NetworkId = 'whatsapp' | 'telegram' | 'instagram' | 'slack' | 'sms' | 'matrix'

/** Sender id used for messages written by the person using the app. */
export const ME_ID = 'me'

export interface Me {
  id: typeof ME_ID
  name: string
}

export interface Contact {
  id: string
  name: string
  network: NetworkId
  /** Phone number, @username or workspace handle, as the network shows it. */
  handle: string
  /** User-assigned tag such as "Customer" or "Supplier". Helps search and prioritisation. */
  label?: string
  /** Business or organisation the contact speaks for. */
  org?: string
}

export type ThreadKind = 'direct' | 'group'

export interface Thread {
  id: string
  network: NetworkId
  kind: ThreadKind
  title: string
  /** Everyone in the chat except me. */
  participantIds: string[]
  unreadCount: number
  /**
   * When the thread was last cleared from the "Needs reply" queue. A newer incoming message brings
   * it back, so this is a timestamp rather than a boolean.
   */
  doneAt: string | null
  /** Hidden from the queue until this time. */
  snoozedUntil: string | null
}

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'

export interface Attachment {
  kind: 'file' | 'image'
  name: string
  size?: string
  /** Where the file can be viewed, once it has been copied off the network (images only). */
  url?: string
}

export interface Message {
  id: string
  threadId: string
  /** ME_ID or a contact id. */
  senderId: string
  body: string
  /** ISO 8601. */
  sentAt: string
  /** Delivery state, only for messages I sent. */
  status?: MessageStatus
  /** Why a message I sent failed, in words for the user. */
  error?: string
  attachments?: Attachment[]
}

/** A reply written now and sent later ("Send later"). */
export interface ScheduledMessage {
  id: string
  threadId: string
  body: string
  sendAt: string
  createdAt: string
  /** Set when sending failed or was skipped; the message waits for the user to retry or cancel. */
  error?: string
}

export interface Task {
  id: string
  title: string
  dueAt: string | null
  done: boolean
  createdAt: string
  /** Where the task came from, when it was added from a chat. */
  source?: { threadId: string; messageId: string }
}

export interface NewTask {
  title: string
  dueAt: string | null
  source?: { threadId: string; messageId: string }
}

/** Everything the inbox needs on startup. */
export interface InboxSnapshot {
  me: Me
  contacts: Contact[]
  threads: Thread[]
  /** All loaded messages, oldest first. */
  messages: Message[]
  scheduled: ScheduledMessage[]
  tasks: Task[]
}

export interface ThreadStatePatch {
  doneAt?: string | null
  snoozedUntil?: string | null
}

export interface SearchHit {
  messageId: string
  threadId: string
  score: number
  /** Words in the message body that matched, for highlighting. */
  matchedWords: string[]
}

/** Changes pushed by the backend (new messages, delivery receipts, scheduled sends…). */
export type InboxEvent =
  | { type: 'message.created'; message: Message }
  | { type: 'message.updated'; message: Message }
  | { type: 'thread.updated'; thread: Thread }
  | { type: 'contact.updated'; contact: Contact }
  | { type: 'scheduled.updated'; scheduled: ScheduledMessage }
  | { type: 'scheduled.removed'; scheduledId: string }
  | { type: 'reset'; snapshot: InboxSnapshot }
