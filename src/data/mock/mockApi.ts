import type { InboxApi } from '../api'
import { withMyReaction } from '../reactions'
import type { ChatCapabilities, InboxEvent, InboxSnapshot, Message, ScheduledMessage, Task, Thread } from '../types'
import { ME_ID, withAction } from '../types'
import { toMs } from '@/lib/time'
import { loadDb, saveDb, seedDb, type MockDb } from './db'
import { INCOMING_POOL } from './incoming'
import { searchMessages } from '../search'

const IS_TEST = import.meta.env.MODE === 'test'

/** Small fake network delay so loading states are real code paths, not hypotheticals. */
const latency = (ms = 120) => new Promise<void>((resolve) => setTimeout(resolve, IS_TEST ? 0 : ms))

const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

const clone = <T>(value: T): T => structuredClone(value)

/** A small file as a data URL, so the demo can keep it with its chats. */
const dataUrlOf = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the sticker."))
    reader.readAsDataURL(file)
  })

/** The demo shows replies, reactions and typing; it has no older history to fetch. */
const DEMO_CAPABILITIES: ChatCapabilities = {
  reply: true,
  react: true,
  typing: true,
  history: false,
  files: false,
  // The demo keeps a sticker it's sent as a picture in the chat, as the networks do.
  stickers: true,
  edit: true,
  delete: true,
  pin: true,
  star: true,
}

/** The demo inbox's backend: the inbox API minus account management, with its demo controls. */
export type DemoApi = Omit<InboxApi, 'connections' | 'demo'> & { demo: NonNullable<InboxApi['demo']> }

/** In-browser implementation of the inbox API backed by localStorage, seeded with demo chats. */
export function createMockApi(): DemoApi {
  let db: MockDb = loadDb()
  const listeners = new Set<(event: InboxEvent) => void>()
  let scheduler: ReturnType<typeof setInterval> | null = null

  const persist = () => saveDb(db)
  const emit = (event: InboxEvent) => listeners.forEach((listener) => listener(event))

  function snapshot(): InboxSnapshot {
    const { me, contacts, threads, messages, scheduled, tasks } = db
    return clone({ me, contacts, threads, messages, scheduled, tasks })
  }

  function findThread(threadId: string): Thread {
    const thread = db.threads.find((t) => t.id === threadId)
    if (!thread) throw new Error(`Unknown thread ${threadId}`)
    return thread
  }

  function appendMessage(message: Message) {
    db.messages.push(message)
    emit({ type: 'message.created', message: clone(message) })
  }

  function markDelivered(message: Message) {
    setTimeout(
      () => {
        message.status = 'delivered'
        persist()
        emit({ type: 'message.updated', message: clone(message) })
      },
      IS_TEST ? 0 : 1400,
    )
  }

  /** Sends any scheduled messages whose time has come (the mock's stand-in for a server job). */
  function deliverDueScheduled(now = Date.now()) {
    const due = db.scheduled.filter((s) => toMs(s.sendAt) <= now)
    if (due.length === 0) return
    for (const item of due) {
      db.scheduled = db.scheduled.filter((s) => s.id !== item.id)
      const message: Message = {
        id: newId('m'),
        threadId: item.threadId,
        senderId: ME_ID,
        body: item.body,
        sentAt: item.sendAt,
        status: 'sent',
      }
      emit({ type: 'scheduled.removed', scheduledId: item.id })
      appendMessage(message)
      markDelivered(message)
    }
    persist()
  }

  function updateTaskRecord(taskId: string, patch: Partial<Pick<Task, 'title' | 'dueAt' | 'done'>>): Task {
    const task = db.tasks.find((t) => t.id === taskId)
    if (!task) throw new Error(`Unknown task ${taskId}`)
    Object.assign(task, patch)
    persist()
    return clone(task)
  }

  return {
    async loadInbox() {
      await latency(260)
      deliverDueScheduled()
      return snapshot()
    },

    async sendMessage(threadId, body, options) {
      await latency(240)
      findThread(threadId)
      const quoted = options?.replyToId ? db.messages.find((m) => m.id === options.replyToId) : undefined
      const sticker = options?.sticker && options.file ? await dataUrlOf(options.file) : null
      const message: Message = {
        id: newId('m'),
        threadId,
        senderId: ME_ID,
        body,
        sentAt: new Date().toISOString(),
        status: 'sent',
        ...(sticker ? { attachments: [{ kind: 'sticker' as const, name: 'Sticker', mime: options!.file!.type, url: sticker }] } : {}),
        ...(quoted ? { replyTo: { id: quoted.id, senderId: quoted.senderId, body: quoted.body } } : {}),
      }
      db.messages.push(message)
      persist()
      markDelivered(message)
      return clone(message)
    },

    capabilities: () => DEMO_CAPABILITIES,

    // The demo's people all have a chat already; there's no one else to find.
    findPeople: async () => [],
    async startChat(contactId) {
      throw new Error(`No one to start a chat with (${contactId}) in the demo.`)
    },

    async react(threadId, messageId, emoji) {
      await latency(80)
      const message = db.messages.find((m) => m.id === messageId && m.threadId === threadId)
      if (!message) throw new Error(`Unknown message ${messageId}`)
      const reactions = withMyReaction(message.reactions, emoji)
      if (reactions.length) message.reactions = reactions
      else delete message.reactions
      persist()
      return clone(message)
    },

    async actOnMessage(threadId, messageId, action) {
      await latency(80)
      const index = db.messages.findIndex((m) => m.id === messageId && m.threadId === threadId)
      if (index < 0) throw new Error(`Unknown message ${messageId}`)
      const message = db.messages[index]
      const mine = message.senderId === ME_ID
      if (action.type === 'edit' && !mine) throw new Error('Only your own messages can be edited.')
      if (action.type === 'delete' && action.forEveryone && !mine) throw new Error('Only your own messages can be deleted for everyone.')
      if (action.type === 'delete' && !action.forEveryone) {
        db.messages.splice(index, 1)
        persist()
        return null
      }
      db.messages[index] = withAction(message, action)
      persist()
      return clone(db.messages[index])
    },

    async setTyping() {
      // Nobody on the other end of the demo.
    },

    async loadOlder() {
      return { messages: [], hasMore: false }
    },

    async markRead(threadId) {
      const thread = findThread(threadId)
      thread.unreadCount = 0
      persist()
      return clone(thread)
    },

    async updateThreadState(threadId, patch) {
      await latency(60)
      const thread = findThread(threadId)
      Object.assign(thread, patch)
      persist()
      return clone(thread)
    },

    async archiveThread(threadId, archived) {
      await latency(60)
      const thread = findThread(threadId)
      if (archived) thread.archived = true
      else delete thread.archived
      persist()
      return clone(thread)
    },

    async scheduleMessage(threadId, body, sendAt) {
      await latency(120)
      findThread(threadId)
      const item: ScheduledMessage = { id: newId('s'), threadId, body, sendAt, createdAt: new Date().toISOString() }
      db.scheduled.push(item)
      persist()
      return clone(item)
    },

    async cancelScheduled(scheduledId) {
      await latency(60)
      db.scheduled = db.scheduled.filter((s) => s.id !== scheduledId)
      persist()
    },

    async sendScheduledNow(scheduledId) {
      await latency(200)
      const item = db.scheduled.find((s) => s.id === scheduledId)
      if (!item) throw new Error(`Unknown scheduled message ${scheduledId}`)
      db.scheduled = db.scheduled.filter((s) => s.id !== scheduledId)
      const message: Message = {
        id: newId('m'),
        threadId: item.threadId,
        senderId: ME_ID,
        body: item.body,
        sentAt: new Date().toISOString(),
        status: 'sent',
      }
      db.messages.push(message)
      persist()
      markDelivered(message)
      return clone(message)
    },

    async searchMessages(query, options) {
      await latency(90)
      return searchMessages(db, query, options?.limit)
    },

    async addTask(input) {
      await latency(80)
      const task: Task = { id: newId('t'), done: false, createdAt: new Date().toISOString(), ...input }
      db.tasks.push(task)
      persist()
      return clone(task)
    },

    async updateTask(taskId, patch) {
      await latency(60)
      return updateTaskRecord(taskId, patch)
    },

    async deleteTask(taskId) {
      await latency(60)
      db.tasks = db.tasks.filter((t) => t.id !== taskId)
      persist()
    },

    subscribe(listener) {
      listeners.add(listener)
      if (!scheduler) scheduler = setInterval(() => deliverDueScheduled(), 5_000)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && scheduler) {
          clearInterval(scheduler)
          scheduler = null
        }
      }
    },

    demo: {
      async reset() {
        await latency(200)
        db = seedDb()
        persist()
        const snap = snapshot()
        emit({ type: 'reset', snapshot: clone(snap) })
        return snap
      },

      async simulateIncoming() {
        await latency(150)
        if (INCOMING_POOL.length === 0) return null
        const next = INCOMING_POOL[db.incomingCursor % INCOMING_POOL.length]
        db.incomingCursor += 1
        const thread = findThread(next.threadId)
        // They type for a moment first, as people do.
        emit({ type: 'typing', threadId: next.threadId, senderId: next.senderId, active: true })
        await latency(1800)
        emit({ type: 'typing', threadId: next.threadId, senderId: next.senderId, active: false })
        const message: Message = {
          id: newId('m'),
          threadId: next.threadId,
          senderId: next.senderId,
          body: next.body,
          sentAt: new Date().toISOString(),
        }
        thread.unreadCount += 1
        // A new message brings a snoozed chat straight back, like most inboxes do.
        thread.snoozedUntil = null
        appendMessage(message)
        emit({ type: 'thread.updated', thread: clone(thread) })
        persist()
        return clone(message)
      },
    },
  }
}
