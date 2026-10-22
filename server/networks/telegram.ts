import type { ObjectId } from 'mongodb'
import { Api, TelegramClient, utils } from 'telegram'
import { EditedMessage, type EditedMessageEvent } from 'telegram/events/EditedMessage.js'
import { NewMessage, Raw, type NewMessageEvent } from 'telegram/events/index.js'
import { Logger, LogLevel } from 'telegram/extensions/Logger.js'
import { computeCheck } from 'telegram/Password.js'
import { StringSession } from 'telegram/sessions/index.js'
import type { TelegramCodeResult, TelegramVerifyResult } from '../../src/data/server/types.ts'
import type { Attachment, Message } from '../../src/data/types.ts'
import type { Sealer } from '../crypto.ts'
import { HttpError } from '../http.ts'
import type { InboxStore, StoredMessage } from '../inbox/store.ts'
import type { Media } from '../media.ts'
import type { Hub } from '../realtime.ts'
import type { Accounts } from './accounts.ts'

/**
 * Telegram as the user's own account (not a bot): they enter their phone number, Telegram sends a
 * login code to their Telegram app, and, if they use two-step verification, they enter their
 * password. The resulting session is stored sealed, so the link survives restarts, and shows up in
 * Telegram under Settings → Devices, where it can be ended at any time.
 *
 * This needs an API id and hash for the deployment, from https://my.telegram.org.
 *
 * Ids: thread "tga:<peer id>", message "tga:<peer id>:<message id>", contact "tga:<user id>".
 * Peer ids are Telegram's "marked" ids: people positive, groups negative.
 */

/* ── The client, as this module needs it ───────────────────────────────────── */

/** A chat or a person. */
export interface TgPeer {
  id: string
  kind: 'direct' | 'group'
  /** Empty when Telegram didn't say (the stored name is kept). */
  name: string
  /** People only: @username or phone number. */
  handle?: string
  /** Left out of the inbox: broadcast channels and "Saved Messages". */
  skip?: boolean
}

export interface TgMessage {
  id: number
  chat: TgPeer
  /** Who wrote it, for messages from others in a group. */
  sender?: TgPeer
  out: boolean
  text: string
  /** Unix seconds. */
  date: number
  media?: { body?: string; attachment?: Attachment; download?: () => Promise<Buffer | undefined> }
}

export interface TgDialog {
  chat: TgPeer
  unreadCount: number
  /** My messages up to this id have been read by the other side. */
  readOutboxMaxId: number
  date: number
}

export interface TgSelf {
  id: string
  /** @username, or the phone number. */
  label: string
}

export type TgUpdate =
  | { type: 'message'; message: TgMessage }
  | { type: 'edited'; message: TgMessage }
  /** Read on another device; `unreadCount` is what's left. */
  | { type: 'read'; chatId: string; unreadCount: number }
  /** The other side read my messages up to `maxId`. */
  | { type: 'read-outbox'; chatId: string; maxId: number }

/** The parts of a Telegram client this manager uses; tests pass a fake. */
export interface TgClient {
  connect(): Promise<void>
  disconnect(): Promise<void>
  /** The session to store, once signed in. */
  save(): string
  sendCode(phone: string): Promise<{ phoneCodeHash: string; viaApp: boolean }>
  signIn(phone: string, phoneCodeHash: string, code: string): Promise<TgSelf>
  passwordHint(): Promise<string | undefined>
  checkPassword(password: string): Promise<TgSelf>
  me(): Promise<TgSelf>
  dialogs(limit: number): Promise<TgDialog[]>
  history(chatId: string, limit: number): Promise<TgMessage[]>
  send(chatId: string, text: string): Promise<{ id: number; date: number }>
  markRead(chatId: string, maxId: number): Promise<void>
  logOut(): Promise<void>
  onUpdate(listener: (update: TgUpdate) => void): void
}

export interface TelegramApi {
  apiId: number
  apiHash: string
}

export type CreateTgClient = (session: string, api: TelegramApi) => TgClient

/* ── GramJS ─────────────────────────────────────────────────────────────────── */

type Entity = Api.TypeUser | Api.TypeChat

const handleOf = (user: Api.User) => (user.username ? `@${user.username}` : user.phone ? `+${user.phone}` : 'Telegram')

export function peerOf(entity: Entity | undefined | null): TgPeer | null {
  if (entity instanceof Api.User) {
    const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ')
    return {
      id: utils.getPeerId(entity),
      kind: 'direct',
      name: name || handleOf(entity),
      handle: handleOf(entity),
      ...(entity.self ? { skip: true } : {}),
    }
  }
  if (entity instanceof Api.Chat || entity instanceof Api.ChatForbidden) {
    return { id: utils.getPeerId(entity), kind: 'group', name: entity.title }
  }
  if (entity instanceof Api.Channel || entity instanceof Api.ChannelForbidden) {
    return { id: utils.getPeerId(entity), kind: 'group', name: entity.title, ...(entity.broadcast ? { skip: true } : {}) }
  }
  return null
}

/** For when only the id is known (Telegram leaves the details out of some updates). */
const barePeer = (peer: Api.TypePeer): TgPeer => ({
  id: utils.getPeerId(peer),
  kind: peer instanceof Api.PeerUser ? 'direct' : 'group',
  name: '',
})

export function mediaOf(m: Api.Message, download: () => Promise<Buffer | undefined>): TgMessage['media'] {
  const size = (n: unknown) => (Number(n) ? `${Math.max(1, Math.round(Number(n) / 1024))} KB` : undefined)
  if (m.photo) return { attachment: { kind: 'image', name: 'Photo' }, download }
  if (m.sticker) return { body: `${m.file?.emoji ?? ''} Sticker`.trim() }
  if (m.voice) return { body: '🎤 Voice message' }
  if (m.videoNote) return { body: '📹 Video message' }
  if (m.gif) return { body: 'GIF' }
  if (m.audio) return { body: '🎵 Audio' }
  if (m.video) return { attachment: { kind: 'file', name: 'Video', size: size(m.file?.size) } }
  if (m.document) return { attachment: { kind: 'file', name: m.file?.name || 'Document', size: size(m.file?.size) } }
  if (m.geo || m.venue) return { body: '📍 Location' }
  if (m.contact) return { body: `👤 ${[m.contact.firstName, m.contact.lastName].filter(Boolean).join(' ') || 'Contact'}` }
  if (m.poll) {
    const question = m.poll.poll.question as unknown
    return { body: `📊 ${typeof question === 'string' ? question : ((question as { text?: string })?.text ?? 'Poll')}` }
  }
  if (m.dice) return { body: m.dice.emoticon }
  return undefined
}

const gramLogger = new Logger(LogLevel.ERROR)

const SIGN_UP_REQUIRED = Object.assign(new Error('No Telegram account for this number'), { errorMessage: 'SIGN_UP_REQUIRED' })

export const createGramClient: CreateTgClient = (session, api) => {
  const client = new TelegramClient(new StringSession(session), api.apiId, api.apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
    baseLogger: gramLogger,
    deviceModel: 'Sytext',
    systemVersion: 'Server',
    appVersion: '1.0',
  })

  const selfOf = (user: Api.TypeUser): TgSelf =>
    user instanceof Api.User ? { id: utils.getPeerId(user), label: handleOf(user) } : { id: String(user.id), label: 'Telegram' }

  /** After a restart Telegram's peers aren't cached yet; listing chats fills the cache. */
  async function inputPeer(chatId: string) {
    try {
      return await client.getInputEntity(chatId)
    } catch {
      await client.getDialogs({ limit: 200 })
      return client.getInputEntity(chatId)
    }
  }

  async function messageOf(m: Api.TypeMessage): Promise<TgMessage | null> {
    if (!(m instanceof Api.Message)) return null // Service messages ("joined the group") and gaps.
    const media = mediaOf(m, async () => {
      const data = await client.downloadMedia(m, {})
      return Buffer.isBuffer(data) ? data : undefined
    })
    if (!m.message && !media) return null
    const chat = peerOf(m.chat ?? (await m.getChat().catch(() => undefined))) ?? barePeer(m.peerId)
    let sender: TgPeer | undefined
    if (!m.out && chat.kind === 'group') {
      sender = peerOf(m.sender ?? (await m.getSender().catch(() => undefined))) ?? (m.fromId ? barePeer(m.fromId) : undefined)
    }
    return { id: m.id, chat, ...(sender ? { sender } : {}), out: !!m.out, text: m.message ?? '', date: m.date, ...(media ? { media } : {}) }
  }

  return {
    async connect() {
      await client.connect()
    },
    async disconnect() {
      await client.destroy()
    },
    save: () => (client.session as StringSession).save(),

    async sendCode(phone) {
      const { phoneCodeHash, isCodeViaApp } = await client.sendCode({ apiId: api.apiId, apiHash: api.apiHash }, phone)
      return { phoneCodeHash, viaApp: isCodeViaApp }
    },
    async signIn(phone, phoneCodeHash, code) {
      const result = await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }))
      if (result instanceof Api.auth.AuthorizationSignUpRequired) throw SIGN_UP_REQUIRED
      return selfOf(result.user)
    },
    async passwordHint() {
      const password = await client.invoke(new Api.account.GetPassword())
      return password.hint || undefined
    },
    async checkPassword(password) {
      const settings = await client.invoke(new Api.account.GetPassword())
      const result = await client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(settings, password) }))
      if (result instanceof Api.auth.AuthorizationSignUpRequired) throw SIGN_UP_REQUIRED
      return selfOf(result.user)
    },
    async me() {
      return selfOf(await client.getMe())
    },

    async dialogs(limit) {
      const dialogs = await client.getDialogs({ limit })
      return dialogs.flatMap((d) => {
        const chat = peerOf(d.entity)
        return chat ? [{ chat, unreadCount: d.unreadCount, readOutboxMaxId: d.dialog.readOutboxMaxId, date: d.date }] : []
      })
    },
    async history(chatId, limit) {
      const messages = await client.getMessages(await inputPeer(chatId), { limit })
      return (await Promise.all(messages.map(messageOf))).filter((m): m is TgMessage => !!m)
    },
    async send(chatId, text) {
      // Sent as typed: no Markdown, so "*" and "_" stay as they are.
      const sent = await client.sendMessage(await inputPeer(chatId), { message: text, parseMode: false })
      return { id: sent.id, date: sent.date }
    },
    async markRead(chatId, maxId) {
      await client.markAsRead(await inputPeer(chatId), undefined, { maxId, clearMentions: true })
    },
    async logOut() {
      await client.invoke(new Api.auth.LogOut())
    },

    onUpdate(listener) {
      const forward = (type: 'message' | 'edited') => (event: NewMessageEvent | EditedMessageEvent) =>
        void messageOf(event.message)
          .then((message) => message && listener({ type, message }))
          .catch(report)
      client.addEventHandler(forward('message'), new NewMessage({}))
      client.addEventHandler(forward('edited'), new EditedMessage({}))
      client.addEventHandler(
        (update: Api.TypeUpdate) => {
          if (update instanceof Api.UpdateReadHistoryInbox) {
            listener({ type: 'read', chatId: utils.getPeerId(update.peer), unreadCount: update.stillUnreadCount })
          } else if (update instanceof Api.UpdateReadChannelInbox) {
            const peer = new Api.PeerChannel({ channelId: update.channelId })
            listener({ type: 'read', chatId: utils.getPeerId(peer), unreadCount: update.stillUnreadCount })
          } else if (update instanceof Api.UpdateReadHistoryOutbox) {
            listener({ type: 'read-outbox', chatId: utils.getPeerId(update.peer), maxId: update.maxId })
          } else if (update instanceof Api.UpdateReadChannelOutbox) {
            const peer = new Api.PeerChannel({ channelId: update.channelId })
            listener({ type: 'read-outbox', chatId: utils.getPeerId(peer), maxId: update.maxId })
          }
        },
        new Raw({ types: [Api.UpdateReadHistoryInbox, Api.UpdateReadChannelInbox, Api.UpdateReadHistoryOutbox, Api.UpdateReadChannelOutbox] }),
      )
    },
  }
}

/* ── Manager ─────────────────────────────────────────────────────────────────── */

/** How much of each account is copied in when it's linked (and caught up after a restart). */
const DIALOGS_TO_SYNC = 30
const MESSAGES_PER_CHAT = 20
/** How often a linked session is checked, to notice it was ended from another device. */
const CHECK_EVERY_MS = 15 * 60_000

/** Errors meaning the session is gone for good: ended from Settings → Devices, or the account deleted. */
const ENDED = new Set(['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'USER_DEACTIVATED', 'USER_DEACTIVATED_BAN'])

const errorCode = (error: unknown) => (error as { errorMessage?: string } | null)?.errorMessage

function report(error: unknown) {
  console.error('[telegram]', error instanceof Error ? error.message : error)
}

function wait(seconds: number) {
  if (seconds < 90) return `${seconds} seconds`
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} minutes`
  return `${Math.round(seconds / 3600)} hours`
}

/** Telegram's error codes, in words for the user. */
function telegramError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  const seconds = (error as { seconds?: number } | null)?.seconds
  if (typeof seconds === 'number') return new HttpError(429, `Telegram asks you to wait ${wait(seconds)} before trying again.`)
  switch (errorCode(error)) {
    case 'PHONE_NUMBER_INVALID':
      return new HttpError(400, 'Telegram doesn\'t recognise that number. Include the country code, like +91 98765 43210.')
    case 'PHONE_NUMBER_BANNED':
      return new HttpError(400, 'Telegram has banned this number.')
    case 'PHONE_NUMBER_FLOOD':
      return new HttpError(429, 'Telegram has sent too many codes to this number. Try again later.')
    case 'PHONE_CODE_INVALID':
    case 'PHONE_CODE_EMPTY':
      return new HttpError(400, 'That code isn\'t right. Check it and try again.')
    case 'PHONE_CODE_EXPIRED':
      return new HttpError(400, 'That code has expired. Get a new one.')
    case 'PASSWORD_HASH_INVALID':
      return new HttpError(400, 'That password isn\'t right.')
    case 'SIGN_UP_REQUIRED':
      return new HttpError(400, 'There\'s no Telegram account for this number. Create one in the Telegram app first.')
  }
  report(error)
  return new HttpError(502, 'Telegram didn\'t accept that. Try again in a moment.')
}

interface PendingLogin {
  client: TgClient
  phone: string
  phoneCodeHash: string
  needsPassword: boolean
  timer: ReturnType<typeof setTimeout>
}

interface Session {
  userId: ObjectId
  client: TgClient
  stopped: boolean
  check: ReturnType<typeof setInterval>
}

export interface TelegramDeps {
  sealer: Sealer
  store: InboxStore
  accounts: Accounts
  hub: Hub
  media: Media | null
  /** Without it, linking Telegram is switched off. */
  api: TelegramApi | undefined
  createClient?: CreateTgClient
  /** How long a login code can be used. */
  codeTtlMs?: number
}

type CodeResult = TelegramCodeResult
type VerifyResult = TelegramVerifyResult

export function createTelegram(deps: TelegramDeps) {
  const { sealer, store, accounts, hub, media, api } = deps
  const createClient = deps.createClient ?? createGramClient
  const pending = new Map<string, PendingLogin>()
  const sessions = new Map<string, Session>()
  const retries = new Map<string, ReturnType<typeof setTimeout>>()
  const keyOf = (userId: ObjectId) => userId.toHexString()
  const publish = (s: Session, event: Parameters<Hub['publish']>[1]) => hub.publish(keyOf(s.userId), event)

  function requireApi(): TelegramApi {
    if (!api) throw new HttpError(404, 'Telegram sign-in is not set up on this server.')
    return api
  }

  async function dropPending(userId: ObjectId) {
    const p = pending.get(keyOf(userId))
    if (!p) return
    pending.delete(keyOf(userId))
    clearTimeout(p.timer)
    await p.client.disconnect().catch(() => undefined)
  }

  /* ── Incoming data ───────────────────────────────────────────────────────── */

  async function upsertContact(s: Session, peer: TgPeer) {
    if (!peer.name) return
    const contact = { id: `tga:${peer.id}`, name: peer.name, network: 'telegram' as const, handle: peer.handle ?? '' }
    if (await store.upsertContact(s.userId, contact)) publish(s, { type: 'contact.updated', contact })
  }

  async function saveMessage(s: Session, m: TgMessage, { live, readOutboxMaxId = 0 }: { live: boolean; readOutboxMaxId?: number }) {
    if (m.chat.skip) return
    const threadId = `tga:${m.chat.id}`
    const sentAt = new Date(m.date * 1000)
    const direct = m.chat.kind === 'direct'
    const known = await store.thread(s.userId, threadId)
    await store.upsertThread(s.userId, {
      id: threadId,
      network: 'telegram',
      kind: m.chat.kind,
      // Keep the stored name when this update didn't carry one.
      ...(m.chat.name ? { title: m.chat.name } : known ? {} : { title: 'Telegram chat' }),
      ...(direct ? { participantIds: [threadId] } : {}),
      lastAt: sentAt,
    })
    if (direct) await upsertContact(s, m.chat)

    let senderId = 'me'
    if (!m.out) {
      // In a group, a post with no known author (an anonymous admin, say) is shown as the group's.
      const sender = direct ? m.chat : (m.sender ?? m.chat)
      senderId = `tga:${sender.id}`
      if (!direct) {
        await upsertContact(s, sender.name ? sender : { ...sender, name: known?.title ?? 'Telegram' })
        await store.addParticipant(s.userId, threadId, senderId)
      }
    }

    const message: StoredMessage = {
      id: `tga:${m.chat.id}:${m.id}`,
      threadId,
      senderId,
      body: m.text || m.media?.body || '',
      sentAt: sentAt.toISOString(),
      ...(m.out ? { status: m.id <= readOutboxMaxId ? 'read' : 'sent' } : {}),
      ...(m.media?.attachment ? { attachments: [m.media.attachment] } : {}),
      ref: { id: m.id },
    }
    if (!(await store.addMessage(s.userId, message))) return
    if (!live) return

    if (!m.out) await store.incrementUnread(s.userId, threadId)
    const thread = await store.thread(s.userId, threadId)
    if (thread) publish(s, { type: 'thread.updated', thread })
    const { ref, ...wire } = message
    void ref
    publish(s, { type: 'message.created', message: wire })

    // Pictures that arrive live are copied to Cloudinary so the browser can show them.
    const download = m.media?.download
    if (download && media) {
      void (async () => {
        const data = await download()
        if (!data) return
        const url = await media.uploadBuffer(data, `chats/${keyOf(s.userId)}`)
        await updateAndPublish(s, message.id, { attachments: [{ kind: 'image', name: 'Photo', url }] })
      })().catch(report)
    }
  }

  async function updateAndPublish(s: Session, id: string, patch: Parameters<InboxStore['updateMessage']>[2]) {
    const message = await store.updateMessage(s.userId, id, patch)
    if (message) publish(s, { type: 'message.updated', message })
  }

  async function onUpdate(s: Session, update: TgUpdate) {
    if (s.stopped) return
    switch (update.type) {
      case 'message':
        return saveMessage(s, update.message, { live: true })
      case 'edited': {
        const m = update.message
        return updateAndPublish(s, `tga:${m.chat.id}:${m.id}`, { body: m.text || m.media?.body || '' })
      }
      case 'read': {
        const threadId = `tga:${update.chatId}`
        if (!(await store.thread(s.userId, threadId))) return
        await store.setUnread(s.userId, threadId, Math.max(0, update.unreadCount))
        const thread = await store.thread(s.userId, threadId)
        if (thread) publish(s, { type: 'thread.updated', thread })
        return
      }
      case 'read-outbox':
        for (const message of await store.markSentRead(s.userId, `tga:${update.chatId}`, update.maxId)) {
          publish(s, { type: 'message.updated', message })
        }
    }
  }

  /** Copies in the latest chats; on later runs only the ones with something new. */
  async function sync(s: Session) {
    const dialogs = await s.client.dialogs(DIALOGS_TO_SYNC)
    for (const d of dialogs) {
      if (s.stopped) return
      if (d.chat.skip) continue
      const threadId = `tga:${d.chat.id}`
      const latest = await store.latestMessageAt(s.userId, threadId)
      await store.upsertThread(s.userId, {
        id: threadId,
        network: 'telegram',
        kind: d.chat.kind,
        title: d.chat.name || 'Telegram chat',
        ...(d.chat.kind === 'direct' ? { participantIds: [threadId] } : {}),
        unreadCount: d.unreadCount,
        lastAt: new Date(d.date * 1000),
      })
      if (d.chat.kind === 'direct') await upsertContact(s, d.chat)
      if (latest && latest.getTime() >= d.date * 1000) continue
      for (const m of await s.client.history(d.chat.id, MESSAGES_PER_CHAT)) {
        await saveMessage(s, m, { live: false, readOutboxMaxId: d.readOutboxMaxId })
      }
    }
    if (s.stopped) return
    publish(s, { type: 'reloaded' })
    const account = await accounts.get(s.userId, 'telegram')
    if (account?.status === 'connected' && account.detail) await accounts.set(s.userId, 'telegram', { status: 'connected' })
  }

  /* ── Lifecycle ───────────────────────────────────────────────────────────── */

  function start(userId: ObjectId, client: TgClient): Session {
    const s: Session = {
      userId,
      client,
      stopped: false,
      check: setInterval(() => void check(s), CHECK_EVERY_MS),
    }
    s.check.unref()
    sessions.set(keyOf(userId), s)
    client.onUpdate((update) => void onUpdate(s, update).catch(report))
    return s
  }

  async function stop(s: Session) {
    s.stopped = true
    clearInterval(s.check)
    if (sessions.get(keyOf(s.userId)) === s) sessions.delete(keyOf(s.userId))
    await s.client.disconnect().catch(() => undefined)
  }

  /** Notices a session that was ended from another device. */
  async function check(s: Session) {
    try {
      await s.client.me()
    } catch (error) {
      if (!ENDED.has(errorCode(error) ?? '')) return // A network problem; the client reconnects on its own.
      await stop(s)
      await ended(s.userId)
    }
  }

  async function ended(userId: ObjectId) {
    await accounts.set(userId, 'telegram', {
      status: 'disconnected',
      session: '',
      detail: 'This session was ended in Telegram (Settings → Devices). Link it again to keep syncing.',
    })
  }

  async function resume(userId: ObjectId, sealedSession: string, attempt = 0) {
    retries.delete(keyOf(userId))
    if (sessions.has(keyOf(userId)) || !api) return
    let session: string
    try {
      session = sealer.open(sealedSession)
    } catch {
      await accounts.set(userId, 'telegram', {
        status: 'disconnected',
        session: '',
        detail: "The server's encryption key changed, so the session can't be used. Link Telegram again.",
      })
      return
    }
    const client = createClient(session, api)
    try {
      await client.connect()
      await client.me() // Confirms the session still works, and asks Telegram for updates.
    } catch (error) {
      await client.disconnect().catch(() => undefined)
      if (ENDED.has(errorCode(error) ?? '')) return ended(userId)
      report(error)
      await accounts.set(userId, 'telegram', { status: 'error', detail: 'Can\'t reach Telegram. Retrying…' })
      const delay = Math.min(15 * 60_000, 30_000 * 2 ** attempt)
      retries.set(keyOf(userId), setTimeout(() => void resume(userId, sealedSession, attempt + 1).catch(report), delay))
      return
    }
    const account = await accounts.get(userId, 'telegram')
    if (account?.status !== 'connected') await accounts.set(userId, 'telegram', { status: 'connected' })
    await sync(start(userId, client))
  }

  return {
    enabled: !!api,

    /** Step 1: Telegram sends a login code to the user's Telegram app (or by SMS). */
    async requestCode(userId: ObjectId, rawPhone: string): Promise<CodeResult> {
      const credentials = requireApi()
      if (sessions.has(keyOf(userId))) throw new HttpError(409, 'Telegram is already linked. Unlink it first.')
      const digits = rawPhone.replace(/\D/g, '')
      if (digits.length < 8 || digits.length > 15) {
        throw new HttpError(400, 'Enter your Telegram number with its country code, like +91 98765 43210.')
      }
      const phone = `+${digits}`
      await dropPending(userId)

      const client = createClient('', credentials)
      let sent: { phoneCodeHash: string; viaApp: boolean }
      try {
        await client.connect()
        sent = await client.sendCode(phone)
      } catch (error) {
        await client.disconnect().catch(() => undefined)
        throw telegramError(error)
      }
      pending.set(keyOf(userId), {
        client,
        phone,
        phoneCodeHash: sent.phoneCodeHash,
        needsPassword: false,
        timer: setTimeout(() => void expire(userId).catch(report), deps.codeTtlMs ?? 10 * 60_000),
      })
      await accounts.set(userId, 'telegram', {
        status: 'linking',
        label: phone,
        detail: sent.viaApp ? 'Enter the code Telegram sent to your Telegram app.' : 'Enter the code Telegram sent you by SMS.',
      })
      return { via: sent.viaApp ? 'app' : 'sms' }
    },

    /** Step 2: the code. Accounts with two-step verification then need their password. */
    async verifyCode(userId: ObjectId, code: string): Promise<VerifyResult> {
      const p = pending.get(keyOf(userId))
      if (!p) throw new HttpError(400, 'That code has expired. Get a new one.')
      if (p.needsPassword) throw new HttpError(400, 'Enter your two-step verification password.')
      try {
        const self = await p.client.signIn(p.phone, p.phoneCodeHash, code.replace(/\D/g, ''))
        await finishLink(userId, p, self)
        return { status: 'connected' }
      } catch (error) {
        if (errorCode(error) === 'SESSION_PASSWORD_NEEDED') {
          p.needsPassword = true
          const hint = await p.client.passwordHint().catch(() => undefined)
          await accounts.set(userId, 'telegram', { status: 'linking', label: p.phone, detail: 'Enter your two-step verification password.' })
          return { status: 'password', ...(hint ? { hint } : {}) }
        }
        if (errorCode(error) === 'PHONE_CODE_EXPIRED') await expire(userId)
        throw telegramError(error)
      }
    },

    /** Step 3, only with two-step verification. */
    async verifyPassword(userId: ObjectId, password: string): Promise<VerifyResult> {
      const p = pending.get(keyOf(userId))
      if (!p?.needsPassword) throw new HttpError(400, 'Start again: get a new code first.')
      try {
        await finishLink(userId, p, await p.client.checkPassword(password))
        return { status: 'connected' }
      } catch (error) {
        throw telegramError(error)
      }
    },

    async unlink(userId: ObjectId) {
      await dropPending(userId)
      clearTimeout(retries.get(keyOf(userId)))
      retries.delete(keyOf(userId))
      const s = sessions.get(keyOf(userId))
      if (s) {
        s.stopped = true
        await withTimeout(s.client.logOut(), 10_000).catch(() => undefined) // Ends it in Telegram's Devices list too.
        await stop(s)
      } else {
        // Not connected right now (say, Telegram was unreachable): still try to end the session.
        const account = await accounts.get(userId, 'telegram')
        let session = ''
        try {
          session = account?.session ? sealer.open(account.session) : ''
        } catch {
          // Sealed with another key: nothing to log out with.
        }
        if (session && api) {
          const client = createClient(session, api)
          await withTimeout(
            client.connect().then(() => client.logOut()),
            10_000,
          ).catch(() => undefined)
          await client.disconnect().catch(() => undefined)
        }
      }
      await store.forgetNetwork(userId, 'tga:')
      await accounts.remove(userId, 'telegram')
      hub.publish(keyOf(userId), { type: 'reloaded' })
    },

    async send(userId: ObjectId, threadId: string, body: string): Promise<Message> {
      const s = sessions.get(keyOf(userId))
      if (!s) throw new HttpError(409, 'Telegram is not connected right now.')
      const chatId = threadId.slice('tga:'.length)
      let sent: { id: number; date: number }
      try {
        sent = await s.client.send(chatId, body)
      } catch (error) {
        throw telegramError(error)
      }
      const message: StoredMessage = {
        id: `tga:${chatId}:${sent.id}`,
        threadId,
        senderId: 'me',
        body,
        sentAt: new Date(sent.date * 1000).toISOString(),
        status: 'sent',
        ref: { id: sent.id },
      }
      await store.addMessage(userId, message)
      const { ref, ...wire } = message
      void ref
      return wire
    },

    async markRead(userId: ObjectId, threadId: string) {
      await store.setUnread(userId, threadId, 0)
      const s = sessions.get(keyOf(userId))
      if (!s) return
      const [latest] = await store.recentIncoming(userId, threadId, 1)
      const maxId = Number(latest?.ref?.id)
      if (maxId) await s.client.markRead(threadId.slice('tga:'.length), maxId).catch(report)
    },

    /** Reconnects every linked account, e.g. after a restart, and catches up on missed messages. */
    async resumeAll() {
      if (!api) return
      for (const account of await accounts.toResume('telegram')) {
        if (account.session) await resume(account.userId, account.session).catch(report)
      }
    },

    async stopAll() {
      for (const t of retries.values()) clearTimeout(t)
      retries.clear()
      for (const userKey of [...pending.keys()]) {
        const p = pending.get(userKey)!
        pending.delete(userKey)
        clearTimeout(p.timer)
        await p.client.disconnect().catch(() => undefined)
      }
      for (const s of [...sessions.values()]) await stop(s)
    },

    isConnected: (userId: ObjectId) => sessions.has(keyOf(userId)),
  }

  async function finishLink(userId: ObjectId, p: PendingLogin, self: TgSelf) {
    clearTimeout(p.timer)
    pending.delete(keyOf(userId))
    await accounts.set(userId, 'telegram', {
      status: 'connected',
      label: self.label,
      session: sealer.seal(p.client.save()),
      detail: 'Syncing your recent chats…',
    })
    const s = start(userId, p.client)
    void sync(s).catch(async (error) => {
      report(error)
      if (!s.stopped) await accounts.set(userId, 'telegram', { status: 'connected' }).catch(report)
    })
  }

  async function expire(userId: ObjectId) {
    if (!pending.has(keyOf(userId))) return
    await dropPending(userId)
    await accounts.set(userId, 'telegram', { status: 'disconnected', detail: 'The code expired. Get a new one to link Telegram.' })
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export type Telegram = ReturnType<typeof createTelegram>
