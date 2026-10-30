/**
 * Domain model for the unified inbox.
 *
 * These types are what the UI consumes, independent of where the data comes from: the demo inbox
 * (./mock), a Telegram bot (./connectors/telegram) or a Matrix account (./connectors/matrix), where
 *   Thread  ← a room; bridged "portal" rooms carry the network they bridge (WhatsApp, Slack, …)
 *   Contact ← a room member; for bridges, the "ghost" user standing in for the remote person
 *   Message ← an m.room.message event
 */

export type NetworkId = 'whatsapp' | 'telegram' | 'instagram' | 'x' | 'slack' | 'sms' | 'matrix' | 'guffshuff'

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
  /** Profile picture. */
  avatarUrl?: string
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
  /** The group's picture (people's come from their contact). */
  avatarUrl?: string
  /**
   * Out of the lists, in Archived, until unarchived. Linked WhatsApp and Telegram chats are
   * archived on the network itself (and follow the phone); other chats, on this device.
   */
  archived?: boolean
  /**
   * Tags put on the chat by hand, kept with the account for linked chats (like done and snoozed).
   * The AI's own tags come from its classification instead, and both are shown together.
   */
  labels?: ChatLabel[]
  /**
   * The chat's tags are the user's own: the AI adds none to it. Set by "Clear all tags", so tags
   * someone cleared stay cleared, and turned off again from the same menu.
   */
  labelsLocked?: boolean
}

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'

export interface Attachment {
  /**
   * A sticker is a small picture shown on its own, without a bubble (a WebP image or WebM video).
   * Audio plays in the chat: a voice message, or an audio file.
   */
  kind: 'file' | 'image' | 'sticker' | 'audio'
  name: string
  size?: string
  /** Its type, like "image/jpeg" or "application/pdf", where the network says. */
  mime?: string
  /** Audio recorded in the chat (a voice message), rather than a music or audio file. */
  voice?: boolean
  /** How long the audio plays, in seconds, where the network says. */
  duration?: number
  /** A voice message's loudness over time, 0–100, as the network sends it for drawing its waveform. */
  waveform?: number[]
  /**
   * Where it can be viewed or downloaded. For linked chats it's a link on the Sytext server, which
   * fetches it from the network when it's opened.
   */
  url?: string
}

/** The message a reply quotes, as it was then (the original may not be loaded, or may be gone). */
export interface QuotedMessage {
  id: string
  senderId: string
  body: string
}

/** Everyone's reactions with one emoji. Each person has at most one reaction per message. */
export interface Reaction {
  emoji: string
  count: number
  /** Whether one of them is mine. */
  mine: boolean
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
  replyTo?: QuotedMessage
  reactions?: Reaction[]
  /**
   * Who reacted with what, where the network says (WhatsApp): sender id (ME_ID for me) to emoji.
   * Part of `reactions` when only some givers are known.
   */
  reactedBy?: Record<string, string>
  /** When it was last edited (by whoever wrote it). */
  editedAt?: string
  /** Deleted for everyone: shown as such, without its text or attachments. */
  deleted?: boolean
  /** Pinned in the chat: for everyone in it, where the network has pins. */
  pinned?: boolean
  /** When the pin ends by itself (WhatsApp pins last 24 hours, 7 days or 30 days). */
  pinnedUntil?: string
  /** Starred by me, to find again under Starred. */
  starred?: boolean
}

/**
 * Changing a message after it was sent. Editing and deleting for everyone are for my own messages;
 * deleting for me removes it from my side only.
 */
export type MessageAction =
  | { type: 'edit'; body: string }
  | { type: 'delete'; forEveryone: boolean }
  | { type: 'pin'; pinned: boolean }
  | { type: 'star'; starred: boolean }

/** A message as it is after `action`, for when only this device has it to change. */
export function withAction(message: Message, action: MessageAction, now = new Date()): Message {
  switch (action.type) {
    case 'edit':
      return { ...message, body: action.body, editedAt: now.toISOString() }
    case 'delete': {
      const { attachments, replyTo, reactions, ...rest } = message
      void attachments
      void replyTo
      void reactions
      return { ...rest, body: '', deleted: true }
    }
    case 'pin': {
      const { pinnedUntil, ...rest } = message
      void pinnedUntil
      return { ...rest, pinned: action.pinned || undefined }
    }
    case 'star':
      return { ...message, starred: action.starred || undefined }
  }
}

/** Pinned, and the pin hasn't run out. */
export const isPinned = (message: Message, now = Date.now()) =>
  !!message.pinned && !message.deleted && (!message.pinnedUntil || Date.parse(message.pinnedUntil) > now)

/** What a chat's network lets Sytext do, so only working actions are offered. */
export interface ChatCapabilities {
  reply: boolean
  react: boolean
  /** Shows when the other side is typing, and tells them when I am. */
  typing: boolean
  /** Can fetch messages from before the ones loaded. */
  history: boolean
  /** Can send photos and files. */
  files: boolean
  /** Can send a sticker, as the network's own sticker where it has them. */
  stickers: boolean
  /** Can edit my messages, delete them (for everyone, or for me), pin and star messages. */
  edit: boolean
  delete: boolean
  pin: boolean
  star: boolean
}

export const NO_CAPABILITIES: ChatCapabilities = {
  reply: false,
  react: false,
  typing: false,
  history: false,
  files: false,
  stickers: false,
  edit: false,
  delete: false,
  pin: false,
  star: false,
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

/** How a chat is marked read: `receipt: false` tells nobody (Incognito mode). */
export interface ReadOptions {
  receipt?: boolean
}

export interface ThreadStatePatch {
  doneAt?: string | null
  snoozedUntil?: string | null
  /** The tags chosen by hand for this chat (see Thread.labels). */
  labels?: ChatLabel[]
  /** Leave this chat's tags alone: the AI adds none (see Thread.labelsLocked). */
  labelsLocked?: boolean
}

/**
 * What a chat is about, or what it asks of the user: the AI gives these, and people can tag a chat
 * themselves. Shown next to its priority.
 */
export const CHAT_LABELS = [
  'question',
  'follow-up',
  'deadline',
  'payment',
  'order',
  'meeting',
  'work',
  'personal',
  'finance',
  'travel',
  'health',
  'shopping',
  'idea',
  'later',
  'promo',
  'fyi',
] as const
export type ChatLabel = (typeof CHAT_LABELS)[number]

/**
 * The tags a done chat keeps. Everything else — a question, a deadline, a payment — asked something
 * of the user, and once the chat is done it no longer does. Priority goes the same way: Normal and
 * Low stay, Urgent doesn't.
 */
export const CALM_LABELS: readonly ChatLabel[] = ['personal']

/** At most this many tags the AI may give a chat. */
export const MAX_LABELS = 3

/**
 * How sure the AI has to be before a tag is used. Anything less is left off: a chat with no tag
 * reads better than a chat with the wrong one.
 */
export const LABEL_CONFIDENCE = 0.65

/** What the AI says about one tag it considered: how sure, and why. */
export interface LabelCall {
  tag: ChatLabel
  /** 0 to 1. Below LABEL_CONFIDENCE the tag isn't used. */
  confidence: number
  /** A few words on why, shown when someone asks why a tag is there. */
  why?: string
}

/** At most this many tags someone may put on a chat themselves. */
export const MAX_OWN_LABELS = 5

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
  /** Deleted for me (here or on another device): it goes from the chat. */
  | { type: 'message.deleted'; threadId: string; messageId: string }
  | { type: 'thread.updated'; thread: Thread }
  | { type: 'contact.updated'; contact: Contact }
  /** Someone started or stopped typing. It also stops by itself after a few seconds. */
  | { type: 'typing'; threadId: string; senderId: string; active: boolean }
  | { type: 'scheduled.updated'; scheduled: ScheduledMessage }
  | { type: 'scheduled.removed'; scheduledId: string }
  /** A task changed on another device (tasks from linked chats are kept with the account). */
  | { type: 'task.updated'; task: Task }
  | { type: 'task.removed'; taskId: string }
  | { type: 'reset'; snapshot: InboxSnapshot }
