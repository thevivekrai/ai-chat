import type { Contact, Message, Thread } from '../types'

/**
 * This device's copy of the chats from linked accounts, in the browser's IndexedDB.
 *
 * The server keeps only the latest messages of each chat (MESSAGES_KEPT_PER_CHAT), to hand them
 * to the user's devices. Everything older that this device has seen stays here, so history builds
 * up on the user's own devices rather than in the server's database; anything older still is
 * fetched from the network when the user scrolls back. Signing out deletes it.
 */
export interface DeviceCopy {
  threads: Thread[]
  contacts: Contact[]
  messages: Message[]
}

export interface DeviceStore {
  /** Every chat and contact, and the latest `perChat` messages of each chat. */
  load(perChat: number): Promise<DeviceCopy>
  /** Up to `limit` messages of a chat sent before `beforeSentAt`, newest first. */
  older(threadId: string, beforeSentAt: string, limit: number): Promise<Message[]>
  /** Saves changes; they're written shortly after, together. */
  put(change: Partial<DeviceCopy>): void
  /** Forgets chats, with their messages, and contacts. */
  remove(change: { threadIds?: string[]; contactIds?: string[]; messageIds?: string[] }): void
  /** Forgets every message of a chat but `keep`: its copy here starts afresh. */
  forget(threadId: string, keep: Set<string>): Promise<void>
  /** When this device last had the server's copy (the server's time), if it has. */
  lastHere(): Promise<string | null>
  setLastHere(at: string): void
  /** Writes whatever is waiting to be written. */
  flush(): Promise<void>
  /** Deletes this device's copy. */
  clear(): Promise<void>
}

const DB_NAME = 'sytext-chats'
const WRITE_DELAY_MS = 250

/** Opens the copy for one signed-in user; a copy left by someone else is deleted first. */
export async function openDeviceStore(owner: string): Promise<DeviceStore> {
  if (typeof indexedDB === 'undefined') return memoryDeviceStore()
  try {
    const db = await openDb()
    if ((await request<string | undefined>(db.transaction('meta').objectStore('meta').get('owner'))) !== owner) {
      const tx = db.transaction(['meta', 'threads', 'contacts', 'messages'], 'readwrite')
      for (const name of ['threads', 'contacts', 'messages']) tx.objectStore(name).clear()
      tx.objectStore('meta').put(owner, 'owner')
      await done(tx)
    }
    // Asks the browser not to clear it when space runs low (it may still, if the user does).
    void navigator.storage?.persist?.().catch(() => false)
    return indexedDbStore(db)
  } catch (error) {
    // Private browsing in some browsers, or storage switched off: this session only.
    console.warn('[device] Keeping chats in memory only:', error)
    return memoryDeviceStore()
  }
}

/** Deletes any copy on this device, e.g. when the session ended while the app was closed. */
export async function wipeDeviceStore(): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = req.onerror = req.onblocked = () => resolve()
  })
}

/** How much this site stores on the device, in bytes, where the browser says. */
export async function deviceUsage(): Promise<number | null> {
  try {
    return (await navigator.storage?.estimate?.())?.usage ?? null
  } catch {
    return null
  }
}

/* ── IndexedDB ────────────────────────────────────────────────────────────────── */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('meta')
      db.createObjectStore('threads', { keyPath: 'id' })
      db.createObjectStore('contacts', { keyPath: 'id' })
      db.createObjectStore('messages', { keyPath: 'id' }).createIndex('byThread', ['threadId', 'sentAt'])
    }
    req.onsuccess = () => {
      // Another tab is deleting it (signing out): let go, so that can finish.
      req.result.onversionchange = () => req.result.close()
      resolve(req.result)
    }
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('The chat store is open in an older version of the app.'))
  })
}

function request<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error)
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Not saved'))
  })
}

/** Messages of a chat from newest back, up to `limit`, sent before `before` (ISO times sort as text). */
function newestFirst(messages: IDBObjectStore, threadId: string, before: string, limit: number): Promise<Message[]> {
  return new Promise((resolve, reject) => {
    const found: Message[] = []
    const range = IDBKeyRange.bound([threadId, ''], [threadId, before], false, true)
    const req = messages.index('byThread').openCursor(range, 'prev')
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor || found.length >= limit) return resolve(found)
      found.push(cursor.value as Message)
      cursor.continue()
    }
    req.onerror = () => reject(req.error)
  })
}

/** Later than any time a message can carry. */
const END = '￿'

function indexedDbStore(db: IDBDatabase): DeviceStore {
  const pending = { threads: new Map<string, Thread>(), contacts: new Map<string, Contact>(), messages: new Map<string, Message>() }
  const removed = { threads: new Set<string>(), contacts: new Set<string>(), messages: new Set<string>() }
  let timer: ReturnType<typeof setTimeout> | null = null
  let writing: Promise<void> = Promise.resolve()
  let closed = false

  const schedule = () => {
    if (!timer && !closed) timer = setTimeout(() => void store.flush(), WRITE_DELAY_MS)
  }

  async function write() {
    const change = {
      threads: [...pending.threads.values()],
      contacts: [...pending.contacts.values()],
      messages: [...pending.messages.values()],
      removedThreads: [...removed.threads],
      removedContacts: [...removed.contacts],
      removedMessages: [...removed.messages],
    }
    pending.threads.clear()
    pending.contacts.clear()
    pending.messages.clear()
    removed.threads.clear()
    removed.contacts.clear()
    removed.messages.clear()
    if (closed || Object.values(change).every((list) => list.length === 0)) return

    const tx = db.transaction(['threads', 'contacts', 'messages'], 'readwrite')
    const [threads, contacts, messages] = (['threads', 'contacts', 'messages'] as const).map((name) => tx.objectStore(name))
    for (const thread of change.threads) threads.put(thread)
    for (const contact of change.contacts) contacts.put(contact)
    for (const message of change.messages) messages.put(message)
    for (const id of change.removedContacts) contacts.delete(id)
    for (const id of change.removedMessages) messages.delete(id)
    for (const id of change.removedThreads) {
      threads.delete(id)
      const cursor = messages.index('byThread').openKeyCursor(IDBKeyRange.bound([id, ''], [id, END]))
      cursor.onsuccess = () => {
        if (!cursor.result) return
        messages.delete(cursor.result.primaryKey)
        cursor.result.continue()
      }
    }
    await done(tx)
  }

  const store: DeviceStore = {
    async load(perChat) {
      await store.flush()
      const tx = db.transaction(['threads', 'contacts'])
      const [threads, contacts] = await Promise.all([
        request<Thread[]>(tx.objectStore('threads').getAll()),
        request<Contact[]>(tx.objectStore('contacts').getAll()),
      ])
      // Every chat's messages are read in one go, in a transaction of their own.
      const messages = db.transaction('messages').objectStore('messages')
      const perThread = await Promise.all(threads.map((t) => newestFirst(messages, t.id, END, perChat)))
      return { threads, contacts, messages: perThread.flat() }
    },

    async older(threadId, beforeSentAt, limit) {
      await store.flush()
      return newestFirst(db.transaction('messages').objectStore('messages'), threadId, beforeSentAt, limit)
    },

    forget(threadId, keep) {
      for (const [id, message] of pending.messages) if (message.threadId === threadId && !keep.has(id)) pending.messages.delete(id)
      // After what's waiting is written; what's put afterwards is written after this.
      void store.flush()
      writing = writing
        .then(async () => {
          if (closed) return
          const tx = db.transaction('messages', 'readwrite')
          const cursor = tx.objectStore('messages').index('byThread').openKeyCursor(IDBKeyRange.bound([threadId, ''], [threadId, END]))
          cursor.onsuccess = () => {
            if (!cursor.result) return
            if (!keep.has(cursor.result.primaryKey as string)) tx.objectStore('messages').delete(cursor.result.primaryKey)
            cursor.result.continue()
          }
          await done(tx)
        })
        .catch((error) => console.warn('[device] Not forgotten:', error))
      return writing
    },

    async lastHere() {
      if (closed) return null
      try {
        return (await request<string | undefined>(db.transaction('meta').objectStore('meta').get('lastHere'))) ?? null
      } catch {
        return null // Closed meanwhile (signing out).
      }
    },

    setLastHere(at) {
      writing = writing
        .then(async () => {
          if (closed) return
          const tx = db.transaction('meta', 'readwrite')
          tx.objectStore('meta').put(at, 'lastHere')
          await done(tx)
        })
        .catch((error) => console.warn('[device] Not saved:', error))
    },

    put(change) {
      for (const thread of change.threads ?? []) {
        removed.threads.delete(thread.id)
        pending.threads.set(thread.id, thread)
      }
      for (const contact of change.contacts ?? []) {
        removed.contacts.delete(contact.id)
        pending.contacts.set(contact.id, contact)
      }
      for (const message of change.messages ?? []) pending.messages.set(message.id, message)
      schedule()
    },

    remove({ threadIds = [], contactIds = [], messageIds = [] }) {
      for (const id of threadIds) {
        pending.threads.delete(id)
        removed.threads.add(id)
        for (const [messageId, message] of pending.messages) if (message.threadId === id) pending.messages.delete(messageId)
      }
      for (const id of contactIds) {
        pending.contacts.delete(id)
        removed.contacts.add(id)
      }
      for (const id of messageIds) {
        pending.messages.delete(id)
        removed.messages.add(id)
      }
      schedule()
    },

    flush() {
      if (timer) clearTimeout(timer)
      timer = null
      // One write at a time, in order.
      writing = writing.then(write).catch((error) => console.warn('[device] Not saved:', error))
      return writing
    },

    async clear() {
      closed = true
      if (timer) clearTimeout(timer)
      await writing
      db.close()
      await wipeDeviceStore()
    },
  }
  return store
}

/* ── In memory, where IndexedDB isn't available ──────────────────────────────── */

export function memoryDeviceStore(): DeviceStore {
  let threads = new Map<string, Thread>()
  let contacts = new Map<string, Contact>()
  let messages = new Map<string, Message>()
  let lastHere: string | null = null
  const byNewest = (list: Message[]) => list.sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0))

  return {
    async load(perChat) {
      const all = byNewest([...messages.values()])
      return {
        threads: [...threads.values()],
        contacts: [...contacts.values()],
        messages: [...threads.keys()].flatMap((id) => all.filter((m) => m.threadId === id).slice(0, perChat)),
      }
    },
    async older(threadId, beforeSentAt, limit) {
      return byNewest([...messages.values()].filter((m) => m.threadId === threadId && m.sentAt < beforeSentAt)).slice(0, limit)
    },
    put(change) {
      for (const thread of change.threads ?? []) threads.set(thread.id, thread)
      for (const contact of change.contacts ?? []) contacts.set(contact.id, contact)
      for (const message of change.messages ?? []) messages.set(message.id, message)
    },
    remove({ threadIds = [], contactIds = [], messageIds = [] }) {
      for (const id of threadIds) {
        threads.delete(id)
        for (const [messageId, message] of messages) if (message.threadId === id) messages.delete(messageId)
      }
      for (const id of contactIds) contacts.delete(id)
      for (const id of messageIds) messages.delete(id)
    },
    async forget(threadId, keep) {
      for (const [id, message] of messages) if (message.threadId === threadId && !keep.has(id)) messages.delete(id)
    },
    async lastHere() {
      return lastHere
    },
    setLastHere(at) {
      lastHere = at
    },
    async flush() {},
    async clear() {
      threads = new Map()
      contacts = new Map()
      messages = new Map()
    },
  }
}
