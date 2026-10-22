import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from 'jose'
import type { AuthenticationState, BaileysEventMap, WAMessage, WAMessageKey } from '@whiskeysockets/baileys'
import { createApp } from '../app.ts'
import { createGoogleVerifier } from '../auth/google.ts'
import { createSessionTokens } from '../auth/tokens.ts'
import { createSealer } from '../crypto.ts'
import { connectDatabase, type Database } from '../db.ts'
import { createInboxStore } from '../inbox/store.ts'
import { createAccounts } from '../networks/accounts.ts'
import { createTelegram, type CreateTgClient, type TgSelf, type TgUpdate } from '../networks/telegram.ts'
import { createWhatsApp, type WaSocket } from '../networks/whatsapp.ts'
import { createHub } from '../realtime.ts'

/** Integration tests run against a real MongoDB when TEST_MONGODB_URI is set (each run gets its own database). */
export const TEST_MONGODB_URI = process.env.TEST_MONGODB_URI

export const GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com'

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

/* ── WhatsApp: a socket the test drives ──────────────────────────────────────── */

export class FakeWaSocket implements WaSocket {
  private listeners = new Map<string, ((arg: never) => void)[]>()
  user?: { id: string; name?: string }
  authState: { creds: AuthenticationState['creds'] }
  pairingPhone?: string
  sent: { jid: string; text: string }[] = []
  read: WAMessageKey[] = []
  loggedOut = false
  ended = false

  constructor(auth: AuthenticationState) {
    this.authState = { creds: auth.creds }
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

  async sendMessage(jid: string, content: { text: string }) {
    this.sent.push({ jid, text: content.text })
    return { key: { remoteJid: jid, fromMe: true, id: `SENT${this.sent.length}` } } as WAMessage
  }

  async readMessages(keys: WAMessageKey[]) {
    this.read.push(...keys)
  }

  async groupMetadata() {
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
    sent: [] as { chatId: string; text: string }[],
    read: [] as { chatId: string; maxId: number }[],
    loggedOut: 0,
    sessions: [] as string[],
    listeners: [] as ((update: TgUpdate) => void)[],
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
      async me() {
        if (state.revoked) throw rpc('AUTH_KEY_UNREGISTERED')
        return self
      },
      async dialogs() {
        return [
          { chat: asha, unreadCount: 1, readOutboxMaxId: 11, date: now - 60 },
          { chat: trek, unreadCount: 0, readOutboxMaxId: 0, date: now - 3600 },
          { chat: { id: '-100999', kind: 'group' as const, name: 'News channel', skip: true }, unreadCount: 9, readOutboxMaxId: 0, date: now },
        ]
      },
      async history(chatId) {
        if (chatId === asha.id) {
          return [
            { id: 12, chat: asha, out: false, text: 'Are we still on for Saturday?', date: now - 60 },
            { id: 11, chat: asha, out: true, text: 'Yes! See you at 9', date: now - 120 },
          ]
        }
        return [
          {
            id: 7,
            chat: trek,
            sender: { id: '6002', kind: 'direct' as const, name: 'Kabir', handle: '@kabir' },
            out: false,
            text: '',
            date: now - 3600,
            media: { attachment: { kind: 'image' as const, name: 'Photo' } },
          },
        ]
      },
      async send(chatId, text) {
        state.sent.push({ chatId, text })
        return { id: 100 + state.sent.length, date: Math.floor(Date.now() / 1000) }
      },
      async markRead(chatId, maxId) {
        state.read.push({ chatId, maxId })
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
    emit: (update: TgUpdate) => state.listeners.forEach((l) => l(update)),
  }
}

/* ── The server, wired to fakes ──────────────────────────────────────────────── */

export interface TestServer {
  url: string
  database: Database
  sockets: FakeWaSocket[]
  telegram: ReturnType<typeof fakeTelegram>
  google: Awaited<ReturnType<typeof fakeGoogle>>
  /** Builds the network managers again over the same database, as after a restart. */
  restart(): Promise<void>
  close(): Promise<void>
}

export async function startTestServer({ port: fixedPort = 0, staticDir }: { port?: number; staticDir?: string } = {}): Promise<TestServer> {
  const dbName = `tidings_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const database = await connectDatabase(TEST_MONGODB_URI!, dbName)
  const sealer = createSealer(Buffer.alloc(32, 7))
  const sockets: FakeWaSocket[] = []
  const telegram = fakeTelegram()
  const google = await fakeGoogle()
  const tokens = createSessionTokens('x'.repeat(40))

  let server: Server
  let managers: { whatsapp: ReturnType<typeof createWhatsApp>; telegram: ReturnType<typeof createTelegram> }

  async function boot(port = 0) {
    const hub = createHub()
    const store = createInboxStore(database.col, sealer)
    const accounts = createAccounts(database.col, hub)
    const whatsapp = createWhatsApp({
      col: database.col,
      sealer,
      store,
      accounts,
      hub,
      media: null,
      createSocket: (auth) => {
        const socket = new FakeWaSocket(auth)
        sockets.push(socket)
        // Like WhatsApp: a fresh device is offered a QR code first.
        if (!auth.creds.registered) setTimeout(() => socket.emit('connection.update', { qr: 'qr-data' }), 5)
        return socket
      },
      linkTimeoutMs: 2000,
    })
    const tg = createTelegram({ sealer, store, accounts, hub, media: null, api: { apiId: 1, apiHash: 'hash' }, createClient: telegram.create })
    managers = { whatsapp, telegram: tg }
    const app = createApp({
      col: database.col,
      tokens,
      google: google.verifier,
      googleClientId: GOOGLE_CLIENT_ID,
      media: null,
      store,
      accounts,
      hub,
      whatsapp,
      telegram: tg,
      secureCookies: false,
      staticDir,
    })
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s))
    })
    return { hub }
  }

  let { hub } = await boot(fixedPort)
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`

  async function shutdown() {
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
    google,
    async restart() {
      const port = (server.address() as AddressInfo).port
      await shutdown()
      ;({ hub } = await boot(port))
      await managers.whatsapp.resumeAll()
      await managers.telegram.resumeAll()
    },
    async close() {
      await shutdown()
      await database.db.dropDatabase()
      await database.close()
    },
  }
}

/* ── A browser stand-in: keeps the session cookie, reads server-sent events ── */

export class Browser {
  cookie = ''
  private readonly base: string

  constructor(base: string) {
    this.base = base
  }

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
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

  get = (path: string) => this.request('GET', path)
  post = (path: string, body: unknown = {}) => this.request('POST', path, body)
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
