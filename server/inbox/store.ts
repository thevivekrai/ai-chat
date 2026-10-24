import type { ObjectId } from 'mongodb'
import { MESSAGES_KEPT_PER_CHAT } from '../../src/data/server/types.ts'
import type { MessageHint } from '../../src/data/server/types.ts'
import type { Contact, Message, MessageAction, Reaction, Thread } from '../../src/data/types.ts'
import type { Sealer } from '../crypto.ts'
import type { Collections, MessageDoc, MessagePayload, ThreadDoc } from '../db.ts'

/**
 * Messages deleted for me lately, for devices that were away then; and, of the chats sent
 * (`sent`), those where some from before a time aren't listed any more (more than DELETIONS_KEPT,
 * or older than a month), so a device away since then knows to start that chat afresh from them.
 */
function deletions(threads: Pick<ThreadDoc, 'id' | 'deletedIds'>[], sent: Set<string>, now = Date.now()) {
  const deleted: string[] = []
  const deletedSince: Record<string, string> = {}
  for (const t of threads) {
    const list = t.deletedIds ?? []
    let since = 0
    // Full: older ones may have been let go (before the oldest with a date, at the latest).
    const oldest = list.find((d) => typeof d !== 'string')
    if (list.length >= DELETIONS_KEPT && oldest && typeof oldest !== 'string') since = oldest.at.getTime()
    for (const d of list) {
      if (typeof d === 'string') deleted.push(d)
      else if (now - d.at.getTime() < DELETIONS_KEPT_MS) deleted.push(d.id)
      // No longer listed: missed only by a device last here before it happened.
      else since = Math.max(since, d.at.getTime())
    }
    if (since && sent.has(t.id)) deletedSince[t.id] = new Date(since).toISOString()
  }
  return { deleted, deletedSince, at: new Date(now).toISOString() }
}

/** A kept message as devices get it: without what only the server uses. */
export function wireOf(message: StoredMessage): Message {
  const { ref, reactedAt, ...wire } = message
  void ref
  void reactedAt
  return wire
}

/** How many chats the browser gets on load (each with every message the server keeps of it). */
const SNAPSHOT_THREADS = 200
/**
 * Messages deleted for me are remembered for devices that were away when it happened: the latest
 * few per chat, for a month. A device away longer starts that chat afresh (see deletions).
 */
const DELETIONS_KEPT = 50
const DELETIONS_KEPT_MS = 30 * 86_400_000
/** A sticker, photo or file the network didn't send again is asked for again after this long. */
const FILE_ASKED_AGAIN_MS = 86_400_000

export interface StoredMessage extends Message {
  /** Network-specific reference kept alongside (e.g. a WhatsApp message key). */
  ref?: Record<string, unknown>
  /** With `reactedBy`: when each was given, where the network says (see MessagePayload.reactedAt). */
  reactedAt?: Record<string, number>
}

/** Totals per emoji from who-reacted-with-what. */
export function totals(by: Record<string, string>): Reaction[] {
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

/** Reactions from two lists added up, emoji by emoji. */
export function addedUp(a: Reaction[], b: Reaction[]): Reaction[] {
  const byEmoji = new Map<string, Reaction>()
  for (const r of [...a, ...b]) {
    const sum = byEmoji.get(r.emoji)
    byEmoji.set(r.emoji, sum ? { ...sum, count: sum.count + r.count, mine: sum.mine || r.mine } : r)
  }
  return [...byEmoji.values()]
}

/** Reactions less `other`, emoji by emoji (one of mine goes where `other` has mine). */
function minus(reactions: Reaction[], other: Reaction[]): Reaction[] {
  return reactions
    .map((r) => {
      const o = other.find((x) => x.emoji === r.emoji)
      return o ? { ...r, count: r.count - o.count, mine: r.mine && !o.mine } : r
    })
    .filter((r) => r.count > 0)
}

/** Only mine of the reactions. */
const onlyMine = (reactions: Reaction[]) => reactions.filter((r) => r.mine).map((r) => ({ ...r, count: 1 }))

/** Reactions without mine among them. */
const withoutMine = (reactions: Reaction[]) => minus(reactions, onlyMine(reactions))

/**
 * Who gave which, as a device says, if it agrees with the totals it shows (each giver's emoji is
 * among them, and no more of one than counted).
 */
function giversMatching(reactions: Reaction[] = [], by: Record<string, string> | undefined) {
  if (!by) return undefined
  const known = totals(by)
  const fits =
    known.every((k) => reactions.some((r) => r.emoji === k.emoji)) &&
    reactions.every((r) => {
      const k = known.find((x) => x.emoji === r.emoji)
      if (k?.mine && !r.mine) return false
      return (k?.count ?? 0) + (r.mine && !k?.mine ? 1 : 0) <= r.count
    })
  return fits ? by : undefined
}

/** Of a device's totals, those given by people not in `by`, if any. */
function unknownGivers(reactions: Reaction[] = [], by: Record<string, string>): { reactionBase?: Reaction[] } {
  const rest = minus(reactions, totals(by))
  return rest.length ? { reactionBase: rest } : {}
}

/** Whether two records hold the same, in whatever order. */
function sameRecord<T>(a: Record<string, T>, b: Record<string, T>) {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

/**
 * A sticker, voice message, photo or file kept without a link to it (earlier versions only named
 * stickers and voice messages), which the network can be asked for again.
 */
function lacksFile(m: { body: string; attachments?: Message['attachments'] }): boolean {
  if (m.attachments?.length) return m.attachments.some((a) => !a.url)
  return /^(\S+ )?Sticker$/u.test(m.body) || m.body === '🎤 Voice message' || m.body === '🎵 Audio'
}

export interface InboxSnapshotPart {
  threads: Thread[]
  contacts: Contact[]
  messages: Message[]
  /** Messages deleted for me lately: devices that were away remove them too. */
  deleted: string[]
  /** Chats a device away since an earlier time starts afresh (see deletions). */
  deletedSince: Record<string, string>
  /** When this was taken. */
  at: string
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

  /**
   * A message's payload, to change and seal again; null when it can't be opened (sealed with
   * another key), so it's left as it is rather than sealed over.
   */
  const payloadToChange = (doc: MessageDoc): MessagePayload | null => {
    const unreadable: MessagePayload = { body: UNREADABLE }
    const opened = openJson<MessagePayload>(doc.payload, unreadable)
    return opened === unreadable ? null : opened
  }

  /** `count` unread as the network says, but no more than came in since the chat was read in Sytext. */
  async function unreadSince(userId: ObjectId, threadId: string, count: number): Promise<number> {
    if (count <= 0) return Math.max(0, count)
    const thread = await col.threads.findOne({ userId, id: threadId }, { projection: { readThrough: 1 } })
    if (!thread?.readThrough) return count
    const since = await col.messages.countDocuments({
      userId,
      threadId,
      senderId: { $ne: 'me' },
      sentAt: { $gt: thread.readThrough },
    })
    return Math.min(count, since)
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
    ...(doc.archived ? { archived: true } : {}),
  })

  const toMessage = (doc: MessageDoc): Message => {
    const payload = openJson<MessagePayload>(doc.payload, { body: UNREADABLE })
    const reactions = payload.reactionTotals ?? addedUp(payload.reactionBase ?? [], payload.reactionsBy ? totals(payload.reactionsBy) : [])
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
      ...(payload.reactionsBy && Object.keys(payload.reactionsBy).length ? { reactedBy: payload.reactionsBy } : {}),
      ...(payload.editedAt ? { editedAt: payload.editedAt } : {}),
      ...(payload.deleted ? { deleted: true } : {}),
      ...(doc.pinned ? { pinned: true } : {}),
      ...(doc.pinned && doc.pinnedUntil ? { pinnedUntil: doc.pinnedUntil.toISOString() } : {}),
      ...(doc.starred ? { starred: true } : {}),
    }
  }

  const toContact = (doc: { id: string; network: Contact['network']; data: string }): Contact => {
    const { name, handle, avatarUrl } = openJson<{
      name: string
      handle: string
      avatarUrl?: string
    }>(doc.data, {
      name: 'Unknown',
      handle: '',
    })
    return {
      id: doc.id,
      network: doc.network,
      name,
      handle,
      ...(avatarUrl ? { avatarUrl } : {}),
    }
  }

  /** Chats that got new messages since they were last trimmed, by user and chat id. */
  const untrimmed = new Map<string, { userId: ObjectId; threadId: string }>()

  /** Deletes what's beyond the latest messages of a chat; returns how many went. */
  async function trimThread(userId: ObjectId, threadId: string): Promise<number> {
    // Pinned and starred messages stay, however old: they're what the user wanted to find again.
    const extra = await col.messages
      .find(
        // A pin that has run out no longer keeps a message.
        {
          userId,
          threadId,
          starred: { $ne: true },
          $or: [{ pinned: { $ne: true } }, { pinnedUntil: { $lte: new Date() } }],
        },
        { projection: { _id: 1 } },
      )
      .sort({ sentAt: -1 })
      .skip(MESSAGES_KEPT_PER_CHAT)
      .toArray()
    if (!extra.length) return 0
    return (await col.messages.deleteMany({ _id: { $in: extra.map((d) => d._id) } })).deletedCount
  }

  /** Rewrites a message's sealed payload. */
  /**
   * Changes a message's sealed payload (`change` returns null to leave it), with `also` set beside
   * it. Only over the payload it read: if something else changed it meanwhile, it's read again.
   */
  async function updatePayload(
    userId: ObjectId,
    id: string,
    change: (payload: MessagePayload) => MessagePayload | null,
    also: Partial<MessageDoc> = {},
  ): Promise<Message | null> {
    // (Each time round, someone else's change went in: it gets there.)
    for (let attempt = 0; attempt < 50; attempt++) {
      const doc = await col.messages.findOne({ userId, id })
      const current = doc && payloadToChange(doc)
      if (!doc || !current) return null
      const payload = change(current)
      if (!payload) return null
      const updated = await col.messages.findOneAndUpdate(
        { userId, id, payload: doc.payload },
        { $set: { payload: sealer.sealJson(payload), ...also } },
        { returnDocument: 'after' },
      )
      if (updated) return toMessage(updated)
    }
    throw new Error(`Message ${id} kept changing`)
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
      thread: Pick<Thread, 'id' | 'network' | 'kind'> &
        Partial<Pick<Thread, 'title' | 'participantIds' | 'unreadCount' | 'archived'>> & { lastAt?: Date },
    ): Promise<Thread> {
      const set: Partial<ThreadDoc> = {
        network: thread.network,
        kind: thread.kind,
        updatedAt: new Date(),
      }
      if (thread.title !== undefined) set.title = sealer.seal(thread.title)
      if (thread.participantIds) set.participantIds = thread.participantIds
      if (thread.unreadCount !== undefined) set.unreadCount = await unreadSince(userId, thread.id, thread.unreadCount)
      if (thread.archived === true) set.archived = true
      const doc = await col.threads.findOneAndUpdate(
        { userId, id: thread.id },
        {
          $set: set,
          ...(thread.archived === false ? { $unset: { archived: '' } } : {}),
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

    /** The unread count as the network gives it (capped at what's new since an Incognito read). */
    async setUnread(userId: ObjectId, threadId: string, unreadCount: number) {
      await col.threads.updateOne(
        { userId, id: threadId },
        {
          $set: {
            unreadCount: await unreadSince(userId, threadId, unreadCount),
          },
        },
      )
    },

    /**
     * Read in Sytext. Without a read receipt (Incognito mode), the network keeps counting those
     * messages unread; that's remembered, so its counts don't bring them back.
     */
    async markReadHere(userId: ObjectId, threadId: string, { receipt }: { receipt: boolean }) {
      await col.threads.updateOne(
        { userId, id: threadId },
        receipt ? { $set: { unreadCount: 0 }, $unset: { readThrough: '' } } : { $set: { unreadCount: 0, readThrough: new Date() } },
      )
    },

    /** Archives or unarchives a chat; returns it, or null if there's no such chat. */
    async setArchived(userId: ObjectId, threadId: string, archived: boolean): Promise<Thread | null> {
      const doc = await col.threads.findOneAndUpdate(
        { userId, id: threadId },
        archived ? { $set: { archived: true } } : { $unset: { archived: '' } },
        { returnDocument: 'after' },
      )
      return doc && toThread(doc)
    },

    async incrementUnread(userId: ObjectId, threadId: string) {
      await col.threads.updateOne({ userId, id: threadId }, { $inc: { unreadCount: 1 } })
    },

    /** Creates or updates a contact; a picture already stored is kept unless a new one is given. */
    async upsertContact(userId: ObjectId, contact: Contact): Promise<boolean> {
      const existing = await col.contacts.findOne({ userId, id: contact.id })
      const old = existing && toContact(existing)
      const avatarUrl = contact.avatarUrl ?? old?.avatarUrl
      const data = sealer.sealJson({
        name: contact.name,
        handle: contact.handle,
        ...(avatarUrl ? { avatarUrl } : {}),
      })
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
        // Who gave which, where the device knew (a copy kept again): the rest stay as totals.
        ...(message.reactedBy
          ? {
              reactionsBy: message.reactedBy,
              ...unknownGivers(message.reactions, message.reactedBy),
            }
          : message.reactions?.length
            ? { reactionTotals: message.reactions }
            : {}),
        ...(message.reactedAt ? { reactedAt: message.reactedAt } : {}),
        ...(message.editedAt ? { editedAt: message.editedAt } : {}),
        ...(message.deleted ? { deleted: true } : {}),
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
            ...(message.pinned ? { pinned: true } : {}),
            ...(message.pinned && message.pinnedUntil ? { pinnedUntil: new Date(message.pinnedUntil) } : {}),
            ...(message.starred ? { starred: true } : {}),
            ...(lacksFile(message) ? {} : { filesOk: true as const }),
          },
        },
        { upsert: true },
      )
      if (result.upsertedCount) {
        await col.threads.updateOne({ userId, id: message.threadId }, { $max: { lastAt: new Date(message.sentAt) } })
        untrimmed.set(`${userId.toHexString()}:${message.threadId}`, {
          userId,
          threadId: message.threadId,
        })
      }
      return result.upsertedCount > 0
    },

    /**
     * Edits text or attachments, marks it edited or deleted for everyone, pins or stars it, or
     * updates the delivery status. Returns the stored message.
     */
    async updateMessage(
      userId: ObjectId,
      id: string,
      patch: {
        body?: string
        attachments?: Message['attachments']
        status?: Message['status']
        editedAt?: string
        deleted?: boolean
        pinned?: boolean
        /** With `pinned: true`: when the pin ends by itself. */
        pinnedUntil?: string
        starred?: boolean
      },
    ): Promise<Message | null> {
      // Changing the payload: only over the one read, so a reaction landing meanwhile isn't lost.
      for (let attempt = 0; attempt < 50; attempt++) {
        const doc = await col.messages.findOne({ userId, id })
        if (!doc) return null
        const set: Partial<MessageDoc> = {}
        const unset: Record<string, ''> = {}
        if (patch.deleted) {
          // Deleted for everyone: what it said, showed or quoted goes; reactions go with it.
          set.payload = sealer.sealJson({
            body: '',
            deleted: true,
          } satisfies MessagePayload)
        } else if (patch.body !== undefined || patch.attachments !== undefined || patch.editedAt !== undefined) {
          // The quote and reactions stay as they are.
          const opened = payloadToChange(doc)
          if (opened) {
            const { attachments, ...current } = opened
            const nextAttachments = patch.attachments ?? attachments
            set.payload = sealer.sealJson({
              ...current,
              body: patch.body ?? current.body,
              ...(nextAttachments?.length ? { attachments: nextAttachments } : {}),
              ...(patch.editedAt ? { editedAt: patch.editedAt } : {}),
            })
          }
        }
        if (patch.status) set.status = patch.status
        // New attachments may have files to fetch again, or no longer.
        if (patch.attachments) {
          if (patch.attachments.some((a) => !a.url)) unset.filesOk = ''
          else set.filesOk = true
        }
        for (const flag of ['pinned', 'starred'] as const) {
          if (patch[flag] === true) set[flag] = true
          else if (patch[flag] === false) unset[flag] = ''
        }
        // A new pin brings its own end (or none); unpinned, there's none.
        if (patch.pinned === true && patch.pinnedUntil) set.pinnedUntil = new Date(patch.pinnedUntil)
        else if (patch.pinned !== undefined) unset.pinnedUntil = ''
        if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) return toMessage(doc)
        const updated = await col.messages.findOneAndUpdate(
          { userId, id, ...(set.payload ? { payload: doc.payload } : {}) },
          {
            ...(Object.keys(set).length ? { $set: set } : {}),
            ...(Object.keys(unset).length ? { $unset: unset } : {}),
          },
          { returnDocument: 'after' },
        )
        if (updated) return toMessage(updated)
      }
      throw new Error(`Message ${id} kept changing`)
    },

    /**
     * Pinned or starred, a message the server no longer keeps (older than the latest of its chat)
     * is kept again, from what the device says of it, so it shows on every device however old.
     */
    async keepFlagged(userId: ObjectId, threadId: string, hint: MessageHint, action: MessageAction, ref: Record<string, unknown>) {
      const flags = action.type === 'pin' && action.pinned ? { pinned: true } : action.type === 'star' && action.starred ? { starred: true } : null
      if (!flags || !hint.id.startsWith(`${threadId}:`)) return
      const reactedBy = giversMatching(hint.reactions, hint.reactedBy)
      const givers = reactedBy ? { reactedBy } : {}
      await this.addMessage(userId, {
        id: hint.id,
        threadId,
        senderId: hint.senderId,
        body: hint.body ?? '',
        sentAt: hint.sentAt,
        ...(hint.attachments ? { attachments: hint.attachments } : {}),
        ...(hint.replyTo ? { replyTo: hint.replyTo } : {}),
        ...(hint.reactions ? { reactions: hint.reactions } : {}),
        ...givers,
        ...(hint.editedAt ? { editedAt: hint.editedAt } : {}),
        ...(hint.status ? { status: hint.status } : {}),
        ...flags,
        ref,
      })
    },

    /** Deleted for me: gone from the server. Returns whether it was kept. */
    async deleteMessage(userId: ObjectId, threadId: string, id: string): Promise<boolean> {
      const gone = (await col.messages.deleteOne({ userId, id })).deletedCount > 0
      // Remembered, kept or not: devices that were away remove it when they come back.
      await col.threads.updateOne(
        { userId, id: threadId },
        {
          $push: {
            deletedIds: {
              $each: [{ id, at: new Date() }],
              $slice: -DELETIONS_KEPT,
            },
          },
        },
      )
      return gone
    },

    /** Telegram's private and small-group messages by their own ids (deletions say only those). */
    async byRefIds(userId: ObjectId, idPrefix: string, refIds: number[]): Promise<{ id: string; threadId: string }[]> {
      return col.messages
        .find(
          {
            userId,
            id: { $regex: `^${escapeRegex(idPrefix)}` },
            'ref.id': { $in: refIds },
          },
          { projection: { id: 1, threadId: 1 } },
        )
        .toArray()
    },

    /**
     * One person's reaction (`senderId` "me" for the user) changed, as it happened; null removes
     * it. `at` is when it was given, by the giver's clock, as WhatsApp orders each person's
     * reactions; `direct` says the chat is between the user and one other person.
     */
    async setReaction(
      userId: ObjectId,
      id: string,
      senderId: string,
      emoji: string | null,
      { at, direct = false }: { at: number; direct?: boolean },
    ): Promise<Message | null> {
      return updatePayload(userId, id, (payload) => {
        // A message deleted for everyone has no reactions.
        if (payload.deleted) return null
        const times = payload.reactedAt ?? {}
        // The same or an older word of this person's reaction (sent again, or late): nothing new.
        if (times[senderId] !== undefined && at <= times[senderId]) return null
        const { reactionTotals, reactionBase, ...rest } = payload
        // Kept again from a device's copy that showed only totals (who gave them unknown): on the
        // first word from a person, their part of those comes off where it can be told. Mine is
        // marked; in a chat with one other person, the rest are theirs. (In a group it can't be:
        // the list WhatsApp sends of the message's reactions replaces them, see setReactions.)
        let base = reactionBase ?? (!payload.reactionsBy && reactionTotals?.length ? reactionTotals : undefined)
        if (base && !(senderId in times) && !(senderId in (payload.reactionsBy ?? {}))) {
          if (senderId === 'me') base = withoutMine(base)
          else if (direct) base = onlyMine(base)
        }
        const by = { ...payload.reactionsBy }
        if (emoji) by[senderId] = emoji
        else delete by[senderId]
        return {
          ...rest,
          reactionsBy: by,
          reactedAt: { ...times, [senderId]: at },
          ...(base?.length ? { reactionBase: base } : {}),
        }
      })
    },

    /**
     * Everyone's reactions to a message as WhatsApp lists them with it (from history): who gave
     * which and when (an empty one: taken back), and how many more it doesn't say who gave
     * (`unnamed`). For each giver the newest word wins, by their time (one without a time only
     * says what nothing else has); one it leaves out stays if anything newer was heard of them, or
     * if it doesn't name everyone. Returns the message if that changed it.
     */
    async setReactions(
      userId: ObjectId,
      id: string,
      {
        by: list,
        unnamed,
      }: {
        by: Record<string, { emoji: string; at?: number }>
        unnamed: Reaction[]
      },
    ): Promise<Message | null> {
      return updatePayload(userId, id, (payload) => {
        if (payload.deleted) return null
        const { reactionTotals, reactionBase, reactionsBy = {}, reactedAt: times = {}, ...rest } = payload
        const by: Record<string, string> = {}
        const at: Record<string, number> = { ...times }
        for (const [who, emoji] of Object.entries(reactionsBy)) {
          if (!(who in list) && (who in times || unnamed.length)) by[who] = emoji
        }
        for (const [who, given] of Object.entries(list)) {
          const known = times[who]
          const newer = given.at !== undefined ? known === undefined || given.at > known : known === undefined
          if (!newer) {
            if (reactionsBy[who]) by[who] = reactionsBy[who]!
            continue
          }
          if (given.emoji) by[who] = given.emoji
          if (given.at !== undefined) at[who] = given.at
        }
        // Those it doesn't say who gave, less others known by name but not named in it (likely
        // them; never mine, which always says so).
        const unlisted = Object.fromEntries(Object.entries(by).filter(([who]) => who !== 'me' && !(who in list)))
        const anonymous = minus(unnamed, totals(unlisted))
        const base = anonymous.length ? anonymous : undefined
        const same =
          !reactionTotals &&
          sameRecord(reactionsBy, by) &&
          sameRecord(times, at) &&
          JSON.stringify(reactionBase ?? null) === JSON.stringify(base ?? null)
        return same
          ? null
          : {
              ...rest,
              reactionsBy: by,
              ...(Object.keys(at).length ? { reactedAt: at } : {}),
              ...(base ? { reactionBase: base } : {}),
            }
      })
    },

    /** The network reported new totals (Telegram doesn't always say who). */
    async setReactionTotals(userId: ObjectId, id: string, reactions: Reaction[]): Promise<Message | null> {
      return updatePayload(userId, id, (payload) => {
        if (payload.deleted) return null
        const { reactionsBy, reactionBase, reactedAt, ...rest } = payload
        void reactionsBy
        void reactionBase
        void reactedAt
        return { ...rest, reactionTotals: reactions }
      })
    },

    /**
     * Gives a kept message the links to its sticker, photo or file, if it had none. One deleted
     * since stays deleted; one edited since keeps its new text. Returns it if it changed.
     */
    async linkFiles(userId: ObjectId, id: string, body: string, attachments: NonNullable<Message['attachments']>): Promise<Message | null> {
      return updatePayload(
        userId,
        id,
        (payload) =>
          payload.deleted || payload.attachments?.some((a) => a.url) ? null : { ...payload, body: payload.editedAt ? payload.body : body, attachments },
        lacksFile({ body, attachments }) ? {} : { filesOk: true },
      )
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
      const stored = await col.messages.findOne({
        userId,
        id: before.id,
        threadId,
      })
      const sentAt = stored?.sentAt ?? (before.sentAt ? new Date(before.sentAt) : null)
      if (!sentAt || Number.isNaN(sentAt.getTime())) return { messages: [], hasMore: false }
      const docs = await col.messages
        .find({ userId, threadId, sentAt: { $lt: sentAt } })
        .sort({ sentAt: -1 })
        .limit(limit + 1)
        .toArray()
      return {
        messages: docs.slice(0, limit).reverse().map(toMessage),
        hasMore: docs.length > limit,
      }
    },

    /**
     * Recent messages whose sticker, photo or file can't be opened: kept before files were fetched
     * from the network (a sticker was only named then). Newest first, for asking the network again;
     * each is asked for at most once a day (see markFilesAsked; some never get one), so the next
     * ones get their turn.
     */
    async missingFiles(userId: ObjectId, idPrefix: string, limit = 40): Promise<{ id: string; threadId: string; ref?: Record<string, unknown> }[]> {
      // Each is read (and opened) at most once to find out: those with nothing missing are marked.
      const docs = await col.messages
        .find({
          userId,
          id: { $regex: `^${escapeRegex(idPrefix)}` },
          filesOk: { $ne: true },
          $or: [
            { fileAskedAt: { $exists: false } },
            {
              fileAskedAt: { $lt: new Date(Date.now() - FILE_ASKED_AGAIN_MS) },
            },
          ],
        })
        .sort({ sentAt: -1 })
        .limit(2000)
        .toArray()
      const found: {
        id: string
        threadId: string
        ref?: Record<string, unknown>
      }[] = []
      const ok: string[] = []
      for (const doc of docs) {
        if (lacksFile(toMessage(doc)))
          found.push({
            id: doc.id,
            threadId: doc.threadId,
            ...(doc.ref ? { ref: doc.ref } : {}),
          })
        else ok.push(doc.id)
        if (found.length >= limit) break
      }
      if (ok.length) await col.messages.updateMany({ userId, id: { $in: ok } }, { $set: { filesOk: true } })
      return found
    },

    /** Those just asked of the network again (see missingFiles). */
    async markFilesAsked(userId: ObjectId, ids: string[]) {
      if (ids.length) await col.messages.updateMany({ userId, id: { $in: ids } }, { $set: { fileAskedAt: new Date() } })
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
        .find({
          userId,
          threadId,
          senderId: 'me',
          status: { $in: ['sent', 'delivered'] },
          'ref.id': { $lte: upToRefId },
        })
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

    /** The chat's latest message that the network knows by `ref.<field>`, and when it was sent. */
    async latestRef(userId: ObjectId, threadId: string, field: string): Promise<{ ref?: Record<string, unknown>; sentAt: Date } | null> {
      const doc = await col.messages
        .find({ userId, threadId, [`ref.${field}`]: { $exists: true } }, { projection: { ref: 1, sentAt: 1 } })
        .sort({ sentAt: -1 })
        .limit(1)
        .next()
      return doc && { ...(doc.ref ? { ref: doc.ref } : {}), sentAt: doc.sentAt }
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
      // Pinned and starred ones too, however old: the chat's pinned bar and Starred list need them.
      const flagged = await col.messages
        .find({ userId, threadId: { $in: ids }, $or: [{ pinned: true }, { starred: true }] })
        .limit(2000)
        .toArray()
      const latest = grouped.flatMap((g) => g.docs)
      const seen = new Set(latest.map((d) => d.id))
      const contactDocs = await col.contacts.find({ userId }).limit(5000).toArray()
      return {
        threads: threadDocs.map(toThread),
        contacts: contactDocs.map(toContact),
        messages: [...latest, ...flagged.filter((d) => !seen.has(d.id))].map(toMessage),
        // Every chat's, not only those sent: a device remembers having them all.
        ...deletions(
          await col.threads.find({ userId, 'deletedIds.0': { $exists: true } }, { projection: { id: 1, deletedIds: 1 } }).toArray(),
          new Set(ids),
        ),
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
