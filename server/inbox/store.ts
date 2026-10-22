import type { ObjectId } from 'mongodb'
import type { Contact, Message, Thread } from '../../src/data/types.ts'
import type { Sealer } from '../crypto.ts'
import type { Collections, MessageDoc, MessagePayload, ThreadDoc } from '../db.ts'

/** How much of each chat the browser gets on load. */
const SNAPSHOT_THREADS = 200
const SNAPSHOT_MESSAGES_PER_THREAD = 50

export interface StoredMessage extends Message {
  /** Network-specific reference kept alongside (e.g. a WhatsApp message key). */
  ref?: Record<string, unknown>
}

export interface InboxSnapshotPart {
  threads: Thread[]
  contacts: Contact[]
  messages: Message[]
}

/**
 * Chats from linked networks, per user. Titles, names, message text and attachments are sealed;
 * ids, timestamps and counts stay readable so the database can sort and filter.
 */
export function createInboxStore(col: Collections, sealer: Sealer) {
  /** Sealed with another key (DATA_ENCRYPTION_KEY or JWT_SECRET changed): shown as such, not a crash. */
  const UNREADABLE = "🔒 Unreadable: the server's encryption key changed"
  const open = (sealed: string) => {
    try {
      return sealer.open(sealed)
    } catch {
      return UNREADABLE
    }
  }
  const openJson = <T>(sealed: string, fallback: T): T => {
    try {
      return sealer.openJson<T>(sealed)
    } catch {
      return fallback
    }
  }

  const toThread = (doc: ThreadDoc): Thread => ({
    id: doc.id,
    network: doc.network,
    kind: doc.kind,
    title: open(doc.title),
    participantIds: doc.participantIds,
    unreadCount: doc.unreadCount,
    // Done and snoozed live in the browser for linked chats, like for every other connector.
    doneAt: null,
    snoozedUntil: null,
  })

  const toMessage = (doc: MessageDoc): Message => {
    const { body, attachments } = openJson<MessagePayload>(doc.payload, { body: UNREADABLE })
    return {
      id: doc.id,
      threadId: doc.threadId,
      senderId: doc.senderId,
      body,
      sentAt: doc.sentAt.toISOString(),
      ...(doc.status ? { status: doc.status } : {}),
      ...(attachments?.length ? { attachments } : {}),
    }
  }

  return {
    toMessage,

    async thread(userId: ObjectId, id: string): Promise<Thread | null> {
      const doc = await col.threads.findOne({ userId, id })
      return doc && toThread(doc)
    },

    /** Creates or updates a chat. Fields left out keep their stored values. */
    async upsertThread(
      userId: ObjectId,
      thread: Pick<Thread, 'id' | 'network' | 'kind'> & Partial<Pick<Thread, 'title' | 'participantIds' | 'unreadCount'>> & { lastAt?: Date },
    ): Promise<Thread> {
      const set: Partial<ThreadDoc> = { network: thread.network, kind: thread.kind, updatedAt: new Date() }
      if (thread.title !== undefined) set.title = sealer.seal(thread.title)
      if (thread.participantIds) set.participantIds = thread.participantIds
      if (thread.unreadCount !== undefined) set.unreadCount = thread.unreadCount
      const doc = await col.threads.findOneAndUpdate(
        { userId, id: thread.id },
        {
          $set: set,
          ...(thread.lastAt ? { $max: { lastAt: thread.lastAt } } : {}),
          $setOnInsert: {
            ...(thread.title === undefined ? { title: sealer.seal('Chat') } : {}),
            ...(thread.participantIds ? {} : { participantIds: [] }),
            ...(thread.unreadCount === undefined ? { unreadCount: 0 } : {}),
            ...(thread.lastAt ? {} : { lastAt: new Date(0) }),
          },
        },
        { upsert: true, returnDocument: 'after' },
      )
      return toThread(doc!)
    },

    async addParticipant(userId: ObjectId, threadId: string, contactId: string) {
      await col.threads.updateOne({ userId, id: threadId }, { $addToSet: { participantIds: contactId } })
    },

    async setUnread(userId: ObjectId, threadId: string, unreadCount: number) {
      await col.threads.updateOne({ userId, id: threadId }, { $set: { unreadCount } })
    },

    async incrementUnread(userId: ObjectId, threadId: string) {
      await col.threads.updateOne({ userId, id: threadId }, { $inc: { unreadCount: 1 } })
    },

    async upsertContact(userId: ObjectId, contact: Contact): Promise<boolean> {
      const data = sealer.sealJson({ name: contact.name, handle: contact.handle })
      const existing = await col.contacts.findOne({ userId, id: contact.id })
      if (existing) {
        const old = openJson(existing.data, { name: '', handle: '' })
        if (old.name === contact.name && old.handle === contact.handle) return false
        await col.contacts.updateOne({ userId, id: contact.id }, { $set: { data } })
        return true
      }
      await col.contacts.updateOne(
        { userId, id: contact.id },
        { $setOnInsert: { network: contact.network, data } },
        { upsert: true },
      )
      return true
    },

    /** Stores a message; false if it was already there (history replays, echoes of our own sends). */
    async addMessage(userId: ObjectId, message: StoredMessage): Promise<boolean> {
      const payload: MessagePayload = { body: message.body, ...(message.attachments ? { attachments: message.attachments } : {}) }
      const result = await col.messages.updateOne(
        { userId, id: message.id },
        {
          $setOnInsert: {
            threadId: message.threadId,
            senderId: message.senderId,
            sentAt: new Date(message.sentAt),
            payload: sealer.sealJson(payload),
            ...(message.status ? { status: message.status } : {}),
            ...(message.ref ? { ref: message.ref } : {}),
          },
        },
        { upsert: true },
      )
      if (result.upsertedCount) {
        await col.threads.updateOne({ userId, id: message.threadId }, { $max: { lastAt: new Date(message.sentAt) } })
      }
      return result.upsertedCount > 0
    },

    /** Edits text or attachments, or updates the delivery status. Returns the stored message. */
    async updateMessage(
      userId: ObjectId,
      id: string,
      patch: { body?: string; attachments?: Message['attachments']; status?: Message['status'] },
    ): Promise<Message | null> {
      const doc = await col.messages.findOne({ userId, id })
      if (!doc) return null
      const set: Partial<MessageDoc> = {}
      if (patch.body !== undefined || patch.attachments !== undefined) {
        const current = openJson<MessagePayload>(doc.payload, { body: UNREADABLE })
        set.payload = sealer.sealJson({
          body: patch.body ?? current.body,
          ...((patch.attachments ?? current.attachments) ? { attachments: patch.attachments ?? current.attachments } : {}),
        })
      }
      if (patch.status) set.status = patch.status
      if (Object.keys(set).length === 0) return toMessage(doc)
      const updated = await col.messages.findOneAndUpdate({ userId, id }, { $set: set }, { returnDocument: 'after' })
      return updated && toMessage(updated)
    },

    async message(userId: ObjectId, id: string): Promise<(Message & { ref?: Record<string, unknown> }) | null> {
      const doc = await col.messages.findOne({ userId, id })
      return doc && { ...toMessage(doc), ...(doc.ref ? { ref: doc.ref } : {}) }
    },

    /**
     * The other side read my messages in a chat, up to the one whose `ref.id` is `upToRefId`.
     * Returns the messages that changed.
     */
    async markSentRead(userId: ObjectId, threadId: string, upToRefId: number): Promise<Message[]> {
      const docs = await col.messages
        .find({ userId, threadId, senderId: 'me', status: { $in: ['sent', 'delivered'] }, 'ref.id': { $lte: upToRefId } })
        .toArray()
      if (!docs.length) return []
      await col.messages.updateMany({ userId, id: { $in: docs.map((d) => d.id) } }, { $set: { status: 'read' } })
      return docs.map((d) => toMessage({ ...d, status: 'read' }))
    },

    /** The latest messages others sent in a chat, for read receipts. */
    async recentIncoming(userId: ObjectId, threadId: string, limit = 20) {
      return col.messages
        .find({ userId, threadId, senderId: { $ne: 'me' } })
        .sort({ sentAt: -1 })
        .limit(limit)
        .toArray()
    },

    async latestMessageAt(userId: ObjectId, threadId: string): Promise<Date | null> {
      const doc = await col.messages.find({ userId, threadId }).sort({ sentAt: -1 }).limit(1).next()
      return doc?.sentAt ?? null
    },

    async snapshot(userId: ObjectId): Promise<InboxSnapshotPart> {
      const threadDocs = await col.threads.find({ userId }).sort({ lastAt: -1 }).limit(SNAPSHOT_THREADS).toArray()
      const ids = threadDocs.map((t) => t.id)
      const grouped = await col.messages
        .aggregate<{ docs: MessageDoc[] }>([
          { $match: { userId, threadId: { $in: ids } } },
          { $sort: { sentAt: -1 } },
          { $group: { _id: '$threadId', docs: { $firstN: { input: '$$ROOT', n: SNAPSHOT_MESSAGES_PER_THREAD } } } },
        ])
        .toArray()
      const contactDocs = await col.contacts.find({ userId }).limit(5000).toArray()
      return {
        threads: threadDocs.map(toThread),
        contacts: contactDocs.map((c) => ({
          id: c.id,
          network: c.network,
          ...openJson(c.data, { name: 'Unknown', handle: '' }),
        })),
        messages: grouped.flatMap((g) => g.docs.map(toMessage)),
      }
    },

    /** Deletes every chat, contact and message of one network for a user (on unlink). */
    async forgetNetwork(userId: ObjectId, idPrefix: string) {
      const match = { userId, id: { $regex: `^${idPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } }
      await Promise.all([
        col.threads.deleteMany(match),
        col.contacts.deleteMany(match),
        col.messages.deleteMany({ userId, threadId: match.id }),
      ])
    },
  }
}

export type InboxStore = ReturnType<typeof createInboxStore>
