/**
 * The single data-access module. Every read or write of chat data in the app goes through `api`.
 *
 * `api` merges every source the user has turned on: the demo inbox (./mock, generated relative to
 * now), a Telegram bot and a Matrix account (./connectors), and the WhatsApp and Telegram accounts
 * linked on the Sytext server once signed in (./server). See ./unified for how they combine.
 * Stores and components never import a source directly.
 */
import type { ConnectorId, ConnectorStatus, OlderMessages, SendOptions } from './connectors/types'
import type { MatrixLogin } from './connectors/matrix/matrixConnector'
import type {
  LinkedNetwork,
  PublicAccount,
  TelegramCodeResult,
  TelegramVerifyResult,
  WhatsAppLinkResult,
} from './server/types'
import type {
  ChatCapabilities,
  InboxEvent,
  InboxSnapshot,
  Message,
  MessageAction,
  NewTask,
  ScheduledMessage,
  SearchHit,
  Task,
  Thread,
  ReadOptions,
  ThreadStatePatch,
} from './types'
import { createUnifiedApi } from './unified/unifiedApi'

export type { ConnectorId, ConnectorStatus, LinkedNetwork, MatrixLogin, OlderMessages, PublicAccount, SendOptions }

export interface InboxApi {
  /** Initial sync: contacts, chats, recent messages, scheduled sends and tasks. */
  loadInbox(): Promise<InboxSnapshot>

  /** Sends a message and resolves with the stored copy (delivery receipts follow via `subscribe`). */
  sendMessage(threadId: string, body: string, options?: SendOptions): Promise<Message>

  /** Which of reply, react, typing and older history a chat supports. */
  capabilities(threadId: string): ChatCapabilities

  /** Sets my reaction to a message (one per person, as on WhatsApp); null removes it. */
  react(threadId: string, messageId: string, emoji: string | null): Promise<Message>

  /**
   * Edits, deletes (for everyone, or for me), pins or stars a message. Resolves with it as it is
   * now, or null once it's deleted for me.
   */
  actOnMessage(threadId: string, messageId: string, action: MessageAction): Promise<Message | null>

  /** Tells the chat I'm typing, or stopped. Best effort: never fails. */
  setTyping(threadId: string, typing: boolean): Promise<void>

  /** Messages from before `beforeId` (the earliest one loaded), oldest first. */
  loadOlder(threadId: string, beforeId: string): Promise<OlderMessages>

  /**
   * Clears the unread count, and sends a read receipt where the network has them. With
   * `receipt: false` (Incognito mode) nobody is told: only the unread count clears.
   */
  markRead(threadId: string, options?: ReadOptions): Promise<Thread>

  /** Done / snoozed state for the Needs-reply queue. */
  updateThreadState(threadId: string, patch: ThreadStatePatch): Promise<Thread>

  /** Archives a chat or brings it back: on WhatsApp and Telegram too, for linked chats. */
  archiveThread(threadId: string, archived: boolean): Promise<Thread>

  /** "Send later". Sent on time while the app is open; see ScheduledMessage.error otherwise. */
  scheduleMessage(threadId: string, body: string, sendAt: string): Promise<ScheduledMessage>
  cancelScheduled(scheduledId: string): Promise<void>
  sendScheduledNow(scheduledId: string): Promise<Message>

  /** Full-text search across every network. */
  searchMessages(query: string, options?: { limit?: number }): Promise<SearchHit[]>

  addTask(task: NewTask): Promise<Task>
  updateTask(taskId: string, patch: Partial<Pick<Task, 'title' | 'dueAt' | 'done'>>): Promise<Task>
  deleteTask(taskId: string): Promise<void>

  /** Push channel for changes that originate on the backend. Returns an unsubscribe function. */
  subscribe(listener: (event: InboxEvent) => void): () => void

  /** Accounts the inbox reads from. */
  connections: ConnectionsApi

  /** Controls for the demo inbox (reset it, simulate an incoming message). */
  demo?: {
    reset(): Promise<InboxSnapshot>
    simulateIncoming(): Promise<Message | null>
  }
}

export interface ConnectionsState {
  /** Whether the demo inbox is shown. */
  demo: boolean
  /** null when not connected. */
  telegram: ConnectorStatus | null
  matrix: ConnectorStatus | null
  /** While signed in to a Sytext server: the connection to it, and the accounts linked there. */
  server: {
    status: ConnectorStatus
    whatsapp: PublicAccount | null
    telegram: PublicAccount | null
  } | null
}

export interface ConnectionsApi {
  get(): ConnectionsState
  subscribe(listener: (state: ConnectionsState) => void): () => void
  setDemoEnabled(enabled: boolean): Promise<void>
  /** Checks the token with Telegram before saving it. Throws an Error with a readable message. */
  connectTelegram(input: { token: string; apiBase?: string }): Promise<void>
  /** Signs in before saving the session. Throws an Error with a readable message. */
  connectMatrix(login: MatrixLogin): Promise<void>
  /** Disconnects, and deletes the account's credentials and chats from this device. */
  disconnect(id: ConnectorId): Promise<void>
  /** Applies a fix a connector offers in its status (e.g. removing a Telegram webhook). */
  applyFix(id: ConnectorId, fixId: string): Promise<void>

  /**
   * Signing in to (or out of) the Sytext server: shows (or removes) the chats of the accounts
   * linked there. Signing out also clears what this device kept about them.
   */
  setServerSession(user: { id: string; name: string } | null): Promise<void>
  /** Called when the server says the session ended (expired, or signed out elsewhere). */
  onSignedOut(listener: () => void): () => void

  /** Starts linking WhatsApp: resolves with a code to type into WhatsApp, or a QR code. */
  linkWhatsApp(request: { method: 'code'; phone: string } | { method: 'qr' }): Promise<WhatsAppLinkResult>
  /** Fresh QR codes while linking by QR (they change every so often). */
  onLinkQr(listener: (network: LinkedNetwork, qr: string) => void): () => void
  /** Linking Telegram: Telegram sends a login code, then maybe asks for the 2-step password. */
  requestTelegramCode(phone: string): Promise<TelegramCodeResult>
  /** Or by QR, scanned in Telegram on a phone; the account's `step` then says what's next. */
  requestTelegramQr(): Promise<{ qr: string }>
  verifyTelegramCode(code: string): Promise<TelegramVerifyResult>
  verifyTelegramPassword(password: string): Promise<TelegramVerifyResult>
  /** Logs the server out of that account and deletes its chats there. */
  unlink(network: LinkedNetwork): Promise<void>
}

export const api: InboxApi = createUnifiedApi()
