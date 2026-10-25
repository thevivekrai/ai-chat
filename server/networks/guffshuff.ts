import type { ObjectId } from 'mongodb'
import { io, type Socket } from 'socket.io-client'
import type { ServerOlderMessages } from '../../src/data/server/types.ts'
import { fileSize } from '../../src/data/server/types.ts'
import type { Attachment, Message, MessageAction, Thread } from '../../src/data/types.ts'
import type { Sealer } from '../crypto.ts'
import { HttpError } from '../http.ts'
import type { Avatars, Picture } from '../inbox/avatars.ts'
import type { FileBody, FileLinks, FileRef, Upload } from '../inbox/files.ts'
import type { InboxStore, StoredMessage } from '../inbox/store.ts'
import type { Hub } from '../realtime.ts'
import type { Accounts } from './accounts.ts'

/**
 * Guffshuff (the user's own chat site) as another linked network.
 *
 * It has no bridge API of its own, so this signs in the way its website does — username and
 * password, for a cookie that lasts a week — and keeps both sealed, so the link signs itself in
 * again rather than stopping every Monday. Its REST API carries the chats; its socket.io stream
 * carries new messages as they arrive.
 *
 * What it can do is what Guffshuff can do: text and photos, and telling people their messages were
 * read. It has no replies, reactions, edits or typing, so those are refused rather than faked.
 */

/** Chat ids are "gs:<the other person's id>"; messages, "gs:<their id>:<message id>". */
const PREFIX = 'gs:'

/** The site re-checked for chats this often, in case its live stream missed something. */
const CATCH_UP_MS = 2 * 60_000
/** A photo, as base64 inside a JSON body: Guffshuff's own limit is 50 MB, so this is well inside it. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** Guffshuff hands over a whole conversation at once, so only this much of it is worth keeping. */
const IMPORT_PER_CHAT = 200

export interface GuffshuffApi {
  /** Where the site lives, e.g. https://guffshuff.onrender.com. */
  baseUrl: string
  /** Tests stand in for the site. */
  fetch?: typeof fetch
  /** Tests stand in for its live stream. */
  connect?: (url: string, cookie: string) => GuffshuffStream
}

/** The live stream of new messages: socket.io in production, a fake in tests. */
export interface GuffshuffStream {
  on(event: 'newMessage', listener: (message: GsMessage) => void): void
  on(event: 'connect' | 'disconnect', listener: () => void): void
  close(): void
}

interface GsUser {
  _id: string
  fullName?: string
  username?: string
  profilePic?: string
  lastMessageTime?: string | null
}

interface GsMessage {
  _id: string
  senderId: string
  receiverId: string
  text?: string
  image?: string
  seen?: boolean
  createdAt?: string
}

interface Credentials {
  username: string
  password: string
}

interface Session {
  userId: ObjectId
  key: string
  credentials: Credentials
  /** The `jwt` cookie the site handed back, held only in memory. */
  cookie: string
  me: GsUser
  stream?: GuffshuffStream
  timer?: ReturnType<typeof setInterval>
  stopped: boolean
  /** Chats already imported, so a catch-up never re-reads (and so re-reads) a whole conversation. */
  imported: Set<string>
  /** The newest message of each chat, as the site last reported it. */
  latest: Map<string, string>
}

export interface GuffshuffDeps {
  sealer: Sealer
  store: InboxStore
  accounts: Accounts
  hub: Hub
  avatars: Avatars
  files: FileLinks
  api?: GuffshuffApi
}

export function createGuffshuff({ sealer, store, accounts, hub, avatars, files, api }: GuffshuffDeps) {
  const sessions = new Map<string, Session>()
  const call = api?.fetch ?? fetch
  const baseUrl = api?.baseUrl.replace(/\/+$/, '') ?? ''

  const publish = (s: Session, event: Parameters<Hub['publish']>[1]) => hub.publish(s.userId.toHexString(), event)

  /**
   * Whether this session still stands. Unlinking deletes the chats, so anything still in flight
   * then — a sync that was waiting on the site — must not write them back.
   */
  const live = (s: Session) => !s.stopped && sessions.get(s.key) === s

  /* ── Talking to the site ─────────────────────────────────────────────────── */

  /** Signs in as the site's own pages do; returns the session cookie and who it belongs to. */
  async function signIn({ username, password }: Credentials): Promise<{ cookie: string; me: GsUser }> {
    let res: Response
    try {
      res = await call(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
    } catch {
      throw new HttpError(503, `Couldn't reach ${hostOf(baseUrl)}. Check the address and try again.`)
    }
    const body = (await res.json().catch(() => null)) as (GsUser & { message?: string }) | null
    if (res.status === 400) throw new HttpError(401, body?.message ?? 'That username or password is wrong.')
    if (!res.ok || !body?._id) throw new HttpError(502, `${hostOf(baseUrl)} wouldn't sign in (${res.status}).`)
    const cookie = cookieOf(res)
    if (!cookie) throw new HttpError(502, `${hostOf(baseUrl)} signed in but sent no session.`)
    return { cookie, me: body }
  }

  /** A request as the signed-in user. A session that expired is signed in again, once. */
  async function request(s: Session, path: string, init: RequestInit = {}, retry = true): Promise<unknown> {
    let res: Response
    try {
      res = await call(`${baseUrl}${path}`, {
        ...init,
        headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers, cookie: s.cookie },
      })
    } catch {
      throw new HttpError(503, `Couldn't reach ${hostOf(baseUrl)}.`)
    }
    // The cookie lasts a week; when it runs out the stored password gets a new one.
    if (res.status === 401 && retry && !s.stopped) {
      const { cookie, me } = await signIn(s.credentials)
      s.cookie = cookie
      s.me = me
      openStream(s)
      return request(s, path, init, false)
    }
    if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `${hostOf(baseUrl)} answered with an error (${res.status}).`)
    return res.json().catch(() => null)
  }

  /* ── Incoming chats and messages ─────────────────────────────────────────── */

  async function upsertContact(s: Session, person: GsUser) {
    const contact = {
      id: `${PREFIX}${person._id}`,
      name: person.fullName || person.username || 'Guffshuff',
      network: 'guffshuff' as const,
      handle: person.username ? `@${person.username}` : '',
    }
    if (await store.upsertContact(s.userId, contact)) publish(s, { type: 'contact.updated', contact })
    if (person.profilePic) void savePicture(s, contact.id, person.profilePic)
  }

  /** Keeps a profile photo, so chats show it without the browser going to Guffshuff itself. */
  async function savePicture(s: Session, id: string, url: string) {
    if (s.stopped || (await avatars.fresh(s.userId, id))) return
    const picture = await fetchPicture(url)
    if (!picture || s.stopped) return
    await avatars.save(s.userId, id, picture, url)
    const contact = await store.contact(s.userId, id)
    if (contact) publish(s, { type: 'contact.updated', contact })
  }

  async function fetchPicture(url: string): Promise<Picture | null> {
    try {
      const res = await call(url)
      if (!res.ok) return null
      const type = res.headers.get('content-type') ?? ''
      if (!type.startsWith('image/')) return null
      return { data: Buffer.from(await res.arrayBuffer()), contentType: type }
    } catch {
      return null
    }
  }

  const attachmentOf = (userId: ObjectId, url: string): Attachment => {
    const ref: FileRef = { n: 'gs', url, name: 'Photo', mime: 'image/jpeg' }
    return { kind: 'image', name: 'Photo', mime: 'image/jpeg', url: files.urlFor(userId, ref) }
  }

  /** Stores one message of a chat with `otherId`; returns it, and whether it was new here. */
  async function saveMessage(s: Session, m: GsMessage, otherId: string, { live: announce }: { live: boolean }) {
    if (!live(s)) return null
    const threadId = `${PREFIX}${otherId}`
    const mine = String(m.senderId) === String(s.me._id)
    const sentAt = new Date(m.createdAt ?? Date.now())
    await store.upsertThread(s.userId, { id: threadId, network: 'guffshuff', kind: 'direct', participantIds: [threadId], lastAt: sentAt })

    const message: StoredMessage = {
      id: `${threadId}:${m._id}`,
      threadId,
      senderId: mine ? 'me' : threadId,
      body: m.text ?? '',
      sentAt: sentAt.toISOString(),
      // Guffshuff marks a message seen once the other person opens the chat.
      ...(mine ? { status: m.seen ? ('read' as const) : ('sent' as const) } : {}),
      ...(m.image ? { attachments: [attachmentOf(s.userId, m.image)] } : {}),
    }
    const added = await store.addMessage(s.userId, message)
    if (!added) {
      // Already here, but read since (its tick turns from sent to read).
      if (mine && m.seen) await store.updateMessage(s.userId, message.id, { status: 'read' })
      return { message, added }
    }
    if (!announce || !live(s)) return { message, added }

    if (!mine) await store.incrementUnread(s.userId, threadId)
    const thread = await store.thread(s.userId, threadId)
    if (thread) publish(s, { type: 'thread.updated', thread })
    publish(s, { type: 'message.created', message })
    return { message, added }
  }

  /**
   * Reads a whole conversation in. Guffshuff has no way to read a chat without marking it read
   * there (its website does the same on opening one), so this runs once per chat, and new messages
   * come from the live stream instead.
   */
  async function importChat(s: Session, person: GsUser) {
    const otherId = String(person._id)
    const messages = ((await request(s, `/api/messages/${otherId}`)) ?? []) as GsMessage[]
    if (!Array.isArray(messages) || !live(s)) return
    s.imported.add(otherId)
    const latest = messages.slice(-IMPORT_PER_CHAT)
    for (const m of latest) await saveMessage(s, m, otherId, { live: false })
    const newest = latest[latest.length - 1]
    if (newest?.createdAt) s.latest.set(otherId, newest.createdAt)
  }

  /** The chats, their unread counts, and anything new since last time. */
  async function sync(s: Session, { announce = false } = {}) {
    const people = ((await request(s, '/api/messages/users')) ?? []) as GsUser[]
    if (!Array.isArray(people) || !live(s)) return
    // Unread counts first: importing a chat clears them on Guffshuff, and they're what the queue shows.
    const unread = ((await request(s, '/api/messages/unread')) ?? {}) as Record<string, number>

    let changed = false
    for (const person of people) {
      // Everyone on Guffshuff is listed, whether or not they've ever written: only chats are chats.
      if (!person.lastMessageTime || !live(s)) continue
      const otherId = String(person._id)
      const threadId = `${PREFIX}${otherId}`
      const known = await store.thread(s.userId, threadId)
      await store.upsertThread(s.userId, {
        id: threadId,
        network: 'guffshuff',
        kind: 'direct',
        title: person.fullName || person.username || 'Guffshuff',
        participantIds: [threadId],
        lastAt: new Date(person.lastMessageTime),
      })
      await upsertContact(s, person)

      const seenBefore = s.latest.get(otherId)
      if (!s.imported.has(otherId) || (seenBefore && person.lastMessageTime > seenBefore)) {
        await importChat(s, person)
        changed = true
      } else if (!known) {
        changed = true
      }
      s.latest.set(otherId, person.lastMessageTime)
      const count = Number(unread[otherId]) || 0
      if (count) await store.setUnread(s.userId, threadId, count)
    }
    if ((announce || changed) && live(s)) publish(s, { type: 'reloaded' })
  }

  /* ── Its live stream ─────────────────────────────────────────────────────── */

  function openStream(s: Session) {
    s.stream?.close()
    if (s.stopped) return
    const open = api?.connect ?? openSocket
    const stream = open(baseUrl, s.cookie)
    s.stream = stream
    stream.on('newMessage', (m: GsMessage) => {
      if (s.stopped) return
      // Only messages to me arrive here; the other end of the chat is whoever sent it.
      const otherId = String(m.senderId) === String(s.me._id) ? String(m.receiverId) : String(m.senderId)
      void saveMessage(s, m, otherId, { live: true }).catch((error: unknown) => console.error('[guffshuff] message failed', error))
    })
    // Messages that arrived while the stream was down are picked up on the next look.
    stream.on('connect', () => void sync(s).catch(() => undefined))
  }

  /** The real stream: socket.io, carrying the same session cookie the REST API uses. */
  function openSocket(url: string, cookie: string): GuffshuffStream {
    const socket: Socket = io(url, {
      path: '/socket.io/',
      transports: ['websocket'],
      extraHeaders: { cookie },
      reconnection: true,
      reconnectionDelayMax: 30_000,
    })
    return {
      on: (event: string, listener: (...args: never[]) => void) => void socket.on(event, listener as never),
      close: () => socket.close(),
    }
  }

  /* ── Sessions ────────────────────────────────────────────────────────────── */

  function connected(userId: ObjectId): Session {
    const s = sessions.get(userId.toHexString())
    if (!s) throw new HttpError(409, 'Guffshuff is not linked.')
    return s
  }

  function stop(key: string) {
    const s = sessions.get(key)
    if (!s) return
    s.stopped = true
    s.stream?.close()
    if (s.timer) clearInterval(s.timer)
    sessions.delete(key)
  }

  /** Signs in, imports the chats and starts listening. */
  async function start(userId: ObjectId, credentials: Credentials) {
    const key = userId.toHexString()
    stop(key)
    const { cookie, me } = await signIn(credentials)
    const s: Session = { userId, key, credentials, cookie, me, stopped: false, imported: new Set(), latest: new Map() }
    sessions.set(key, s)
    await accounts.set(userId, 'guffshuff', { status: 'connected', label: me.username ? `@${me.username}` : (me.fullName ?? 'Guffshuff') })
    openStream(s)
    s.timer = setInterval(() => void sync(s).catch(() => undefined), CATCH_UP_MS)
    s.timer.unref?.()
    try {
      await sync(s, { announce: true })
    } catch (error) {
      console.error('[guffshuff] first sync failed', error)
    }
    return s
  }

  const threadOf = (threadId: string) => threadId.slice(PREFIX.length)

  async function sendTo(s: Session, otherId: string, body: { text?: string; image?: string }): Promise<Message> {
    const sent = (await request(s, `/api/messages/send/${otherId}`, { method: 'POST', body: JSON.stringify(body) })) as GsMessage | null
    if (!sent?._id) throw new HttpError(502, `${hostOf(baseUrl)} didn't accept the message.`)
    const saved = await saveMessage(s, sent, otherId, { live: false })
    if (!saved) throw new HttpError(409, 'Guffshuff is not linked.')
    const thread = await store.thread(s.userId, saved.message.threadId)
    if (thread) publish(s, { type: 'thread.updated', thread })
    return saved.message
  }

  return {
    /** Whether this server offers Guffshuff at all (GUFFSHUFF_URL). */
    enabled: !!baseUrl,

    isConnected(userId: ObjectId) {
      return sessions.has(userId.toHexString())
    },

    /** Links the account: signs in once, then keeps the credentials sealed so it can do so again. */
    async link(userId: ObjectId, credentials: Credentials) {
      if (!baseUrl) throw new HttpError(503, 'This server has no Guffshuff address set.')
      await accounts.set(userId, 'guffshuff', { status: 'linking', detail: `Signing in to ${hostOf(baseUrl)}…` })
      try {
        const s = await start(userId, credentials)
        await accounts.set(userId, 'guffshuff', {
          status: 'connected',
          label: s.me.username ? `@${s.me.username}` : (s.me.fullName ?? 'Guffshuff'),
          session: sealer.sealJson(credentials),
        })
        return { username: s.me.username ?? '', fullName: s.me.fullName ?? '' }
      } catch (error) {
        stop(userId.toHexString())
        await accounts.remove(userId, 'guffshuff')
        throw error
      }
    },

    async unlink(userId: ObjectId) {
      stop(userId.toHexString())
      await accounts.remove(userId, 'guffshuff')
      await store.forgetNetwork(userId, PREFIX)
      avatars.forget(userId, PREFIX)
      hub.publish(userId.toHexString(), { type: 'reloaded' })
    },

    /** Signs every linked account back in: on start, and every few minutes after that. */
    async resumeAll() {
      if (!baseUrl) return
      for (const doc of await accounts.toResume('guffshuff')) {
        if (sessions.has(doc.userId.toHexString()) || !doc.session) continue
        let credentials: Credentials
        try {
          credentials = sealer.openJson<Credentials>(doc.session)
        } catch {
          continue
        }
        try {
          await start(doc.userId, credentials)
        } catch (error) {
          const message = error instanceof HttpError ? error.message : 'Signing in failed.'
          // Kept as "error" so it's tried again, with what went wrong shown in Settings.
          await accounts.set(doc.userId, 'guffshuff', { status: 'error', label: doc.label, detail: message, session: doc.session })
        }
      }
    },

    async send(userId: ObjectId, threadId: string, body: string): Promise<Message> {
      const s = connected(userId)
      return sendTo(s, threadOf(threadId), { text: body })
    },

    async sendFile(userId: ObjectId, threadId: string, upload: Upload, caption: string): Promise<Message> {
      const s = connected(userId)
      if (!upload.mime.startsWith('image/')) throw new HttpError(415, 'Guffshuff takes photos only.')
      if (upload.data.byteLength > MAX_IMAGE_BYTES) {
        throw new HttpError(413, `That photo is too big for Guffshuff (${fileSize(MAX_IMAGE_BYTES)} at most).`)
      }
      const image = `data:${upload.mime};base64,${upload.data.toString('base64')}`
      return sendTo(s, threadOf(threadId), { image, ...(caption ? { text: caption } : {}) })
    },

    /** A photo in a chat, fetched from where Guffshuff keeps it. */
    async openFile(userId: ObjectId, ref: FileRef): Promise<FileBody> {
      if (ref.n !== 'gs') throw new HttpError(404, 'No such file.')
      connected(userId)
      const res = await call(ref.url).catch(() => null)
      if (!res?.ok || !res.body) throw new HttpError(502, "That photo couldn't be fetched.")
      const mime = res.headers.get('content-type') ?? ref.mime
      const length = Number(res.headers.get('content-length'))
      return {
        data: Buffer.from(await res.arrayBuffer()),
        name: ref.name,
        ...(mime ? { mime } : {}),
        ...(Number.isFinite(length) && length > 0 ? { size: length } : {}),
      }
    },

    async picture(userId: ObjectId, id: string): Promise<Picture | null> {
      const s = sessions.get(userId.toHexString())
      if (!s) return null
      const person = ((await request(s, '/api/messages/users')) as GsUser[] | null)?.find((u) => `${PREFIX}${u._id}` === id)
      return person?.profilePic ? fetchPicture(person.profilePic) : null
    },

    /** Tells Guffshuff the chat was read, as its own website does when you open one. */
    async markRead(userId: ObjectId, threadId: string, { receipt = true }: { receipt?: boolean; strict?: boolean } = {}) {
      const s = connected(userId)
      await store.markReadHere(userId, threadId, { receipt })
      if (!receipt) return
      await request(s, `/api/messages/read/${threadOf(threadId)}`, { method: 'POST' })
    },

    /** Guffshuff hands over a whole conversation at once, so there is never more to fetch. */
    async loadOlder(): Promise<ServerOlderMessages> {
      return { messages: [], hasMore: false }
    },

    /** Starring, pinning and deleting for me are Sytext's own; Guffshuff is not told. */
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
          if (action.forEveryone) throw new HttpError(409, "Guffshuff can't unsend messages.")
          await store.deleteMessage(userId, threadId, messageId)
          hub.publish(userId.toHexString(), { type: 'message.deleted', threadId, messageId })
          return { message: null, removed: true }
        case 'edit':
          throw new HttpError(409, "Guffshuff can't edit messages.")
      }
    },

    async react(): Promise<Message | null> {
      throw new HttpError(409, 'Guffshuff has no reactions.')
    },

    /** Guffshuff shows no "typing…", so there is nothing to tell it. */
    async setTyping() {},

    /** Guffshuff has no archive of its own, so it's kept here. */
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

export type Guffshuff = ReturnType<typeof createGuffshuff>

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return 'Guffshuff'
  }
}

/** The `jwt` cookie from a sign-in response, as "jwt=…". */
function cookieOf(res: Response): string | null {
  const headers = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
  const all = headers.length ? headers : [res.headers.get('set-cookie') ?? '']
  for (const header of all) {
    for (const part of header.split(/,(?=[^;]+=)/)) {
      const pair = part.split(';')[0]?.trim()
      if (pair?.startsWith('jwt=') && pair.length > 'jwt='.length) return pair
    }
  }
  return null
}
