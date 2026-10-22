import { create } from 'zustand'
import { api, type SendOptions } from '@/data/api'
import { withMyReaction } from '@/data/reactions'
import type {
  Contact,
  InboxEvent,
  InboxSnapshot,
  Me,
  Message,
  NewTask,
  ScheduledMessage,
  Task,
  Thread,
  ThreadStatePatch,
} from '@/data/types'
import { ME_ID } from '@/data/types'
import { toMs } from '@/lib/time'

/**
 * Client-side cache of the inbox. All reads come from `api.loadInbox()` and all writes go through
 * `api`; this store never persists chat data itself (the data layer owns that).
 */
interface InboxState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  me: Me
  contacts: Record<string, Contact>
  threads: Record<string, Thread>
  /** Per thread, oldest first. */
  messages: Record<string, Message[]>
  scheduled: ScheduledMessage[]
  tasks: Task[]
  /** Who is typing, per chat (contact ids). */
  typing: Record<string, string[]>
  /** Paging back through a chat: whether there's more, and whether a page is on its way. */
  history: Record<string, { loading: boolean; hasMore: boolean; error?: string }>

  /** Loads the inbox and subscribes to backend events. Returns an unsubscribe function. */
  connect(): () => void
  /** Drops everything loaded (on sign-out), so the next `connect` starts fresh. */
  clear(): void
  /** Loads (or reloads) the inbox snapshot. */
  load(): Promise<void>
  applyEvent(event: InboxEvent): void
  sendMessage(threadId: string, body: string, options?: SendOptions): Promise<void>
  /** Sets my reaction (null removes it); shown at once, undone if the network refuses. */
  react(threadId: string, messageId: string, emoji: string | null): Promise<void>
  /** Loads the page of messages before the earliest one loaded. */
  loadOlder(threadId: string): Promise<void>
  /** Sends a failed message again. */
  retryMessage(threadId: string, messageId: string): Promise<void>
  markRead(threadId: string): void
  /** Updates done/snoozed state and returns the previous state, for undo. */
  setThreadState(threadId: string, patch: ThreadStatePatch): Promise<ThreadStatePatch>
  scheduleMessage(threadId: string, body: string, sendAt: string): Promise<void>
  cancelScheduled(scheduledId: string): Promise<void>
  sendScheduledNow(scheduledId: string): Promise<void>
  addTask(task: NewTask): Promise<Task>
  setTaskDone(taskId: string, done: boolean): Promise<void>
  deleteTask(taskId: string): Promise<void>
  resetDemo(): Promise<void>
  simulateIncoming(): Promise<Message | null>
}

const byId = <T extends { id: string }>(items: T[]) => Object.fromEntries(items.map((i) => [i.id, i]))

/** Typing notices end by themselves after this long without a renewal, as on the networks. */
const TYPING_LASTS_MS = 6000
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>()

function groupMessages(messages: Message[]): Record<string, Message[]> {
  const grouped: Record<string, Message[]> = {}
  for (const m of messages) (grouped[m.threadId] ??= []).push(m)
  for (const list of Object.values(grouped)) list.sort((a, b) => toMs(a.sentAt) - toMs(b.sentAt))
  return grouped
}

function fromSnapshot(s: InboxSnapshot) {
  return {
    me: s.me,
    contacts: byId(s.contacts),
    threads: byId(s.threads),
    messages: groupMessages(s.messages),
    scheduled: s.scheduled,
    tasks: s.tasks,
  }
}

/** Inserts or replaces a message, keeping the list in time order. */
function upsertMessage(list: Message[] = [], message: Message, replaceId = message.id): Message[] {
  const next = list.filter((m) => m.id !== replaceId && m.id !== message.id)
  const at = toMs(message.sentAt)
  const index = next.findIndex((m) => toMs(m.sentAt) > at)
  next.splice(index === -1 ? next.length : index, 0, message)
  return next
}

export const useInbox = create<InboxState>()((set, get) => {
  const patchThread = (thread: Thread) => set((s) => ({ threads: { ...s.threads, [thread.id]: thread } }))
  const setTyping = (threadId: string, senderId: string, active: boolean) => {
    const key = `${threadId}\n${senderId}`
    clearTimeout(typingTimers.get(key))
    typingTimers.delete(key)
    if (active) typingTimers.set(key, setTimeout(() => setTyping(threadId, senderId, false), TYPING_LASTS_MS))
    set((s) => {
      const now = s.typing[threadId] ?? []
      if (now.includes(senderId) === active) return {}
      const next = active ? [...now, senderId] : now.filter((id) => id !== senderId)
      const typing = { ...s.typing }
      if (next.length) typing[threadId] = next
      else delete typing[threadId]
      return { typing }
    })
  }
  const putMessage = (message: Message, replaceId?: string) =>
    set((s) => ({
      messages: { ...s.messages, [message.threadId]: upsertMessage(s.messages[message.threadId], message, replaceId) },
    }))

  return {
    status: 'idle',
    error: null,
    me: { id: ME_ID, name: 'Me' },
    contacts: {},
    threads: {},
    messages: {},
    scheduled: [],
    tasks: [],
    typing: {},
    history: {},

    connect() {
      const unsubscribe = api.subscribe((event) => get().applyEvent(event))
      // Always from a fresh snapshot: who's signed in may have changed since the last time.
      if (get().status !== 'loading') void get().load()
      return unsubscribe
    },

    clear() {
      set({
        status: 'idle',
        error: null,
        me: { id: ME_ID, name: 'Me' },
        contacts: {},
        threads: {},
        messages: {},
        scheduled: [],
        tasks: [],
        typing: {},
        history: {},
      })
    },

    async load() {
      set({ status: 'loading', error: null })
      try {
        set({ status: 'ready', ...fromSnapshot(await api.loadInbox()) })
      } catch (error) {
        set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    },

    applyEvent(event) {
      switch (event.type) {
        case 'message.created':
          // Whoever was typing has sent it.
          setTyping(event.message.threadId, event.message.senderId, false)
          putMessage(event.message)
          break
        case 'message.updated':
          putMessage(event.message)
          break
        case 'typing':
          setTyping(event.threadId, event.senderId, event.active)
          break
        case 'thread.updated':
          patchThread(event.thread)
          break
        case 'contact.updated':
          set((s) => ({ contacts: { ...s.contacts, [event.contact.id]: event.contact } }))
          break
        case 'scheduled.updated':
          set((s) => ({
            scheduled: s.scheduled.some((x) => x.id === event.scheduled.id)
              ? s.scheduled.map((x) => (x.id === event.scheduled.id ? event.scheduled : x))
              : [...s.scheduled, event.scheduled],
          }))
          break
        case 'scheduled.removed':
          set((s) => ({ scheduled: s.scheduled.filter((x) => x.id !== event.scheduledId) }))
          break
        case 'reset':
          // A reload keeps older pages already fetched, so scrolling back isn't lost.
          set((s) => {
            const next = fromSnapshot(event.snapshot)
            for (const [threadId, list] of Object.entries(s.messages)) {
              const fresh = next.messages[threadId]
              if (!fresh?.length || !s.history[threadId]) continue
              const earliest = toMs(fresh[0].sentAt)
              const kept = list.filter((m) => toMs(m.sentAt) < earliest)
              next.messages[threadId] = [...kept, ...fresh]
            }
            return { status: 'ready', ...next }
          })
          break
      }
    },

    async sendMessage(threadId, body, options) {
      // Optimistic: the message shows up (and the thread leaves "Needs reply") immediately.
      const tempId = `pending-${Date.now()}`
      const quoted = options?.replyToId ? get().messages[threadId]?.find((m) => m.id === options.replyToId) : undefined
      putMessage({
        id: tempId,
        threadId,
        senderId: ME_ID,
        body,
        sentAt: new Date().toISOString(),
        status: 'sending',
        ...(quoted ? { replyTo: { id: quoted.id, senderId: quoted.senderId, body: quoted.body } } : {}),
      })
      try {
        putMessage(await api.sendMessage(threadId, body, options), tempId)
      } catch (error) {
        const failed = get().messages[threadId]?.find((m) => m.id === tempId)
        if (failed) {
          putMessage({ ...failed, status: 'failed', error: error instanceof Error ? error.message : 'Not sent' })
        }
      }
    },

    async retryMessage(threadId, messageId) {
      const failed = get().messages[threadId]?.find((m) => m.id === messageId && m.status === 'failed')
      if (!failed) return
      set((s) => ({ messages: { ...s.messages, [threadId]: s.messages[threadId].filter((m) => m.id !== messageId) } }))
      await get().sendMessage(threadId, failed.body, failed.replyTo ? { replyToId: failed.replyTo.id } : undefined)
    },

    async react(threadId, messageId, emoji) {
      const before = get().messages[threadId]?.find((m) => m.id === messageId)
      if (!before) return
      const reactions = withMyReaction(before.reactions, emoji)
      putMessage({ ...before, reactions })
      try {
        putMessage(await api.react(threadId, messageId, emoji))
      } catch (error) {
        // Put it back the way it was; the caller says why.
        const now = get().messages[threadId]?.find((m) => m.id === messageId)
        if (now) putMessage({ ...now, reactions: before.reactions })
        throw error
      }
    },

    async loadOlder(threadId) {
      const state = get().history[threadId]
      const earliest = get().messages[threadId]?.[0]
      if (state?.loading || state?.hasMore === false || !earliest) return
      const setHistory = (patch: { loading: boolean; hasMore: boolean; error?: string }) =>
        set((s) => ({ history: { ...s.history, [threadId]: patch } }))
      setHistory({ loading: true, hasMore: true })
      try {
        const { messages, hasMore } = await api.loadOlder(threadId, earliest.id)
        set((s) => {
          let list = s.messages[threadId] ?? []
          for (const m of messages) list = upsertMessage(list, m)
          return { messages: { ...s.messages, [threadId]: list } }
        })
        setHistory({ loading: false, hasMore })
      } catch (error) {
        setHistory({ loading: false, hasMore: true, error: error instanceof Error ? error.message : 'Couldn\'t load more.' })
      }
    },

    markRead(threadId) {
      const thread = get().threads[threadId]
      if (!thread || thread.unreadCount === 0) return
      patchThread({ ...thread, unreadCount: 0 })
      void api.markRead(threadId)
    },

    async setThreadState(threadId, patch) {
      const thread = get().threads[threadId]
      const previous = { doneAt: thread.doneAt, snoozedUntil: thread.snoozedUntil }
      patchThread({ ...thread, ...patch })
      patchThread(await api.updateThreadState(threadId, patch))
      return previous
    },

    async scheduleMessage(threadId, body, sendAt) {
      const item = await api.scheduleMessage(threadId, body, sendAt)
      set((s) => ({ scheduled: [...s.scheduled, item] }))
    },

    async cancelScheduled(scheduledId) {
      set((s) => ({ scheduled: s.scheduled.filter((x) => x.id !== scheduledId) }))
      await api.cancelScheduled(scheduledId)
    },

    async sendScheduledNow(scheduledId) {
      set((s) => ({ scheduled: s.scheduled.filter((x) => x.id !== scheduledId) }))
      try {
        putMessage(await api.sendScheduledNow(scheduledId))
      } catch {
        // The API puts the message back with the reason it wasn't sent (a scheduled.updated event).
      }
    },

    async addTask(input) {
      const task = await api.addTask(input)
      set((s) => ({ tasks: [...s.tasks, task] }))
      return task
    },

    async setTaskDone(taskId, done) {
      set((s) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, done } : t)) }))
      await api.updateTask(taskId, { done })
    },

    async deleteTask(taskId) {
      set((s) => ({ tasks: s.tasks.filter((t) => t.id !== taskId) }))
      await api.deleteTask(taskId)
    },

    async resetDemo() {
      if (!api.demo) return
      set({ status: 'ready', ...fromSnapshot(await api.demo.reset()) })
    },

    async simulateIncoming() {
      return (await api.demo?.simulateIncoming()) ?? null
    },
  }
})


/** Latest message whose content is settled (not still sending): what AI results are keyed on. */
export function settledLastMessageId(messages: Message[] | undefined): string | null {
  if (!messages) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].status !== 'sending') return messages[i].id
  }
  return null
}
