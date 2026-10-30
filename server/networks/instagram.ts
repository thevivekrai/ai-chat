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
import { createInstagramWeb, type Credentials, type IgThread, type IgUser, type InstagramSession, type InstagramSite, type PendingSignIn } from './instagramWeb.ts'

/**
 * Instagram DMs as another linked network.
 *
 * Instagram has no bridge for a person's own inbox — Meta's Messaging API only covers DMs sent to
 * a business account — so this signs in as the website does (see instagramWeb.ts) and keeps the
 * session it gets back, sealed. The password is never kept: once signed in, the session is what's
 * used, and if Instagram throws it out the user links again.
 *
 * Instagram has no stream to listen to here either, so the chats are looked at every so often. A
 * message takes up to that long to arrive; replies go out at once.
 *
 * Meta does not allow this, and a sign-in from a server is often challenged. Everything that can
 * go wrong is turned into something Settings can say.
 */

/** Chat ids are "ig:<thread id>"; people in groups, "ig:u:<user id>"; messages, "<chat>:<item id>". */
const PREFIX = 'ig:'
const PERSON = 'ig:u:'

/** How often the chats are looked at: Instagram has no stream, and polling it hard is noticed. */
const CATCH_UP_MS = 45_000

interface Session {
  userId: ObjectId
  key: string
  site: InstagramSession
  me: IgUser
  timer?: ReturnType<typeof setInterval>
  stopped: boolean
  /** What's going wrong, as last told to the user. */
  problem?: string
  /** Chats already read in, so a look doesn't re-announce what's already here. */
  imported: Set<string>
  /** Each chat's latest message, as Instagram last reported it. */
  latest: Map<string, number>
  syncing?: Promise<void>
}

/** A sign-in waiting for its code, kept sealed on the account until the user types it. */
interface Linking {
  pending: PendingSignIn
}

export interface InstagramDeps {
  sealer: Sealer
  store: InboxStore
  accounts: Accounts
  hub: Hub
  avatars: Avatars
  files: FileLinks
  /** Tests stand in for Instagram itself. */
  site?: InstagramSite
  /** How often to look for new messages (tests shorten it). */
  catchUpMs?: number
  /** Whether this server offers Instagram at all. */
  enabled?: boolean
}

export function createInstagram({ sealer, store, accounts, hub, avatars, files, site, catchUpMs, enabled = true }: InstagramDeps) {
  const sessions = new Map<string, Session>()
  const instagram = site ?? createInstagramWeb()

  const publish = (s: Session, event: Parameters<Hub['publish']>[1]) => hub.publish(s.userId.toHexString(), event)
  /** Unlinking deletes the chats, so a look still in flight then must not write them back. */
  const live = (s: Session) => !s.stopped && sessions.get(s.key) === s
  const labelOf = (me: IgUser) => `@${me.username}`

  /* ── Incoming chats and messages ─────────────────────────────────────────── */

  /** The person a one-to-one chat is with, or whoever wrote in a group. */
  async function upsertContact(s: Session, id: string, person: IgUser) {
    const contact = {
      id,
      name: person.fullName || person.username,
      network: 'instagram' as const,
      handle: `@${person.username}`,
    }
    if (await store.upsertContact(s.userId, contact)) publish(s, { type: 'contact.updated', contact })
    if (person.pictureUrl) void savePicture(s, id, person.pictureUrl)
  }

  /** Keeps a profile photo here, so chats show it without the browser going to Instagram. */
  async function savePicture(s: Session, id: string, url: string) {
    if (s.stopped || (await avatars.fresh(s.userId, id))) return
    const picture = await s.site.fetchImage(url)
    if (!picture || s.stopped) return
    await avatars.save(s.userId, id, { data: picture.data, contentType: picture.contentType }, url)
    const contact = await store.contact(s.userId, id)
    if (contact) publish(s, { type: 'contact.updated', contact })
  }

  const attachmentOf = (userId: ObjectId, url: string): Attachment => {
    const ref: FileRef = { n: 'ig', url, name: 'Photo', mime: 'image/jpeg' }
    return { kind: 'image', name: 'Photo', mime: 'image/jpeg', url: files.urlFor(userId, ref) }
  }

  const titleOf = (thread: IgThread, meId: string) => {
    if (thread.title) return thread.title
    const others = thread.people.filter((p) => p.id !== meId)
    return others.map((p) => p.fullName || p.username).join(', ') || 'Instagram'
  }

  /** Stores one message of a chat; says whether it was new here. */
  async function saveMessage(s: Session, thread: IgThread, m: IgThread['messages'][number], { announce }: { announce: boolean }) {
    if (!live(s)) return null
    const threadId = `${PREFIX}${thread.id}`
    const mine = m.userId === s.me.id
    const sender = thread.people.find((p) => p.id === m.userId)
    const senderId = mine ? 'me' : thread.group ? `${PERSON}${m.userId}` : threadId
    if (!mine && thread.group && sender) {
      await upsertContact(s, senderId, sender)
      await store.addParticipant(s.userId, threadId, senderId)
    }

    const message: StoredMessage = {
      id: `${threadId}:${m.id}`,
      threadId,
      senderId,
      body: m.text ?? '',
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

  /** The chats as Instagram has them now, and anything new in them. */
  async function sync(s: Session, { announce = false } = {}) {
    const { me, threads } = await s.site.inbox()
    if (!live(s)) return
    s.me = me

    let changed = false
    for (const thread of threads) {
      if (!live(s)) return
      const threadId = `${PREFIX}${thread.id}`
      const known = await store.thread(s.userId, threadId)
      // Instagram lists chats nobody has written in yet; they aren't chats until someone does.
      if (!thread.messages.length && !known) continue
      const other = thread.people.find((p) => p.id !== me.id)
      await store.upsertThread(s.userId, {
        id: threadId,
        network: 'instagram',
        kind: thread.group ? 'group' : 'direct',
        title: titleOf(thread, me.id),
        ...(thread.group ? {} : { participantIds: [threadId] }),
        lastAt: new Date(thread.lastAt),
      })
      if (!thread.group && other) await upsertContact(s, threadId, other)

      const seen = s.latest.get(thread.id)
      const first = !s.imported.has(thread.id)
      if (first || !seen || thread.lastAt > seen) {
        for (const m of thread.messages) await saveMessage(s, thread, m, { announce: !first })
        s.imported.add(thread.id)
        changed = true
      } else if (!known) {
        changed = true
      }
      s.latest.set(thread.id, thread.lastAt)
      // Instagram's own count is what the queue shows; opening the chat here clears it there too.
      await store.setUnread(s.userId, threadId, thread.unread)
    }
    if ((announce || changed) && live(s)) publish(s, { type: 'reloaded' })
  }

  /** Looks, and says in Settings how it went. One look at a time: a slow one isn't doubled up. */
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
      problem = error instanceof HttpError ? error.message : "Couldn't read your Instagram chats."
      signedOut = error instanceof HttpError && error.status === 401
      console.error('[instagram] sync failed:', problem)
    }
    if (!live(s)) return
    // A session Instagram has thrown out never comes back by itself: it needs linking again.
    if (signedOut) {
      stop(s.key)
      await accounts.set(s.userId, 'instagram', { status: 'disconnected', label: labelOf(s.me), detail: problem })
      return
    }
    if (s.problem === problem) return
    s.problem = problem
    await accounts.set(s.userId, 'instagram', {
      status: problem ? 'error' : 'connected',
      label: labelOf(s.me),
      ...(problem ? { detail: problem } : {}),
    })
  }

  /* ── Sessions ────────────────────────────────────────────────────────────── */

  function connected(userId: ObjectId): Session {
    const s = sessions.get(userId.toHexString())
    if (!s) throw new HttpError(409, 'Instagram is not linked.')
    return s
  }

  function stop(key: string) {
    const s = sessions.get(key)
    if (!s) return
    s.stopped = true
    if (s.timer) clearInterval(s.timer)
    sessions.delete(key)
  }

  /** Reads the chats in and keeps looking. */
  async function start(userId: ObjectId, signedIn: InstagramSession, me: IgUser) {
    const key = userId.toHexString()
    stop(key)
    // Linking a different Instagram account: the chats here are the old account's, so they go.
    const linked = await accounts.get(userId, 'instagram')
    if (linked?.label && linked.label !== labelOf(me)) {
      await store.forgetNetwork(userId, PREFIX)
      avatars.forget(userId, PREFIX)
    }
    const s: Session = { userId, key, site: signedIn, me, stopped: false, imported: new Set(), latest: new Map() }
    sessions.set(key, s)
    await accounts.set(userId, 'instagram', { status: 'connected', label: labelOf(me) })
    s.timer = setInterval(() => void syncAndNote(s), catchUpMs ?? CATCH_UP_MS)
    s.timer.unref?.()
    await syncAndNote(s, { announce: true })
    return s
  }

  /** Signed in: whoever that is, and their chats, from here on. */
  async function began(userId: ObjectId, signedIn: InstagramSession) {
    const { me } = await signedIn.inbox()
    const s = await start(userId, signedIn, me)
    await accounts.set(userId, 'instagram', {
      status: s.problem ? 'error' : 'connected',
      label: labelOf(me),
      ...(s.problem ? { detail: s.problem } : {}),
      session: sealer.seal(signedIn.save()),
    })
    return { username: me.username, fullName: me.fullName ?? '' }
  }

  /** Puts the account back as it was when an attempt fails, so a typo costs nothing. */
  async function restore(userId: ObjectId, before: { label?: string; session?: string } | null, error: unknown) {
    const detail = error instanceof HttpError ? error.message : 'Signing in to Instagram failed.'
    if (before?.session) {
      await accounts.set(userId, 'instagram', {
        status: 'error',
        ...(before.label ? { label: before.label } : {}),
        detail,
        session: before.session,
      })
    } else {
      stop(userId.toHexString())
      await accounts.remove(userId, 'instagram')
    }
  }

  const threadOf = (threadId: string) => threadId.slice(PREFIX.length)
  const messageOf = (messageId: string) => messageId.slice(messageId.lastIndexOf(':') + 1)

  return {
    /** Whether this server offers Instagram at all. */
    enabled,

    isConnected(userId: ObjectId) {
      return sessions.has(userId.toHexString())
    },

    /**
     * Signs in. Instagram often wants a code as well — then this says so, and the code goes to
     * `verifyCode`. The password is only used here; it's never stored.
     */
    async link(userId: ObjectId, credentials: Credentials): Promise<{ step: 'code'; via: PendingSignIn['via'] } | { username: string; fullName: string }> {
      if (!enabled) throw new HttpError(503, 'This server has Instagram turned off.')
      const before = await accounts.get(userId, 'instagram')
      await accounts.set(userId, 'instagram', {
        status: 'linking',
        ...(before?.label ? { label: before.label } : {}),
        detail: 'Signing in to Instagram…',
      })
      try {
        const result = await instagram.signIn(credentials)
        if (!result.done) {
          await accounts.set(userId, 'instagram', {
            status: 'linking',
            step: 'code',
            ...(before?.label ? { label: before.label } : {}),
            detail:
              result.pending.via === 'app'
                ? 'Instagram wants the code from your authentication app.'
                : `Instagram sent a code by ${result.pending.via === 'sms' ? 'text message' : 'email'}.`,
            session: sealer.sealJson({ pending: result.pending } satisfies Linking),
          })
          return { step: 'code', via: result.pending.via }
        }
        return await began(userId, result.session)
      } catch (error) {
        await restore(userId, before, error)
        throw error
      }
    },

    /**
     * A session the user signed in to on instagram.com in their own browser: no password here, and
     * Instagram's security check happens where it can actually reach them.
     */
    async linkWithSession(userId: ObjectId, cookies: string) {
      if (!enabled) throw new HttpError(503, 'This server has Instagram turned off.')
      const before = await accounts.get(userId, 'instagram')
      await accounts.set(userId, 'instagram', {
        status: 'linking',
        ...(before?.label ? { label: before.label } : {}),
        detail: 'Checking the session with Instagram…',
      })
      try {
        return await began(userId, await instagram.fromBrowser(cookies))
      } catch (error) {
        await restore(userId, before, error)
        throw error
      }
    },

    /** The code Instagram asked for. */
    async verifyCode(userId: ObjectId, code: string) {
      const account = await accounts.get(userId, 'instagram')
      if (account?.status !== 'linking' || account.step !== 'code' || !account.session) {
        throw new HttpError(409, 'Start linking Instagram again: there is no sign-in waiting for a code.')
      }
      let waiting: Linking
      try {
        waiting = sealer.openJson<Linking>(account.session)
      } catch {
        throw new HttpError(409, 'That sign-in has expired. Link Instagram again.')
      }
      try {
        const result = await instagram.submitCode(waiting.pending, code)
        // Instagram only ever asks for one code; anything else means starting over.
        if (!result.done) throw new HttpError(409, 'Instagram asked for another code. Link again.')
        return await began(userId, result.session)
      } catch (error) {
        // A wrong code leaves the sign-in waiting, so the next try doesn't start from scratch.
        if (error instanceof HttpError && error.status === 401) {
          await accounts.set(userId, 'instagram', {
            status: 'linking',
            step: 'code',
            ...(account.label ? { label: account.label } : {}),
            detail: error.message,
            session: account.session,
          })
          throw error
        }
        await restore(userId, null, error)
        throw error
      }
    },

    async unlink(userId: ObjectId) {
      stop(userId.toHexString())
      await accounts.remove(userId, 'instagram')
      await store.forgetNetwork(userId, PREFIX)
      avatars.forget(userId, PREFIX)
      hub.publish(userId.toHexString(), { type: 'reloaded' })
    },

    /** Picks every linked account back up: on start, and every few minutes after that. */
    async resumeAll() {
      if (!enabled) return
      for (const doc of await accounts.toResume('instagram')) {
        if (sessions.has(doc.userId.toHexString()) || !doc.session || doc.step === 'code') continue
        let signedIn: InstagramSession
        try {
          signedIn = instagram.restore(sealer.open(doc.session))
        } catch {
          continue
        }
        try {
          const { me } = await signedIn.inbox()
          await start(doc.userId, signedIn, me)
        } catch (error) {
          const detail = error instanceof HttpError ? error.message : "Couldn't reach Instagram."
          const gone = error instanceof HttpError && error.status === 401
          // Thrown out: only a new sign-in helps. Anything else is tried again in a few minutes.
          await accounts.set(doc.userId, 'instagram', {
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
      const stored: StoredMessage = {
        id: `${threadId}:${sent.id}`,
        threadId,
        senderId: 'me',
        body,
        sentAt: new Date(sent.sentAt).toISOString(),
        status: 'sent',
      }
      await store.addMessage(s.userId, stored)
      const known = await store.thread(s.userId, threadId)
      if (known) {
        const thread = await store.upsertThread(s.userId, {
          id: threadId,
          network: 'instagram',
          kind: known.kind,
          lastAt: new Date(sent.sentAt),
        })
        publish(s, { type: 'thread.updated', thread })
      }
      return stored
    },

    async sendFile(userId: ObjectId, _threadId: string, _upload: Upload, _caption: string): Promise<Message> {
      connected(userId)
      throw new HttpError(415, "Sytext can't send photos to Instagram yet — text only.")
    },

    /** A photo in a chat, fetched from where Instagram keeps it. */
    async openFile(userId: ObjectId, ref: FileRef): Promise<FileBody> {
      if (ref.n !== 'ig') throw new HttpError(404, 'No such file.')
      const s = connected(userId)
      const image = await s.site.fetchImage(ref.url)
      // Instagram's photo links run out after a while; the chat keeps the message either way.
      if (!image) throw new HttpError(502, "That photo couldn't be fetched. Instagram's link to it may have expired.")
      return { data: image.data, name: ref.name, mime: image.contentType }
    },

    async picture(userId: ObjectId, id: string): Promise<Picture | null> {
      const s = sessions.get(userId.toHexString())
      if (!s) return null
      const { threads } = await s.site.inbox()
      for (const thread of threads) {
        const person = thread.people.find((p) => `${PREFIX}${thread.id}` === id || `${PERSON}${p.id}` === id)
        if (person?.pictureUrl) {
          const image = await s.site.fetchImage(person.pictureUrl)
          return image ? { data: image.data, contentType: image.contentType } : null
        }
      }
      return null
    },

    /** Tells Instagram the chat was read, as opening it on the website does. */
    async markRead(userId: ObjectId, threadId: string, { receipt = true, strict = false }: { receipt?: boolean; strict?: boolean } = {}) {
      const s = connected(userId)
      await store.markReadHere(userId, threadId, { receipt })
      if (!receipt) return
      const latest = (await store.recentIncoming(userId, threadId)).at(-1)
      if (!latest) return
      try {
        await s.site.markSeen(threadOf(threadId), messageOf(latest.id))
      } catch (error) {
        if (strict) throw error
        console.warn('[instagram] read receipt failed:', error instanceof Error ? error.message : error)
      }
    },

    /** Only the latest messages of each chat come from Instagram, so there is nothing older here. */
    async loadOlder(): Promise<ServerOlderMessages> {
      return { messages: [], hasMore: false }
    },

    /** Starring, pinning and deleting for me are Sytext's own; Instagram isn't told. */
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
          if (action.forEveryone) throw new HttpError(409, "Sytext can't unsend Instagram messages.")
          await store.deleteMessage(userId, threadId, messageId)
          hub.publish(userId.toHexString(), { type: 'message.deleted', threadId, messageId })
          return { message: null, removed: true }
        case 'edit':
          throw new HttpError(409, "Instagram messages can't be edited.")
      }
    },

    async react(): Promise<Message | null> {
      throw new HttpError(409, "Sytext can't react to Instagram messages yet.")
    },

    /** Nothing is sent to Instagram while typing. */
    async setTyping() {},

    /** Instagram's own archive isn't reachable here, so archiving is kept in Sytext. */
    async archive(userId: ObjectId, threadId: string, archived: boolean): Promise<Thread> {
      connected(userId)
      const thread = await store.setArchived(userId, threadId, archived)
      if (!thread) throw new HttpError(404, 'No such chat.')
      hub.publish(userId.toHexString(), { type: 'thread.updated', thread })
      return thread
    },

    /** Stops every session (tests, and shutting down). */
    stopAll() {
      for (const key of [...sessions.keys()]) stop(key)
    },
  }
}

export type Instagram = ReturnType<typeof createInstagram>
