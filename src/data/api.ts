/**
 * The single data-access module. Every read or write of chat data in the app goes through `api`.
 *
 * `api` merges every source the user has turned on: the demo inbox (./mock, generated relative to
 * now), a Telegram bot and a Matrix account (./connectors). See ./unified for how they combine.
 * Stores and components never import a source directly.
 */
import type { ConnectorId, ConnectorStatus } from './connectors/types'
import type { MatrixLogin } from './connectors/matrix/matrixConnector'
import type {
  InboxEvent,
  InboxSnapshot,
  Message,
  NewTask,
  ScheduledMessage,
  SearchHit,
  Task,
  Thread,
  ThreadStatePatch,
} from './types'
import { createUnifiedApi } from './unified/unifiedApi'

export type { ConnectorId, ConnectorStatus, MatrixLogin }

export interface InboxApi {
  /** Initial sync: contacts, chats, recent messages, scheduled sends and tasks. */
  loadInbox(): Promise<InboxSnapshot>

  /** Sends a message and resolves with the stored copy (delivery receipts follow via `subscribe`). */
  sendMessage(threadId: string, body: string): Promise<Message>

  /** Clears the unread count (read receipt / read marker). */
  markRead(threadId: string): Promise<Thread>

  /** Done / snoozed state for the Needs-reply queue. */
  updateThreadState(threadId: string, patch: ThreadStatePatch): Promise<Thread>

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
}

export const api: InboxApi = createUnifiedApi()
