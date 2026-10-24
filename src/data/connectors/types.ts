import type { ChatCapabilities, Contact, Message, MessageAction, ReadOptions, Thread } from '../types'

/**
 * A connector brings one real account into the inbox: a Telegram bot, a Matrix account (and,
 * through Matrix bridges, WhatsApp, Instagram, Slack, SMS…). The unified API (../unified) merges
 * every connector with the demo inbox and adds what networks don't have: done and snoozed state,
 * tasks, and scheduled sends.
 *
 * Ids are prefixed per connector ("tg:", "mx:") so any id can be routed back to its source.
 * Accounts linked on the Sytext server come in through one more connector (../server), with
 * "wa:" and "tga:" ids.
 */
export type ConnectorId = 'telegram' | 'matrix'

export interface ConnectorSnapshot {
  contacts: Contact[]
  /** doneAt and snoozedUntil are ignored: the unified API keeps those on this device. */
  threads: Thread[]
  messages: Message[]
  /** The account's own display name, when the network has one. */
  selfName?: string
}

export type ConnectorEvent =
  | { type: 'message.created'; message: Message }
  | { type: 'message.updated'; message: Message }
  | { type: 'thread.updated'; thread: Thread }
  | { type: 'contact.updated'; contact: Contact }
  | { type: 'typing'; threadId: string; senderId: string; active: boolean }
  /** Deleted for me: it goes from the chat. */
  | { type: 'message.deleted'; threadId: string; messageId: string }
  /** Many things changed at once (first sync, rooms joined or left): re-read the snapshot. */
  | { type: 'reloaded' }

export interface ConnectorStatus {
  state: 'connecting' | 'online' | 'error'
  /** Who we're connected as, e.g. "@mitti_bot" or "@aarav:example.org". */
  account?: string
  /** What's going on, in words for the user ("Syncing in another tab", or the error). */
  detail?: string
  /** A fix the user can approve from Settings. */
  fix?: { id: 'remove-webhook'; label: string }
}

export interface Connector {
  readonly id: ConnectorId | 'server'
  /** Everything known right now: cached on this device or synced so far. */
  snapshot(): ConnectorSnapshot
  /** Starts syncing in the background. */
  start(): void
  /** Stops syncing. The connector can be started again. */
  stop(): void
  sendMessage(threadId: string, body: string, options?: SendOptions): Promise<Message>
  /**
   * Clears the unread count, and tells the network where it can (unless `receipt` is false: then
   * nobody else is told). Resolves with the updated thread.
   */
  markRead(threadId: string, options?: ReadOptions): Promise<Thread | null>
  /** What this chat supports; connectors that leave this out support none of the extras. */
  capabilities?(threadId: string): ChatCapabilities
  /** Sets my reaction to a message, replacing any I had; null removes it. */
  react?(threadId: string, messageId: string, emoji: string | null): Promise<Message>
  /** Edits, deletes, pins or stars a message: the message as it is now, or null once deleted for me. */
  actOnMessage?(threadId: string, messageId: string, action: MessageAction): Promise<Message | null>
  setTyping?(threadId: string, typing: boolean): Promise<void>
  /** Archives a chat on the network itself. Chats of connectors without it are archived on the device. */
  archiveThread?(threadId: string, archived: boolean): Promise<Thread>
  /** Messages from before `beforeId`, oldest first. */
  loadOlder?(threadId: string, beforeId: string): Promise<OlderMessages>
  subscribe(listener: (event: ConnectorEvent) => void): () => void
  status(): ConnectorStatus
  onStatus(listener: (status: ConnectorStatus) => void): () => void
  /** Applies a fix offered in the status. */
  applyFix?(id: string): Promise<void>
  /** Signs out where that makes sense and deletes everything stored for this account. */
  forget(): Promise<void>
}

export interface SendOptions {
  /** The message this one replies to. */
  replyToId?: string
  /** A photo or file to send, with the text as its caption (where the chat can send files). */
  file?: File
}

export interface OlderMessages {
  messages: Message[]
  /** False once the start of the chat is reached. */
  hasMore: boolean
}

/** Small helper for the listener sets every connector keeps. */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>()

  on(listener: (value: T) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(value: T) {
    for (const listener of [...this.listeners]) listener(value)
  }
}
