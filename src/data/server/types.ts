import type { Attachment, Contact, Message, MessageStatus, QuotedMessage, Reaction, Thread } from '../types'

/**
 * What the Sytext server and the web app send each other. The server (../../../server) imports
 * these too, so both sides agree.
 */

/** Chat networks linked on the server, as the user's own account. */
export type LinkedNetwork = 'whatsapp' | 'telegram'

export type AccountStatus = 'linking' | 'connected' | 'error' | 'disconnected'

/** A linked network as the browser sees it. "unlinked" is only ever sent, never stored. */
export interface PublicAccount {
  network: LinkedNetwork
  status: AccountStatus | 'unlinked'
  /** Who it's linked as: a phone number or @username. */
  label?: string
  /** What's going on, in words for the user. */
  detail?: string
  /** While linking: what the user is asked for next. */
  step?: 'code' | 'qr' | 'password'
  /** Telegram's hint for the two-step verification password. */
  hint?: string
}

/** The signed-in user. */
export interface PublicUser {
  id: string
  email: string
  name: string
  avatarUrl?: string
  hasPassword: boolean
  google: boolean
  /** When the current recovery key was made, if there is one. */
  recoveryKeyCreatedAt?: string
  /** Incognito mode: no read receipts and no "typing…" go out, from any device. */
  incognito?: boolean
}

export interface AuthResult {
  user: PublicUser
  /** Google was linked to an existing account by email, and its password was turned off. */
  passwordRemoved?: boolean
  /**
   * A new recovery key, shown to the user this once (the server keeps only its hash): on sign-up,
   * after a reset with the old one, or when they ask for a new one.
   */
  recoveryKey?: string
}

/**
 * Why the database in MONGODB_URI can't be used:
 * - unreachable: it refused the connection (with MongoDB Atlas: its IP Access List, or a paused cluster)
 * - auth: the username or password was rejected
 * - not-found: the cluster's name doesn't exist
 * - shared: the database belongs to another app
 */
export type DatabaseProblem = 'unreachable' | 'auth' | 'not-found' | 'shared' | 'other'

/** What this server has switched on. */
export interface ServerFeatures {
  googleClientId: string | null
  whatsapp: boolean
  telegram: boolean
  uploads: boolean
  /**
   * False while the server has no database at all: the site works, but signing in and linked
   * accounts don't. It keeps trying, so this turns true by itself once there is one.
   */
  database: boolean
  /**
   * "temporary" while the database in MONGODB_URI can't be reached and the server keeps accounts
   * in a private database of its own instead: everything works, but only until it restarts. Once
   * the real database answers, everything moves over to it by itself.
   */
  storage?: 'database' | 'temporary'
  /** Why the database in MONGODB_URI isn't in use, while it isn't. */
  databaseProblem?: DatabaseProblem
  /** The server offers its shared AI to everyone signed in. */
  ai?: boolean
}

/**
 * The server keeps only the latest messages of each chat, to hand them to the user's devices;
 * each device keeps its own copy of everything older, and anything older still comes from the
 * network when asked for. This keeps the server's database small however much people chat.
 */
export const MESSAGES_KEPT_PER_CHAT = 40

/**
 * The largest photo or file that can be sent from Sytext (the server holds it while passing it on
 * to WhatsApp or Telegram, which keep it). Received ones of any size can be downloaded.
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024

/** Sent as photos (anything else goes as a file): the types WhatsApp and Telegram both take as one. */
export const isPhotoType = (mime: string) => /^image\/(jpeg|png)$/.test(mime)

/** "2.4 MB", "830 KB": how big a file is, as attachments say (the server and the app alike). */
export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/** The longest caption a photo or file is sent with; longer text goes as a message of its own. */
export const MAX_CAPTION = 1024

/**
 * What a device knows about a message the server may no longer keep: enough for the network to
 * find it (to react to it, quote it or load what came before it).
 */
export interface MessageHint {
  id: string
  senderId: string
  sentAt: string
  body?: string
  /** With a pin or star of a message the server no longer keeps: what it showed, to keep a copy. */
  attachments?: Attachment[]
  replyTo?: QuotedMessage
  reactions?: Reaction[]
  reactedBy?: Record<string, string>
  editedAt?: string
  /** Delivery state of my own message. */
  status?: MessageStatus
}

/** Linked chats on load: every chat, and the latest messages of each (as many as the server keeps). */
export interface ServerInbox {
  threads: Thread[]
  contacts: Contact[]
  messages: Message[]
  /** Messages deleted for me lately, for devices that were away when it happened. */
  deleted?: string[]
  /**
   * Chats whose deletions from before a time are no longer all listed (too many, or too long
   * ago): a device last here before then starts its copy of that chat afresh from this one.
   */
  deletedSince?: Record<string, string>
  /** The server's time when this was taken, for the device to remember (see deletedSince). */
  at?: string
  accounts: PublicAccount[]
}

/** Pushed to a signed-in browser over server-sent events. */
export type ServerEvent =
  | { type: 'message.created'; message: Message }
  | { type: 'message.updated'; message: Message }
  /** Deleted for me, here or on the network: it goes from the chat. */
  | { type: 'message.deleted'; threadId: string; messageId: string }
  | { type: 'thread.updated'; thread: Thread }
  | { type: 'contact.updated'; contact: Contact }
  | { type: 'account.updated'; account: PublicAccount }
  /** A fresh QR code while linking by QR (a data: URL). */
  | { type: 'account.qr'; network: LinkedNetwork; qr: string }
  /** Someone started or stopped typing; it also stops by itself after a few seconds. */
  | { type: 'typing'; threadId: string; senderId: string; active: boolean }
  /** Many things changed at once (a history sync): fetch the inbox again. */
  | { type: 'reloaded' }
  /** The account itself changed (its name, Incognito mode…), on this device or another. */
  | { type: 'user.updated'; user: PublicUser }

/** Linking WhatsApp: the code to type into WhatsApp, or a QR code to scan. */
export type WhatsAppLinkResult = { code: string } | { qr: string }

/** Older messages of a chat, oldest first. */
export interface ServerOlderMessages {
  messages: Message[]
  hasMore: boolean
}

export type TelegramCodeResult = { via: 'app' | 'sms' }
export type TelegramVerifyResult = { status: 'connected' } | { status: 'password'; hint?: string }
