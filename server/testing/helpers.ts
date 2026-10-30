import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { Readable } from 'node:stream'
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from 'jose'
import type { SharedAi } from '../ai.ts'
import { createGuffshuff, type Guffshuff } from '../networks/guffshuff.ts'
import { createInstagram, type Instagram } from '../networks/instagram.ts'
import { createInstagramWeb } from '../networks/instagramWeb.ts'
import { fakeGuffshuff } from './fakeGuffshuff.ts'
import { fakeCalendar } from './fakeCalendar.ts'
import { fakeInstagram } from './fakeInstagram.ts'
import type { AuthenticationState, BaileysEventMap, WAMessage, WAMessageKey } from '@whiskeysockets/baileys'
import { createApp } from '../app.ts'
import { createGoogleVerifier } from '../auth/google.ts'
import { createSessionTokens } from '../auth/tokens.ts'
import { createSealer } from '../crypto.ts'
import { connectDatabase, type Database } from '../db.ts'
import { createAvatars } from '../inbox/avatars.ts'
import { createFileLinks } from '../inbox/files.ts'
import { createInboxStore, type InboxStore } from '../inbox/store.ts'
import { createAccounts } from '../networks/accounts.ts'
import { createTelegram, type CreateTgClient, type Telegram, type TgMessage, type TgSelf, type TgUpdate } from '../networks/telegram.ts'
import { createWhatsApp, type DownloadWaMedia, type WaContent, type WaSocket, type WhatsApp } from '../networks/whatsapp.ts'
import { createHub } from '../realtime.ts'

/** Integration tests run against a real MongoDB when TEST_MONGODB_URI is set (each run gets its own database). */
export const TEST_MONGODB_URI = process.env.TEST_MONGODB_URI

export const GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com'

/** The largest file the test server takes, so "too big" can be tried without 50 MB. */
export const MAX_TEST_FILE_BYTES = 256 * 1024

export async function waitFor<T>(check: () => T | Promise<T>, { timeout = 4000, interval = 20 } = {}): Promise<T> {
  const started = Date.now()
  for (;;) {
    try {
      return await check()
    } catch (error) {
      if (Date.now() - started > timeout) throw error
      await new Promise((r) => setTimeout(r, interval))
    }
  }
}

/* ── Google: a key pair standing in for Google's ─────────────────────────────── */

export async function fakeGoogle() {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }
  const verifier = createGoogleVerifier(GOOGLE_CLIENT_ID, createLocalJWKSet({ keys: [jwk] }))
  const idToken = (claims: { sub: string; email: string; email_verified?: boolean; name?: string; aud?: string }) =>
    new SignJWT({ email: claims.email, email_verified: claims.email_verified ?? true, name: claims.name })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://accounts.google.com')
      .setAudience(claims.aud ?? GOOGLE_CLIENT_ID)
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey)
  return { verifier, idToken }
}

/** A 1×1 PNG, standing in for profile pictures. */
export const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

/* ── WhatsApp: a socket the test drives ──────────────────────────────────────── */

/**
 * WhatsApp's media servers: files by URL. Sending puts them here; a test can add incoming ones
 * with `mediaMessage`.
 */
export const waMedia = new Map<string, Buffer>()

/** A photo, video or file message's media fields, as WhatsApp sends them, for data now in `waMedia`. */
export function mediaMessage(
  type: 'imageMessage' | 'videoMessage' | 'documentMessage' | 'stickerMessage' | 'audioMessage',
  data: Buffer,
  extra: Record<string, unknown> = {},
) {
  const url = `https://mmg.whatsapp.test/${createHash('sha256').update(data).digest('hex').slice(0, 16)}-${waMedia.size}`
  waMedia.set(url, data)
  return {
    [type]: {
      url,
      directPath: new URL(url).pathname,
      mediaKey: Buffer.alloc(32, 1),
      fileEncSha256: createHash('sha256').update('enc').update(data).digest(),
      fileSha256: createHash('sha256').update(data).digest(),
      fileLength: data.length,
      ...extra,
    },
  }
}

/** Fetches from `waMedia`, the way Baileys would from WhatsApp's servers. */
export const downloadFakeMedia: DownloadWaMedia = async (message) => {
  const content = message.message as Record<string, { url?: string; mediaKey?: Uint8Array } | undefined> | null | undefined
  const media = Object.values(content ?? {}).find((m) => m?.url)
  const data = media?.url ? waMedia.get(media.url) : undefined
  if (!data || !media?.mediaKey?.length) throw Object.assign(new Error('Gone'), { status: 410 })
  return Readable.from([data])
}

export class FakeWaSocket implements WaSocket {
  private listeners = new Map<string, ((arg: never) => void)[]>()
  user?: { id: string; name?: string; lid?: string }
  authState: { creds: AuthenticationState['creds'] }
  pairingPhone?: string
  sent: { jid: string; text: string; quotedId?: string }[] = []
  files: { jid: string; kind: 'image' | 'sticker' | 'video' | 'document'; mimetype: string; fileName?: string; caption?: string; size: number; quotedId?: string }[] = []
  /** Edits, deletions for everyone and pins sent; deletions for me and stars synced. */
  changes: { jid: string; change: string; id: string; text?: string; pinned?: boolean; starred?: boolean; archived?: boolean; timestamp?: number }[] = []
  reactions: { jid: string; emoji: string; targetId: string }[] = []
  presence: { type: string; jid?: string }[] = []
  historyRequests: { count: number; oldestId: string }[] = []
  read: WAMessageKey[] = []
  /** WhatsApp refuses read receipts (as when the connection drops mid-send). */
  failReads = false
  /** WhatsApp refuses whatever is sent next (messages, edits, pins). */
  failSends = false
  loggedOut = false
  ended = false
  /** Chats with a profile picture. */
  pictures = new Set(['919812345678@s.whatsapp.net'])
  /** Private id (LID) → phone-number id, as WhatsApp's key store on the device has them. */
  lids = new Map<string, string>()
  /** Messages the phone has, by id: it sends one again when asked (requestPlaceholderResend). */
  phone: Map<string, WAMessage>
  resendRequests: WAMessageKey[] = []
  signalRepository = {
    lidMapping: {
      getPNForLID: async (lid: string) => this.lids.get(lid) ?? null,
      getLIDForPN: async (pn: string) => [...this.lids].find(([, p]) => p === pn)?.[0] ?? null,
    },
  }

  /** `phone` may be shared by the sockets of a test server (see startTestServer). */
  constructor(auth: AuthenticationState, phone = new Map<string, WAMessage>()) {
    this.authState = { creds: auth.creds }
    this.phone = phone
  }

  ev = {
    on: <E extends keyof BaileysEventMap>(event: E, listener: (arg: BaileysEventMap[E]) => void) => {
      const list = this.listeners.get(event) ?? []
      list.push(listener as (arg: never) => void)
      this.listeners.set(event, list)
    },
  }

  emit<E extends keyof BaileysEventMap>(event: E, arg: BaileysEventMap[E]) {
    for (const listener of this.listeners.get(event) ?? []) (listener as (arg: BaileysEventMap[E]) => void)(arg)
  }

  async requestPairingCode(phone: string) {
    this.pairingPhone = phone
    return 'ABCD1234'
  }

  async sendMessage(jid: string, content: WaContent, options?: { quoted?: WAMessage }) {
    if (this.failSends) throw new Error('Connection Closed')
    if ('react' in content) {
      this.reactions.push({ jid, emoji: content.react.text, targetId: content.react.key.id! })
      return { key: { remoteJid: jid, fromMe: true, id: `REACT${this.reactions.length}` } } as WAMessage
    }
    if ('text' in content && content.edit) {
      this.changes.push({ jid, change: 'edit', id: content.edit.id!, text: content.text })
      return { key: { remoteJid: jid, fromMe: true, id: `EDIT${this.changes.length}` } } as WAMessage
    }
    if ('delete' in content) {
      this.changes.push({ jid, change: 'delete', id: content.delete.id! })
      return { key: { remoteJid: jid, fromMe: true, id: `DEL${this.changes.length}` } } as WAMessage
    }
    if ('pin' in content) {
      this.changes.push({ jid, change: 'pin', id: content.pin.id!, pinned: content.type === 1 })
      return { key: { remoteJid: jid, fromMe: true, id: `PIN${this.changes.length}` } } as WAMessage
    }
    if (!('text' in content)) {
      // Uploaded to WhatsApp's servers; the message carries the keys to fetch it again.
      const [kind, data] =
        'image' in content
          ? (['image', content.image] as const)
          : 'sticker' in content
            ? (['sticker', content.sticker] as const)
            : 'video' in content
              ? (['video', content.video] as const)
              : (['document', content.document] as const)
      const fileName = 'document' in content ? content.fileName : undefined
      const caption = 'caption' in content ? content.caption : undefined
      this.files.push({
        jid,
        kind,
        mimetype: content.mimetype,
        size: data.length,
        ...(fileName ? { fileName } : {}),
        ...(caption ? { caption } : {}),
        ...(options?.quoted ? { quotedId: options.quoted.key.id! } : {}),
      })
      const message = mediaMessage(`${kind}Message`, data, { mimetype: content.mimetype, caption, ...(fileName ? { fileName } : {}) })
      return { key: { remoteJid: jid, fromMe: true, id: `FILE${this.files.length}` }, message } as WAMessage
    }
    this.sent.push({ jid, text: content.text, ...(options?.quoted ? { quotedId: options.quoted.key.id! } : {}) })
    return { key: { remoteJid: jid, fromMe: true, id: `SENT${this.sent.length}` } } as WAMessage
  }

  async sendPresenceUpdate(type: string, jid?: string) {
    this.presence.push({ type, jid })
  }

  async presenceSubscribe(jid: string) {
    this.presence.push({ type: 'subscribe', jid })
  }

  /** Numbers on WhatsApp, as WhatsApp would say: anything starting 91 here. */
  async onWhatsApp(...numbers: string[]) {
    return numbers.map((n) => ({ jid: `${n}@s.whatsapp.net`, exists: n.startsWith('91') }))
  }

  async profilePictureUrl(jid: string) {
    if (!this.pictures.has(jid)) throw new Error('item-not-found')
    return `data:image/png;base64,${PIXEL.toString('base64')}`
  }

  async chatModify(
    change:
      | { deleteForMe: { deleteMedia: boolean; key: WAMessageKey; timestamp: number } }
      | { star: { messages: { id: string; fromMe?: boolean }[]; star: boolean } }
      | { archive: boolean; lastMessages: { key: WAMessageKey; messageTimestamp: number }[] },
    jid: string,
  ) {
    if ('deleteForMe' in change) this.changes.push({ jid, change: 'delete-for-me', id: change.deleteForMe.key.id!, timestamp: change.deleteForMe.timestamp })
    else if ('star' in change) for (const m of change.star.messages) this.changes.push({ jid, change: 'star', id: m.id, starred: change.star.star })
    else this.changes.push({ jid, change: 'archive', id: change.lastMessages.at(-1)?.key.id ?? '', archived: change.archive })
  }

  async requestPlaceholderResend(key: WAMessageKey) {
    this.resendRequests.push(key)
    const message = this.phone.get(key.id!)
    if (message) setTimeout(() => this.emit('messages.upsert', { type: 'notify', messages: [message] } as never), 5)
    return 'resend-request'
  }

  async fetchMessageHistory(count: number, oldestKey: WAMessageKey) {
    this.historyRequests.push({ count, oldestId: oldestKey.id! })
    return 'history-request'
  }

  async readMessages(keys: WAMessageKey[]) {
    if (this.failReads) throw new Error('Connection Closed')
    this.read.push(...keys)
  }

  /** How long WhatsApp takes to say a group's name. */
  groupDelayMs = 0
  /** How many times a group's name was asked for. */
  groupLookups = 0

  async groupMetadata() {
    this.groupLookups++
    if (this.groupDelayMs) await new Promise((r) => setTimeout(r, this.groupDelayMs))
    return { subject: 'Family' }
  }

  async logout() {
    this.loggedOut = true
  }

  end() {
    this.ended = true
  }
}

/* ── Telegram: a client with canned chats ───────────────────────────────────── */

const rpc = (errorMessage: string) => Object.assign(new Error(errorMessage), { errorMessage })

export function fakeTelegram() {
  const self: TgSelf = { id: '42', label: '@aarav' }
  const now = Math.floor(Date.now() / 1000)
  const asha = { id: '5001', kind: 'direct' as const, name: 'Asha Rao', handle: '@asha' }
  const trek = { id: '-100777', kind: 'group' as const, name: 'Trek crew' }
  const state = {
    /** The session was ended from another device. */
    revoked: false,
    needsPassword: true,
    password: 'hunter2',
    codesSent: [] as string[],
    sent: [] as { chatId: string; text: string; replyToId?: number }[],
    files: [] as { chatId: string; name: string; mime: string; caption: string; data: Buffer; replyToId?: number }[],
    read: [] as { chatId: string; maxId: number }[],
    loggedOut: 0,
    sessions: [] as string[],
    listeners: [] as ((update: TgUpdate) => void)[],
    reactions: [] as { chatId: string; messageId: number; emoji: string | null }[],
    changes: [] as { chatId: string; change: 'edit' | 'delete' | 'delete-for-me' | 'pin' | 'unpin' | 'archive' | 'unarchive'; id: number; text?: string }[],
    typing: [] as { chatId: string; typing: boolean }[],
    /** Chats in Telegram's Archive. */
    archived: new Set<string>(),
    /** How many of Asha's messages Telegram counts unread. */
    ashaUnread: 1,
    /** Messages Telegram refuses to fetch again (from a chat left since, say). */
    unreachable: new Set<number>(),
    qrShown: 0,
    /** Scans the QR code shown, as Telegram on a phone would. */
    scanQr: () => {},
  }
  const ashaMessages = [
    { id: 12, chat: asha, out: false, text: 'Are we still on for Saturday?', date: now - 60, replyToId: 11 },
    { id: 11, chat: asha, out: true, text: 'Yes! See you at 9', date: now - 120, reactions: [{ emoji: '👍', count: 1, mine: false }] },
    { id: 10, chat: asha, out: false, text: 'Which trail are we doing?', date: now - 86400 },
    { id: 9, chat: asha, out: true, text: 'Rajmachi, the long one', date: now - 86500 },
  ]

  const trekPhoto: TgMessage = {
    id: 7,
    chat: trek,
    sender: { id: '6002', kind: 'direct' as const, name: 'Kabir', handle: '@kabir' },
    out: false,
    text: '',
    date: now - 3600,
    media: { attachment: { kind: 'image' as const, name: 'Photo', mime: 'image/jpeg' }, file: true },
  }

  const create: CreateTgClient = (session) => {
    state.sessions.push(session)
    return {
      async connect() {},
      async disconnect() {},
      save: () => 'tg-session-secret',
      async sendCode(phone) {
        if (phone === '+10000000000') throw rpc('PHONE_NUMBER_INVALID')
        state.codesSent.push(phone)
        return { phoneCodeHash: 'hash', viaApp: true }
      },
      async signIn(_phone, _hash, code) {
        if (code !== '12345') throw rpc('PHONE_CODE_INVALID')
        if (state.needsPassword) throw rpc('SESSION_PASSWORD_NEEDED')
        return self
      },
      async passwordHint() {
        return 'first pet'
      },
      async checkPassword(password) {
        if (password !== state.password) throw rpc('PASSWORD_HASH_INVALID')
        return self
      },
      async qrLogin(onQr, signal) {
        state.qrShown++
        onQr(`tg://login?token=QR${state.qrShown}`)
        await new Promise<void>((resolve, reject) => {
          state.scanQr = resolve
          signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })
        })
        if (state.needsPassword) throw rpc('SESSION_PASSWORD_NEEDED')
        return self
      },
      async me() {
        if (state.revoked) throw rpc('AUTH_KEY_UNREGISTERED')
        return self
      },
      async dialogs() {
        return [
          { chat: asha, unreadCount: state.ashaUnread, readOutboxMaxId: 11, date: ashaMessages[0]!.date },
          { chat: trek, unreadCount: 0, readOutboxMaxId: 0, date: now - 3600 },
          { chat: { id: '-100999', kind: 'group' as const, name: 'News channel', skip: true }, unreadCount: 9, readOutboxMaxId: 0, date: now },
        ].map((d) => (state.archived.has(d.chat.id) ? { ...d, archived: true } : d))
      },
      async history(chatId, limit, beforeId) {
        if (chatId === asha.id) {
          // The first sync gets the latest two; earlier ones come when asked for.
          return beforeId ? ashaMessages.filter((m) => m.id < beforeId).slice(0, limit) : ashaMessages.slice(0, 2)
        }
        return [trekPhoto]
      },
      async message(chatId, id) {
        if (state.unreachable.has(id)) throw new Error('CHANNEL_PRIVATE')
        if (chatId === trek.id) return id === trekPhoto.id ? trekPhoto : null
        return chatId === asha.id ? (ashaMessages.find((m) => m.id === id) ?? null) : null
      },
      async send(chatId, text, replyToId) {
        state.sent.push({ chatId, text, ...(replyToId ? { replyToId } : {}) })
        return { id: 100 + state.sent.length, date: Math.floor(Date.now() / 1000) }
      },
      async react(chatId, messageId, emoji) {
        if (emoji === '🦄') throw rpc('REACTION_INVALID')
        state.reactions.push({ chatId, messageId, emoji })
      },
      async edit(chatId, id, text) {
        if (text === 'too late') throw rpc('MESSAGE_EDIT_TIME_EXPIRED')
        state.changes.push({ chatId, change: 'edit', id, text })
      },
      async remove(chatId, ids, forEveryone) {
        for (const id of ids) state.changes.push({ chatId, change: forEveryone ? 'delete' : 'delete-for-me', id })
      },
      async archive(chatId, archived) {
        state.changes.push({ chatId, change: archived ? 'archive' : 'unarchive', id: 0 })
        if (archived) state.archived.add(chatId)
        else state.archived.delete(chatId)
      },
      async pin(chatId, id, pinned) {
        state.changes.push({ chatId, change: pinned ? 'pin' : 'unpin', id })
      },
      async setTyping(chatId, typing) {
        state.typing.push({ chatId, typing })
      },
      async picture(chatId) {
        return chatId === asha.id ? PIXEL : undefined
      },
      async download(chatId, messageId) {
        if (chatId === trek.id && messageId === 7) return { data: PIXEL }
        const sent = state.files[messageId - 201]
        if (sent?.chatId !== chatId) return null
        // Documents arrive in pieces.
        return { data: Readable.from([sent.data.subarray(0, 3), sent.data.subarray(3)]), size: sent.data.length }
      },
      async sendFile(chatId, file, caption, replyToId) {
        state.files.push({ chatId, name: file.name, mime: file.mime, caption, data: file.data, ...(replyToId ? { replyToId } : {}) })
        return { id: 200 + state.files.length, date: Math.floor(Date.now() / 1000) }
      },
      async markRead(chatId, maxId) {
        state.read.push({ chatId, maxId })
      },
      async searchPeople(query) {
        // Someone the account has never written to, found by name or username.
        const meera = { id: '7001', kind: 'direct' as const, name: 'Meera Iyer', handle: '@meera' }
        return /meera/i.test(query) ? [meera] : []
      },
      async logOut() {
        state.loggedOut++
      },
      onUpdate(listener) {
        state.listeners.push(listener)
      },
    }
  }

  return {
    state,
    create,
    asha,
    trek,
    /** Asha's chat as Telegram has it, newest first; a test can add messages the server missed. */
    ashaMessages: ashaMessages as TgMessage[],
    emit: (update: TgUpdate) => state.listeners.forEach((l) => l(update)),
  }
}

/* ── The server, wired to fakes ──────────────────────────────────────────────── */

export interface TestServer {
  url: string
  database: Database
  sockets: FakeWaSocket[]
  telegram: ReturnType<typeof fakeTelegram>
  guffshuff: ReturnType<typeof fakeGuffshuff>
  instagram: ReturnType<typeof fakeInstagram>
  calendar: ReturnType<typeof fakeCalendar>
  google: Awaited<ReturnType<typeof fakeGoogle>>
  /** The parts running now (rebuilt by `restart`). */
  current(): { store: InboxStore; whatsapp: WhatsApp; telegram: Telegram; guffshuff: Guffshuff; instagram: Instagram }
  /** Builds the network managers again over the same database, as after a restart. */
  restart(): Promise<void>
  close(): Promise<void>
}

/**
 * `sharedPhone`: every WhatsApp connection is the same phone, which keeps its messages across
 * reconnects and restarts (for clicking through by hand); otherwise each connection has its own.
 */
export async function startTestServer({
  port: fixedPort = 0,
  staticDir,
  sharedPhone = false,
  ai,
  guffshuffCatchUpMs,
  instagramCatchUpMs,
}: {
  port?: number
  staticDir?: string
  sharedPhone?: boolean
  ai?: SharedAi
  guffshuffCatchUpMs?: number
  instagramCatchUpMs?: number
} = {}): Promise<TestServer> {
  const dbName = `tidings_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const database = await connectDatabase(TEST_MONGODB_URI!, dbName)
  const sealer = createSealer(Buffer.alloc(32, 7))
  const sockets: FakeWaSocket[] = []
  const phone = sharedPhone ? new Map<string, WAMessage>() : undefined
  const telegram = fakeTelegram()
  const guffshuff = fakeGuffshuff()
  const instagram = fakeInstagram()
  const calendar = fakeCalendar()
  const google = await fakeGoogle()
  const tokens = createSessionTokens('x'.repeat(40))

  let server: Server
  let managers: { store: InboxStore; whatsapp: WhatsApp; telegram: Telegram; guffshuff: Guffshuff; instagram: Instagram }

  async function boot(port = 0) {
    const hub = createHub()
    const store = createInboxStore(database.col, sealer)
    const avatars = createAvatars(database.col, sealer)
    const accounts = createAccounts(database.col, hub)
    const files = createFileLinks(sealer)
    const whatsapp = createWhatsApp({
      col: database.col,
      sealer,
      store,
      accounts,
      hub,
      avatars,
      files,
      downloadMedia: downloadFakeMedia,
      filesRepairDelayMs: 50,
      groupTitleWaitMs: 400,
      createSocket: (auth) => {
        const socket = new FakeWaSocket(auth, phone)
        sockets.push(socket)
        // Like WhatsApp: a fresh device is offered a QR code first.
        if (!auth.creds.registered) setTimeout(() => socket.emit('connection.update', { qr: 'qr-data' }), 5)
        return socket
      },
      linkTimeoutMs: 2000,
    })
    const tg = createTelegram({
      sealer,
      store,
      accounts,
      hub,
      avatars,
      files,
      api: { apiId: 1, apiHash: 'hash' },
      createClient: telegram.create,
    })
    const gs = createGuffshuff({
      sealer,
      store,
      accounts,
      hub,
      avatars,
      files,
      api: { ...guffshuff.api, ...(guffshuffCatchUpMs ? { catchUpMs: guffshuffCatchUpMs } : {}) },
    })
    const ig = createInstagram({
      sealer,
      store,
      accounts,
      hub,
      avatars,
      files,
      site: createInstagramWeb({ fetch: instagram.fetch }),
      ...(instagramCatchUpMs ? { catchUpMs: instagramCatchUpMs } : {}),
    })
    managers = { store, whatsapp, telegram: tg, guffshuff: gs, instagram: ig }
    const app = createApp({
      col: database.col,
      tokens,
      google: google.verifier,
      googleClientId: GOOGLE_CLIENT_ID,
      media: null,
      store,
      avatars,
      accounts,
      hub,
      whatsapp,
      telegram: tg,
      guffshuff: gs,
      instagram: ig,
      files,
      sealer,
      calendar: { clientId: GOOGLE_CLIENT_ID, clientSecret: 'calendar-secret', fetch: calendar.fetch },
      maxFileBytes: MAX_TEST_FILE_BYTES,
      secureCookies: false,
      staticDir,
      ai,
    })
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s))
    })
    return { hub }
  }

  let { hub } = await boot(fixedPort)
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`

  async function shutdown() {
    managers?.guffshuff.stopAll()
    managers?.instagram.stopAll()
    hub.closeAll()
    await managers.whatsapp.stopAll()
    await managers.telegram.stopAll()
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }

  return {
    url,
    database,
    sockets,
    telegram,
    guffshuff,
    instagram,
    calendar,
    google,
    current: () => managers,
    async restart() {
      const port = (server.address() as AddressInfo).port
      await shutdown()
      ;({ hub } = await boot(port))
      await managers.whatsapp.resumeAll()
      await managers.telegram.resumeAll()
      await managers.guffshuff.resumeAll()
      await managers.instagram.resumeAll()
    },
    async close() {
      await shutdown()
      await database.db.dropDatabase()
      await database.close()
    },
  }
}

/* ── A browser stand-in: keeps the session cookie, reads server-sent events ── */

let visitors = 0

export class Browser {
  cookie = ''
  private readonly base: string
  /** Each browser is its own visitor, as rate limits see it (the server trusts one proxy). */
  readonly address: string

  constructor(base: string) {
    this.base = base
    visitors++
    this.address = `10.${(visitors >> 16) & 255}.${(visitors >> 8) & 255}.${visitors & 255}`
  }

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        'X-Forwarded-For': this.address,
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    const set = res.headers.get('set-cookie')
    if (set) this.cookie = set.split(';')[0]!.endsWith('=') ? '' : set.split(';')[0]!
    const text = await res.text()
    let json: Record<string, unknown> = {}
    try {
      json = JSON.parse(text)
    } catch {
      // Not JSON.
    }
    return { status: res.status, json: json as Record<string, any>, headers: res.headers, text }
  }

  /** A request whose answer is bytes (a file), or whose body is (an upload). */
  async raw(method: string, path: string, body?: Buffer, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: { ...(this.cookie ? { Cookie: this.cookie } : {}), 'X-Forwarded-For': this.address, ...headers },
      ...(body ? { body: new Uint8Array(body) } : {}),
    })
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) }
  }

  /** A page the browser goes to, its redirect kept as it came (not followed). */
  async visit(path: string) {
    const res = await fetch(this.base + path, {
      headers: { ...(this.cookie ? { Cookie: this.cookie } : {}), 'X-Forwarded-For': this.address },
      redirect: 'manual',
    })
    await res.arrayBuffer()
    return { status: res.status, headers: res.headers }
  }

  /** Sends a photo or file the way the app does. */
  async upload(threadId: string, data: Buffer, file: { name: string; type: string; caption?: string; replyToId?: string; sticker?: boolean }) {
    const res = await this.raw('POST', `/api/threads/${encodeURIComponent(threadId)}/files`, data, {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
      'X-File-Type': file.type,
      ...(file.caption ? { 'X-Caption': encodeURIComponent(file.caption) } : {}),
      ...(file.replyToId ? { 'X-Reply-To': encodeURIComponent(file.replyToId) } : {}),
      ...(file.sticker ? { 'X-Sticker': '1' } : {}),
    })
    let json: Record<string, any> = {}
    try {
      json = JSON.parse(res.body.toString('utf8'))
    } catch {
      // Not JSON.
    }
    return { status: res.status, json }
  }

  get = (path: string) => this.request('GET', path)
  post = (path: string, body: unknown = {}) => this.request('POST', path, body)
  put = (path: string, body: unknown = {}) => this.request('PUT', path, body)
  delete = (path: string) => this.request('DELETE', path, {})

  /** Opens /api/events and collects what arrives. */
  async events() {
    const controller = new AbortController()
    const res = await fetch(`${this.base}/api/events`, { headers: { Cookie: this.cookie }, signal: controller.signal })
    if (res.status !== 200) throw new Error(`events: ${res.status}`)
    const received: Record<string, any>[] = []
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return
          buffer += decoder.decode(value, { stream: true })
          let end
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const data = frame
              .split('\n')
              .filter((l) => l.startsWith('data: '))
              .map((l) => l.slice(6))
              .join('\n')
            if (data) received.push(JSON.parse(data))
          }
        }
      } catch {
        // Closed.
      }
    })()
    return {
      received,
      next: (match: (event: Record<string, any>) => boolean) => waitFor(() => {
        const found = received.find(match)
        if (!found) throw new Error(`No matching event; got ${received.map((e) => e.type).join(', ')}`)
        return found
      }),
      close: () => controller.abort(),
    }
  }
}
