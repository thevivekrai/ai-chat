import type { Contact, Message, Thread } from '../types'

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
}

/** The signed-in user. */
export interface PublicUser {
  id: string
  email: string
  name: string
  avatarUrl?: string
  hasPassword: boolean
  google: boolean
}

export interface AuthResult {
  user: PublicUser
  /** Google was linked to an existing account by email, and its password was turned off. */
  passwordRemoved?: boolean
}

/** What this server has switched on. */
export interface ServerFeatures {
  googleClientId: string | null
  whatsapp: boolean
  telegram: boolean
  uploads: boolean
}

/** Linked chats on load. */
export interface ServerInbox {
  threads: Thread[]
  contacts: Contact[]
  messages: Message[]
  accounts: PublicAccount[]
}

/** Pushed to a signed-in browser over server-sent events. */
export type ServerEvent =
  | { type: 'message.created'; message: Message }
  | { type: 'message.updated'; message: Message }
  | { type: 'thread.updated'; thread: Thread }
  | { type: 'contact.updated'; contact: Contact }
  | { type: 'account.updated'; account: PublicAccount }
  /** A fresh QR code while linking WhatsApp by QR (a data: URL). */
  | { type: 'account.qr'; network: 'whatsapp'; qr: string }
  /** Many things changed at once (a history sync): fetch the inbox again. */
  | { type: 'reloaded' }

/** Linking WhatsApp: the code to type into WhatsApp, or a QR code to scan. */
export type WhatsAppLinkResult = { code: string } | { qr: string }

export type TelegramCodeResult = { via: 'app' | 'sms' }
export type TelegramVerifyResult = { status: 'connected' } | { status: 'password'; hint?: string }
