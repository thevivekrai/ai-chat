/**
 * The single data-access module. Every read or write of chat data in the app goes through `api`.
 *
 * Today it is backed by an in-browser mock (src/data/mock) that keeps a seeded inbox in
 * localStorage. To connect real networks, write another implementation of `InboxApi` (for example
 * one that talks to a Matrix homeserver running mautrix bridges) and change the last line of this
 * file. Stores and components never import from ./mock directly. See README → "Swapping the mock
 * API for real bridges".
 */
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
import { createMockApi } from './mock/mockApi'

export interface InboxApi {
  /** Initial sync: contacts, chats, recent messages, scheduled sends and tasks. */
  loadInbox(): Promise<InboxSnapshot>

  /** Sends a message and resolves with the stored copy (delivery receipts follow via `subscribe`). */
  sendMessage(threadId: string, body: string): Promise<Message>

  /** Clears the unread count (read receipt / read marker). */
  markRead(threadId: string): Promise<Thread>

  /** Done / snoozed state for the Needs-reply queue. */
  updateThreadState(threadId: string, patch: ThreadStatePatch): Promise<Thread>

  /** "Send later". The backend is responsible for sending it on time, even if the app is closed. */
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

  /** Prototype-only controls (reset data, simulate an incoming message). Real backends omit it. */
  demo?: {
    reset(): Promise<InboxSnapshot>
    simulateIncoming(): Promise<Message | null>
  }
}

export const api: InboxApi = createMockApi()
