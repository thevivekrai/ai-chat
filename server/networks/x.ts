import type { ObjectId } from 'mongodb'
import type { ServerOlderMessages } from '../../src/data/server/types.ts'
import type { Attachment, Message, MessageAction, Thread } from '../../src/data/types.ts'
import type { Sealer } from '../crypto.ts'
import { HttpError } from '../http.ts'
import type { Avatars, Picture } from '../inbox/avatars.ts'
import type { FileBody, FileLinks, FileRef, Upload } from '../inbox/files.ts'
import type { InboxStore, StoredMessage } from '../inbox/store.ts'
import type { Hub } from '../realtime.ts'
import type { Accounts } from './accounts.ts'
import { createXWeb, type XConversation, type XSession, type XSite, type XUser } from './xWeb.ts'

/**
 * X (Twitter) DMs as another linked network: Sytext's own bridge, no Matrix in between.
 *
 * Linked with the session of the user's own browser (see xWeb.ts), kept sealed. X has no stream
 * to listen to here, so the inbox is looked at every so often: a message takes up to that long
 * to arrive, and replies go out at once. If X throws the session out, the user links again.
 */

/** Chat ids are "x:<conversation id>"; people in groups, "x:u:<user id>"; messages, "<chat>:<id>". */
const PREFIX = 'x:'
const PERSON = 'x:u:'

/** How often the inbox is looked at: X has no stream here, and polling it hard is noticed. */
const CATCH_UP_MS = 45_000

interface Session {
  userId: ObjectId
  key: string
  site: XSession
  me: XUser
  timer?: ReturnType<typeof setInterval>
  stopped: boolean
  /** What's going wrong, as last told to the user. */
  problem?: string
  /** Conversations already read in, so a look doesn't re-announce what's already here. */
  imported: Set<string>
  /** Each conversation's latest activity, as X last reported it. */
  latest: Map<string, number>
  syncing?: Promise<void>
}

export interface XDeps {
  sealer: Sealer
  store: InboxStore
  accounts: Accounts
  hub: Hub
  avatars: Avatars
  files: FileLinks
  /** Tests stand in for X itself. */
  site?: XSite
  /** How often to look for new messages (tests shorten it). */
  catchUpMs?: number
  /** Whether this server offers X at all. */
  enabled?: boolean
}

export function createX({ sealer, store, accounts, hub, avatars, files, site, catchUpMs, enabled = true }: XDeps) {
  const sessions = new Map<string, Session>()
  const x = site ?? createXWeb()

  const publish = (s: Session, event: Parameters<Hub['publish']>[1]) => hub.publish(s.userId.toHexString(), event)
  /** Unlinking deletes the chats, so a look still in flight then must not write them back. */
  const live = (s: Session) => !s.stopped && sessions.get(s.key) === s
  const labelOf = (me: XUser) => `@${me.handle}`

  /* ── Incoming chats and messages ─────────────────────────────────────────── */

  async function upsertContact(s: Session, id: string, person: XUser) {
    const contact = { id, name: person.name || person.handle, network: 'x' as const, handle: `@${person.handle}` }
    if (await store.upsertContact(s.userId, contact)) publish(s, { type: 'contact.updated', contact })
    if (person.pictureUrl) void savePicture(s, id, person.pictureUrl)
  }

  /** Keeps a profile photo here, so chats show it without the browser going to X. */
  async function savePicture(s: Session, id: string, url: string) {
    if (s.stopped || (await avatars.fresh(s.userId, id))) return
    const picture = await s.site.fetchImage(url)
    if (!picture || s.stopped) return
    await avatars.save(s.userId, id, { data: picture.data, contentType: picture.contentType }, url)
    const contact = await store.contact(s.userId, id)
    if (contact) publish(s, { type: 'contact.updated', contact })
  }

  const attachmentOf = (userId: ObjectId, url: string): Attachment => {
    const ref: FileRef = { n: 'x', url, name: 'Photo', mime: 'image/jpeg' }
    return { kind: 'image', name: 'Photo', mime: 'image/jpeg', url: files.urlFor(userId, ref) }
  }

  const titleOf = (c: XConversation, meId: string) => {
    if (c.title) return c.title
    const others = c.people.filter((p) => p.id !== meId)
    return others.map((p) => p.name || p.handle).join(', ') || 'X'
  }

  /** Stores one message of a conversation; says whether it was new here. */
  async function saveMessage(s: Session, c: XConversation, m: XConversation['messages'][number], { announce }: { announce: boolean }) {
    if (!live(s)) return null
    const threadId = `${PREFIX}${c.id}`
    const mine = m.senderId === s.me.id
    const sender = c.people.find((p) => p.id === m.senderId)
    const senderId = mine ? 'me' : c.group ? `${PERSON}${m.senderId}` : threadId
    if (!mine && c.group && sender) {
      await upsertContact(s, senderId, sender)
      await store.addParticipant(s.userId, threadId, senderId)
    }
    const message: StoredMessage = {
      id: `${threadId}:${m.id}`,
      threadId,
      senderId,
      body: m.text,
      sentAt: new Date(m.sentAt).toISOString(),
      ...(mine ? { status: 'sent' as const } : {}),
      ...(m.photoUrl ? { attachments: [attachmentOf(s.userId, m.photoUrl)] } : {}),
    }
    const added = await store.addMessage(s.userId, message)
    if (!added || !announce || !live(s)) return { message, added }
    const stored = await store.thread(s.userId, threadId)
    if (stored) publish(s, { type: 'thread.updated', thread: stored })
    publish(s, { type: 'message.created', message })
    return { message, added }
  }

  /** The conversations as X has them now, and anything new in them. */
  async function sync(s: Session, { announce = false } = {}) {
    const { me, conversations } = await s.site.inbox()
    if (!live(s)) return
    s.me = me
    let changed = false
    for (const c of conversations) {
      if (!live(s)) return
      const threadId = `${PREFIX}${c.id}`
      const known = await store.thread(s.userId, threadId)
      if (!c.messages.length && !known) continue
      const other = c.people.find((p) => p.id !== me.id)
      await store.upsertThread(s.userId, {
        id: threadId,
        network: 'x',
        kind: c.group ? 'group' : 'direct',
        title: titleOf(c, me.id),
        ...(c.group ? {} : { participantIds: [threadId] }),
        lastAt: new Date(c.lastAt),
      })
      if (!c.group && other) await upsertContact(s, threadId, other)

      const seen = s.latest.get(c.id)
      const first = !s.imported.has(c.id)
      if (first || !seen || c.lastAt > seen) {
        for (const m of c.messages) await saveMessage(s, c, m, { announce: !first })
        s.imported.add(c.id)
        changed = true
      } else if (!known) {
        changed = true
      }
      s.latest.set(c.id, c.lastAt)
      await store.setUnread(s.userId, threadId, c.unread)
    }
    if ((announce || changed) && live(s)) publish(s, { type: 'reloaded' })
  }

  /** Looks, and says in Settings how it went. One look at a time. */
  async function syncAndNote(s: Session, options?: { announce?: boolean }) {
    if (s.syncing) return s.syncing
    const run = syncAndNoteNow(s, options)
    s.syncing = run
    try {
      await run
    } finally {
      s.syncing = undefined
    }
  }

  async function syncAndNoteNow(s: Session, options?: { announce?: boolean }) {
    let problem: string | undefined
    let signedOut = false
    try {
      await sync(s, options)
    } catch (error) {
      problem = error instanceof HttpError ? error.message : "Couldn't read your X messages."
      signedOut = error instanceof HttpError && error.status === 401
      console.error('[x] sync failed:', problem)
    }
    if (!live(s)) return
    // A session X has thrown out never comes back by itself: it needs linking again.
    if (signedOut) {
      stop(s.key)
      await accounts.set(s.userId, 'x', { status: 'disconnected', label: labelOf(s.me), detail: problem })
      return
    }
    if (s.problem === problem) return
    s.problem = problem
    await accounts.set(s.userId, 'x', {
      status: problem ? 'error' : 'connected',
      label: labelOf(s.me),
      ...(problem ? { detail: problem } : {}),
    })
  }

  /* ── Sessions ────────────────────────────────────────────────────────────── */

  function connected(userId: ObjectId): Session {
    const s = sessions.get(userId.toHexString())
    if (!s) throw new HttpError(409, 'X is not linked.')
    return s
  }

  function stop(key: string) {
    const s = sessions.get(key)
    if (!s) return
    s.stopped = true
    if (s.timer) clearInterval(s.timer)
    sessions.delete(key)
  }

  async function start(userId: ObjectId, signedIn: XSession, me: XUser) {
    const key = userId.toHexString()
    stop(key)
    // A different X account: the chats here are the old account's, so they go.
    const linked = await accounts.get(userId, 'x')
    if (linked?.label && linked.label !== labelOf(me)) {
      await store.forgetNetwork(userId, PREFIX)
      avatars.forget(userId, PREFIX)
    }
    const s: Session = { userId, key, site: signedIn, me, stopped: false, imported: new Set(), latest: new Map() }
    sessions.set(key, s)
    await accounts.set(userId, 'x', { status: 'connected', label: labelOf(me) })
    s.timer = setInterval(() => void syncAndNote(s), catchUpMs ?? CATCH_UP_MS)
    s.timer.unref?.()
    await syncAndNote(s, { announce: true })
    return s
  }

  const threadOf = (threadId: string) => threadId.slice(PREFIX.length)
  const messageOf = (messageId: string) => messageId.slice(messageId.lastIndexOf(':') + 1)

  return {
    enabled,

    isConnected(userId: ObjectId) {
      return sessions.has(userId.toHexString())
    },

    /** Links with the cookies of a session the user signed in to on x.com. No password here. */
    async link(userId: ObjectId, cookies: string): Promise<{ username: string; fullName: string }> {
      if (!enabled) throw new HttpError(503, 'This server has X turned off.')
      const before = await accounts.get(userId, 'x')
      await accounts.set(userId, 'x', { status: 'linking', ...(before?.label ? { label: before.label } : {}), detail: 'Checking the session with X…' })
      try {
        const signedIn = await x.fromBrowser(cookies)
        const { me } = await signedIn.inbox()
        const s = await start(userId, signedIn, me)
        await accounts.set(userId, 'x', {
          status: s.problem ? 'error' : 'connected',
          label: labelOf(me),
          ...(s.problem ? { detail: s.problem } : {}),
          session: sealer.seal(signedIn.save()),
        })
        return { username: me.handle, fullName: me.name }
      } catch (error) {
        const detail = error instanceof HttpError ? error.message : 'Linking X failed.'
        if (before?.session) {
          await accounts.set(userId, 'x', { status: 'error', ...(before.label ? { label: before.label } : {}), detail, session: before.session })
        } else {
          stop(userId.toHexString())
          await accounts.remove(userId, 'x')
        }
        throw error
      }
    },

    async unlink(userId: ObjectId) {
      stop(userId.toHexString())
      await accounts.remove(userId, 'x')
      await store.forgetNetwork(userId, PREFIX)
      avatars.forget(userId, PREFIX)
      hub.publish(userId.toHexString(), { type: 'reloaded' })
    },

    /** Picks every linked account back up: on start, and every few minutes after that. */
    async resumeAll() {
      if (!enabled) return
      for (const doc of await accounts.toResume('x')) {
        if (sessions.has(doc.userId.toHexString()) || !doc.session) continue
        let signedIn: XSession
        try {
          signedIn = x.restore(sealer.open(doc.session))
        } catch {
          continue
        }
        try {
          const { me } = await signedIn.inbox()
          await start(doc.userId, signedIn, me)
        } catch (error) {
          const detail = error instanceof HttpError ? error.message : "Couldn't reach X."
          const gone = error instanceof HttpError && error.status === 401
          await accounts.set(doc.userId, 'x', {
            status: gone ? 'disconnected' : 'error',
            ...(doc.label ? { label: doc.label } : {}),
            detail,
            ...(gone ? {} : { session: doc.session }),
          })
        }
      }
    },

    async send(userId: ObjectId, threadId: string, body: string): Promise<Message> {
      const s = connected(userId)
      const sent = await s.site.sendText(threadOf(threadId), body)
      const stored: StoredMessage = { id: `${threadId}:${sent.id}`, threadId, senderId: 'me', body, sentAt: new Date(sent.sentAt).toISOString(), status: 'sent' }
      await store.addMessage(s.userId, stored)
      const known = await store.thread(s.userId, threadId)
      if (known) {
        const thread = await store.upsertThread(s.userId, { id: threadId, network: 'x', kind: known.kind, lastAt: new Date(sent.sentAt) })
        publish(s, { type: 'thread.updated', thread })
      }
      return stored
    },

    async sendFile(userId: ObjectId, _threadId: string, _upload: Upload, _caption: string): Promise<Message> {
      connected(userId)
      throw new HttpError(415, "Sytext can't send photos to X yet — text only.")
    },

    /** A photo in a DM, fetched with the session (X keeps those behind it). */
    async openFile(userId: ObjectId, ref: FileRef): Promise<FileBody> {
      if (ref.n !== 'x') throw new HttpError(404, 'No such file.')
      const s = connected(userId)
      const image = await s.site.fetchImage(ref.url)
      if (!image) throw new HttpError(502, "That photo couldn't be fetched from X.")
      return { data: image.data, name: ref.name, mime: image.contentType }
    },

    async picture(userId: ObjectId, id: string): Promise<Picture | null> {
      const s = sessions.get(userId.toHexString())
      if (!s) return null
      const { conversations } = await s.site.inbox()
      for (const c of conversations) {
        const person = c.people.find((p) => p.id !== s.me.id && (`${PREFIX}${c.id}` === id || `${PERSON}${p.id}` === id))
        if (person?.pictureUrl) {
          const image = await s.site.fetchImage(person.pictureUrl)
          return image ? { data: image.data, contentType: image.contentType } : null
        }
      }
      return null
    },

    /** Tells X the conversation was read, as opening it on x.com does. */
    async markRead(userId: ObjectId, threadId: string, { receipt = true, strict = false }: { receipt?: boolean; strict?: boolean } = {}) {
      const s = connected(userId)
      await store.markReadHere(userId, threadId, { receipt })
      if (!receipt) return
      const latest = (await store.recentIncoming(userId, threadId)).at(-1)
      if (!latest) return
      try {
        await s.site.markRead(threadOf(threadId), messageOf(latest.id))
      } catch (error) {
        if (strict) throw error
        console.warn('[x] read receipt failed:', error instanceof Error ? error.message : error)
      }
    },

    /** Only the latest messages of each conversation come from X, so there is nothing older here. */
    async loadOlder(): Promise<ServerOlderMessages> {
      return { messages: [], hasMore: false }
    },

    /** Starring, pinning and deleting for me are Sytext's own; X isn't told. */
    async act(userId: ObjectId, threadId: string, messageId: string, action: MessageAction): Promise<{ message: Message | null; removed?: true }> {
      connected(userId)
      const target = await store.message(userId, messageId)
      if (!target || target.threadId !== threadId) throw new HttpError(404, 'That message is gone.')
      switch (action.type) {
        case 'star':
          return { message: await store.updateMessage(userId, messageId, { starred: action.starred }) }
        case 'pin':
          return { message: await store.updateMessage(userId, messageId, { pinned: action.pinned }) }
        case 'delete':
          if (action.forEveryone) throw new HttpError(409, "Sytext can't unsend X messages.")
          await store.deleteMessage(userId, threadId, messageId)
          hub.publish(userId.toHexString(), { type: 'message.deleted', threadId, messageId })
          return { message: null, removed: true }
        case 'edit':
          throw new HttpError(409, "Sytext can't edit X messages.")
      }
    },

    async react(): Promise<Message | null> {
      throw new HttpError(409, "Sytext can't react to X messages yet.")
    },

    /** Nothing is sent to X while typing. */
    async setTyping() {},

    /** X's own folders aren't reachable here, so archiving is kept in Sytext. */
    async archive(userId: ObjectId, threadId: string, archived: boolean): Promise<Thread> {
      connected(userId)
      const thread = await store.setArchived(userId, threadId, archived)
      if (!thread) throw new HttpError(404, 'No such chat.')
      hub.publish(userId.toHexString(), { type: 'thread.updated', thread })
      return thread
    },

    stopAll() {
      for (const key of [...sessions.keys()]) stop(key)
    },
  }
}

export type X = ReturnType<typeof createX>
