import type { ObjectId } from 'mongodb'
import { MESSAGES_KEPT_PER_CHAT } from '../../src/data/server/types.ts'
import type { Contact, Message, Reaction, Thread } from '../../src/data/types.ts'
import type { Sealer } from '../crypto.ts'
import type { Collections, MessageDoc, MessagePayload, ThreadDoc } from '../db.ts'

/** How many chats the browser gets on load (each with every message the server keeps of it). */
const SNAPSHOT_THREADS = 200

export interface StoredMessage extends Message {
  /** Network-specific reference kept alongside (e.g. a WhatsApp message key). */
  ref?: Record<string, unknown>
}

/** Totals per emoji from who-reacted-with-what. */
function totals(by: Record<string, string>): Reaction[] {
  const byEmoji = new Map<string, Reaction>()
  for (const [sender, emoji] of Object.entries(by)) {
    const reaction = byEmoji.get(emoji) ?? { emoji, count: 0, mine: false }
    reaction.count++
    if (sender === 'me') reaction.mine = true
    byEmoji.set(emoji, reaction)
  }
  return [...byEmoji.values()]
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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
    ...(doc.avatarUrl ? { avatarUrl: doc.avatarUrl } : {}),
  })

  const toMessage = (doc: MessageDoc): Message => {
    const payload = openJson<MessagePayload>(doc.payload, { body: UNREADABLE })
    const reactions = payload.reactionTotals ?? (payload.reactionsBy ? totals(payload.reactionsBy) : [])
    return {
      id: doc.id,
      threadId: doc.threadId,
      senderId: doc.senderId,
      body: payload.body,
      sentAt: doc.sentAt.toISOString(),
      ...(doc.status ? { status: doc.status } : {}),
      ...(payload.attachments?.length ? { attachments: payload.attachments } : {}),
      ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
      ...(reactions.length ? { reactions } : {}),
    }
  }

  const toContact = (doc: { id: string; network: Contact['network']; data: string }): Contact => {
    const { name, handle, avatarUrl } = openJson<{ name: string; handle: string; avatarUrl?: string }>(doc.data, {
      name: 'Unknown',
      handle: '',
    })
    return { id: doc.id, network: doc.network, name, handle, ...(avatarUrl ? { avatarUrl } : {}) }
  }

  /** Chats that got new messages since they were last trimmed, by user and chat id. */
  const untrimmed = new Map<string, { userId: ObjectId; threadId: string }>()

  /** Deletes what's beyond the latest messages of a chat; returns how many went. */
  async function trimThread(userId: ObjectId, threadId: string): Promise<number> {
    const extra = await col.messages
      .find({ userId, threadId }, { projection: { _id: 1 } })
      .sort({ sentAt: -1 })
      .skip(MESSAGES_KEPT_PER_CHAT)
      .toArray()
    if (!extra.length) return 0
    return (await col.messages.deleteMany({ _id: { $in: extra.map((d) => d._id) } })).deletedCount
  }

  /** Rewrites a message's sealed payload. */
  async function updatePayload(userId: ObjectId, id: string, change: (payload: MessagePayload) => MessagePayload) {
    const doc = await col.messages.findOne({ userId, id })
    if (!doc) return null
    const payload = change(openJson<MessagePayload>(doc.payload, { body: UNREADABLE }))
    const updated = await col.messages.findOneAndUpdate(
      { userId, id },
      { $set: { payload: sealer.sealJson(payload) } },
      { returnDocument: 'after' },
    )
    return updated && toMessage(updated)
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

    /** Creates or updates a contact; a picture already stored is kept unless a new one is given. */
    async upsertContact(userId: ObjectId, contact: Contact): Promise<boolean> {
      const existing = await col.contacts.findOne({ userId, id: contact.id })
      const old = existing && toContact(existing)
      const avatarUrl = contact.avatarUrl ?? old?.avatarUrl
      const data = sealer.sealJson({ name: contact.name, handle: contact.handle, ...(avatarUrl ? { avatarUrl } : {}) })
      if (old) {
        if (old.name === contact.name && old.handle === contact.handle && old.avatarUrl === avatarUrl) return false
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

    /** Every chat of one network (by id prefix), for going over them all. */
    async threadsOf(userId: ObjectId, idPrefix: string): Promise<Thread[]> {
      const docs = await col.threads.find({ userId, id: { $regex: `^${escapeRegex(idPrefix)}` } }).toArray()
      return docs.map(toThread)
    },

    /** Every contact of one network (by id prefix). */
    async contactsOf(userId: ObjectId, idPrefix: string): Promise<Contact[]> {
      const docs = await col.contacts.find({ userId, id: { $regex: `^${escapeRegex(idPrefix)}` } }).toArray()
      return docs.map(toContact)
    },

    async contact(userId: ObjectId, id: string): Promise<Contact | null> {
      const doc = await col.contacts.findOne({ userId, id })
      return doc && toContact(doc)
    },

    /** Sets a contact's picture; returns the contact if it changed. */
    async setContactAvatar(userId: ObjectId, id: string, avatarUrl: string): Promise<Contact | null> {
      const doc = await col.contacts.findOne({ userId, id })
      if (!doc) return null
      const contact = toContact(doc)
      if (contact.avatarUrl === avatarUrl) return null
      const updated = { ...contact, avatarUrl }
      await col.contacts.updateOne(
        { userId, id },
        { $set: { data: sealer.sealJson({ name: updated.name, handle: updated.handle, avatarUrl }) } },
      )
      return updated
    },

    /** Sets a group's picture; returns the thread if it changed. */
    async setThreadAvatar(userId: ObjectId, id: string, avatarUrl: string): Promise<Thread | null> {
      const doc = await col.threads.findOneAndUpdate(
        { userId, id, avatarUrl: { $ne: avatarUrl } },
        { $set: { avatarUrl } },
        { returnDocument: 'after' },
      )
      return doc && toThread(doc)
    },

    /** Stores a message; false if it was already there (history replays, echoes of our own sends). */
    async addMessage(userId: ObjectId, message: StoredMessage): Promise<boolean> {
      const payload: MessagePayload = {
        body: message.body,
        ...(message.attachments ? { attachments: message.attachments } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(message.reactions?.length ? { reactionTotals: message.reactions } : {}),
      }
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
        untrimmed.set(`${userId.toHexString()}:${message.threadId}`, { userId, threadId: message.threadId })
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
        // The quote and reactions stay as they are.
        const { attachments, ...current } = openJson<MessagePayload>(doc.payload, { body: UNREADABLE })
        const nextAttachments = patch.attachments ?? attachments
        set.payload = sealer.sealJson({
          ...current,
          body: patch.body ?? current.body,
          ...(nextAttachments?.length ? { attachments: nextAttachments } : {}),
        })
      }
      if (patch.status) set.status = patch.status
      if (Object.keys(set).length === 0) return toMessage(doc)
      const updated = await col.messages.findOneAndUpdate({ userId, id }, { $set: set }, { returnDocument: 'after' })
      return updated && toMessage(updated)
    },

    /** One person's reaction (`senderId` "me" for the user) changed; null removes it. */
    async setReaction(userId: ObjectId, id: string, senderId: string, emoji: string | null): Promise<Message | null> {
      return updatePayload(userId, id, (payload) => {
        const by = { ...payload.reactionsBy }
        if (emoji) by[senderId] = emoji
        else delete by[senderId]
        const { reactionTotals, ...rest } = payload
        void reactionTotals
        return { ...rest, reactionsBy: by }
      })
    },

    /** The network reported new totals (Telegram doesn't always say who). */
    async setReactionTotals(userId: ObjectId, id: string, reactions: Reaction[]): Promise<Message | null> {
      return updatePayload(userId, id, (payload) => {
        const { reactionsBy, ...rest } = payload
        void reactionsBy
        return { ...rest, reactionTotals: reactions }
      })
    },

    /**
     * Stored messages from before `before`, oldest first. The message itself may be gone from the
     * server (it keeps only the latest); then the time the device gave is used.
     */
    async older(
      userId: ObjectId,
      threadId: string,
      before: { id: string; sentAt?: string },
      limit = 30,
    ): Promise<{ messages: Message[]; hasMore: boolean }> {
      const stored = await col.messages.findOne({ userId, id: before.id, threadId })
      const sentAt = stored?.sentAt ?? (before.sentAt ? new Date(before.sentAt) : null)
      if (!sentAt || Number.isNaN(sentAt.getTime())) return { messages: [], hasMore: false }
      const docs = await col.messages
        .find({ userId, threadId, sentAt: { $lt: sentAt } })
        .sort({ sentAt: -1 })
        .limit(limit + 1)
        .toArray()
      return { messages: docs.slice(0, limit).reverse().map(toMessage), hasMore: docs.length > limit }
    },

    /**
     * Recent messages whose sticker, photo or file can't be opened: kept before files were fetched
     * from the network (a sticker was only named then). Newest first, for asking the network again.
     */
    async missingFiles(userId: ObjectId, idPrefix: string, limit = 40): Promise<{ id: string; threadId: string; ref?: Record<string, unknown> }[]> {
      const docs = await col.messages
        .find({ userId, id: { $regex: `^${escapeRegex(idPrefix)}` } })
        .sort({ sentAt: -1 })
        .limit(2000)
        .toArray()
      const found: { id: string; threadId: string; ref?: Record<string, unknown> }[] = []
      for (const doc of docs) {
        const m = toMessage(doc)
        const namedSticker = !m.attachments?.length && /^(\S+ )?Sticker$/u.test(m.body)
        if (namedSticker || m.attachments?.some((a) => !a.url)) found.push({ id: doc.id, threadId: doc.threadId, ...(doc.ref ? { ref: doc.ref } : {}) })
        if (found.length >= limit) break
      }
      return found
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
          { $group: { _id: '$threadId', docs: { $firstN: { input: '$$ROOT', n: MESSAGES_KEPT_PER_CHAT } } } },
        ])
        .toArray()
      const contactDocs = await col.contacts.find({ userId }).limit(5000).toArray()
      return {
        threads: threadDocs.map(toThread),
        contacts: contactDocs.map(toContact),
        messages: grouped.flatMap((g) => g.docs.map(toMessage)),
      }
    },

    /**
     * Keeps the server's copy small: of each chat that got new messages, only the latest
     * MESSAGES_KEPT_PER_CHAT stay. Devices keep everything they've seen. Returns how many went.
     */
    async trim(): Promise<number> {
      const due = [...untrimmed.values()]
      untrimmed.clear()
      let removed = 0
      for (const { userId, threadId } of due) removed += await trimThread(userId, threadId)
      return removed
    },

    /** Trims every chat holding more than it should (data stored before the limit existed). */
    async trimAll(): Promise<number> {
      const over = await col.messages
        .aggregate<{ _id: { userId: ObjectId; threadId: string } }>([
          { $group: { _id: { userId: '$userId', threadId: '$threadId' }, count: { $sum: 1 } } },
          { $match: { count: { $gt: MESSAGES_KEPT_PER_CHAT } } },
        ])
        .toArray()
      let removed = 0
      for (const { _id } of over) removed += await trimThread(_id.userId, _id.threadId)
      return removed
    },

    /** Deletes every chat, contact and message of one network for a user (on unlink). */
    async forgetNetwork(userId: ObjectId, idPrefix: string) {
      const match = { userId, id: { $regex: `^${escapeRegex(idPrefix)}` } }
      await Promise.all([
        col.threads.deleteMany(match),
        col.contacts.deleteMany(match),
        col.avatars.deleteMany(match),
        col.messages.deleteMany({ userId, threadId: match.id }),
      ])
    },
  }
}

export type InboxStore = ReturnType<typeof createInboxStore>
