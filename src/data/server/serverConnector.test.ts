import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eventually } from '@/test/fakeTelegram'
import { storage, writeJson } from '../storage'
import type { InboxEvent, Message } from '../types'
import { CONFIG_KEY, LOCAL_KEY, loadLocal } from '../unified/persisted'
import { createUnifiedApi } from '../unified/unifiedApi'
import { openDeviceStore, wipeDeviceStore } from './deviceStore'
import { MESSAGES_KEPT_PER_CHAT, type PublicUser, type ServerEvent, type ServerInbox, type ServerOlderMessages } from './types'

/** Stands in for the browser's EventSource; the test pushes events through it. */
class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []
  readyState = FakeEventSource.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
    setTimeout(() => {
      this.readyState = FakeEventSource.OPEN
      this.onopen?.()
    }, 0)
  }

  push(event: ServerEvent) {
    this.onmessage?.({ data: JSON.stringify(event) })
  }

  /** The response failed (say, the session expired): the browser gives up on the stream. */
  fail() {
    this.readyState = FakeEventSource.CLOSED
    this.onerror?.()
  }

  close() {
    this.readyState = FakeEventSource.CLOSED
  }
}

const RAVI = 'wa:919812345678@s.whatsapp.net'
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

function serverInbox(): ServerInbox {
  return {
    threads: [
      { id: RAVI, network: 'whatsapp', kind: 'direct', title: 'Ravi Kumar', participantIds: [RAVI], unreadCount: 1, doneAt: null, snoozedUntil: null },
    ],
    contacts: [{ id: RAVI, name: 'Ravi Kumar', network: 'whatsapp', handle: '+919812345678' }],
    messages: [{ id: `${RAVI}:M1`, threadId: RAVI, senderId: RAVI, body: 'Did the parcel arrive?', sentAt: at(5) }],
    accounts: [{ network: 'whatsapp', status: 'connected', label: '+919876543210' }],
  }
}

let requests: { method: string; path: string; body?: unknown; query?: Record<string, string> }[]
let session: 'valid' | 'expired'
let sendGate: Promise<void>
let openSendGate: () => void
/** What the server has, as a test sets it up. */
let inbox: ServerInbox
/** What "Load earlier" gets from the server, page by page. */
let olderPages: ServerOlderMessages[]
/** The server no longer keeps the message reacted to. */
let reactionUnknown: boolean
/** Photos and files uploaded: in what order, and how many at once at most. */
let uploads: { started: string[]; active: number; most: number }
let inboxGate: Promise<void>

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(async () => {
  await wipeDeviceStore()
  inbox = serverInbox()
  olderPages = [{ messages: [{ id: `${RAVI}:M0`, threadId: RAVI, senderId: RAVI, body: 'Parcel booked?', sentAt: at(60 * 24) }], hasMore: false }]
  reactionUnknown = false
  uploads = { started: [], active: 0, most: 0 }
  inboxGate = Promise.resolve()
  for (const key of [CONFIG_KEY, LOCAL_KEY, 'tidings.mockdb']) storage.remove(key)
  writeJson(CONFIG_KEY, { demo: false })
  FakeEventSource.instances = []
  requests = []
  session = 'valid'
  sendGate = new Promise((resolve) => (openSendGate = resolve))
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://tidings.test')
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const query = Object.fromEntries(url.searchParams)
    requests.push({ method, path: decodeURIComponent(url.pathname), body, ...(url.search ? { query } : {}) })
    if (session === 'expired') return json({ error: 'Sign in to continue.' }, 401)
    if (url.pathname === '/api/inbox') {
      await inboxGate
      return json(inbox)
    }
    if (url.pathname.endsWith('/messages') && method === 'POST') {
      await sendGate
      const message: Message = { id: `${RAVI}:SENT1`, threadId: RAVI, senderId: 'me', body: body.body, sentAt: at(0), status: 'sent' }
      return json({ message })
    }
    if (url.pathname.endsWith('/read') || url.pathname.endsWith('/typing')) return json({ ok: true })
    if (url.pathname.endsWith('/files')) {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const name = decodeURIComponent(headers['X-File-Name'] ?? '')
      uploads.started.push(name)
      uploads.active++
      uploads.most = Math.max(uploads.most, uploads.active)
      await new Promise((resolve) => setTimeout(resolve, 15))
      uploads.active--
      const message: Message = { id: `${RAVI}:F-${name}`, threadId: RAVI, senderId: 'me', body: '', sentAt: at(0), status: 'sent' }
      return json({ message })
    }
    if (url.pathname.endsWith('/archive')) {
      const thread = inbox.threads.find((t) => url.pathname.includes(encodeURIComponent(t.id)) || url.pathname.includes(t.id))!
      return json({ thread: { ...thread, ...(body.archived ? { archived: true } : {}) } })
    }
    if (url.pathname.endsWith('/reactions')) {
      if (reactionUnknown) return json({ message: null })
      const message: Message = { ...inbox.messages[0], reactions: [{ emoji: body.emoji, count: 1, mine: true }] }
      return json({ message })
    }
    if (url.pathname.endsWith('/messages') && method === 'GET') return json(olderPages.shift() ?? { messages: [], hasMore: false })
    return json({ error: 'Not found.' }, 404)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function signedIn({ waitForServer = true } = {}) {
  const api = createUnifiedApi()
  const events: InboxEvent[] = []
  const stop = api.subscribe((e) => events.push(e))
  await api.connections.setServerSession({ id: 'u1', name: 'Aarav Mehta' })
  if (waitForServer) await eventually(() => expect(api.connections.get().server?.status.state).toBe('online'))
  return { api, events, stop, stream: FakeEventSource.instances.at(-1)! }
}

/** This device's copy as written so far (it's written shortly after each change). */
async function deviceCopy() {
  return (await openDeviceStore('u1')).load(1000)
}

const messageAt = (n: number, minutesAgo: number): Message => ({
  id: `${RAVI}:N${n}`,
  threadId: RAVI,
  senderId: RAVI,
  body: `Message ${n}`,
  sentAt: at(minutesAgo),
})

describe('chats linked on the server', () => {
  it('loads them with the account state once signed in', async () => {
    const { api, stop } = await signedIn()
    const inbox = await api.loadInbox()
    expect(inbox.threads.map((t) => t.id)).toEqual([RAVI])
    expect(inbox.me.name).toBe('Aarav Mehta')
    expect(api.connections.get().server).toMatchObject({
      status: { state: 'online' },
      whatsapp: { status: 'connected', label: '+919876543210' },
      telegram: null,
    })
    stop()
  })

  it('passes live changes through', async () => {
    const { events, stream, stop } = await signedIn()
    stream.push({ type: 'message.created', message: { id: `${RAVI}:M2`, threadId: RAVI, senderId: RAVI, body: 'Call me', sentAt: at(0) } })
    expect(events.at(-1)).toMatchObject({ type: 'message.created', message: { body: 'Call me' } })
    stream.push({ type: 'account.updated', account: { network: 'telegram', status: 'linking', label: '+919876543210' } })
    stop()
  })

  it('routes sends and read markers to the server, holding back the echo of a send', async () => {
    const { api, events, stream, stop } = await signedIn()
    const sending = api.sendMessage(RAVI, 'On my way')
    await eventually(() => expect(requests.some((r) => r.method === 'POST' && r.path.endsWith('/messages'))).toBe(true))
    expect(requests.find((r) => r.method === 'POST')).toEqual({ method: 'POST', path: `/api/threads/${RAVI}/messages`, body: { body: 'On my way' } })

    // WhatsApp's echo of the message can arrive before the send returns…
    const echo: Message = { id: `${RAVI}:SENT1`, threadId: RAVI, senderId: 'me', body: 'On my way', sentAt: at(0), status: 'sending' }
    stream.push({ type: 'message.created', message: echo })
    expect(events.some((e) => e.type === 'message.created' && e.message.id === echo.id)).toBe(false)
    // …and is passed on only after it.
    openSendGate()
    expect(await sending).toMatchObject({ id: echo.id, status: 'sent' })
    await eventually(() => expect(events.some((e) => e.type === 'message.created' && e.message.id === echo.id)).toBe(true))

    await api.markRead(RAVI)
    expect(requests.at(-1)).toMatchObject({ method: 'POST', path: `/api/threads/${RAVI}/read` })
    // The account's setting decides whether a read receipt goes out.
    expect(requests.at(-1)?.body ?? {}).not.toHaveProperty('receipt')
    // Incognito: read here, with no read receipt.
    await api.markRead(RAVI, { receipt: false })
    expect(requests.at(-1)).toMatchObject({ path: `/api/threads/${RAVI}/read`, body: { receipt: false } })

    // Archived on WhatsApp through the server, and kept on this device as it comes back.
    expect(await api.archiveThread(RAVI, true)).toMatchObject({ id: RAVI, archived: true })
    expect(requests.at(-1)).toMatchObject({ method: 'POST', path: `/api/threads/${RAVI}/archive`, body: { archived: true } })
    stop()
  })

  it('passes account changes from other devices on (Incognito mode turned on there, say)', async () => {
    const { api, stream, stop } = await signedIn()
    const changed: PublicUser[] = []
    const off = api.connections.onUserUpdated((user) => changed.push(user))
    const user: PublicUser = { id: 'u1', email: 'aarav@example.com', name: 'Aarav Mehta', hasPassword: true, google: false, incognito: true }
    stream.push({ type: 'user.updated', user })
    // Someone else's account is never applied here.
    stream.push({ type: 'user.updated', user: { ...user, id: 'u2' } })
    expect(changed).toEqual([user])
    off()
    stop()
  })

  it('reacts, pages back and passes typing on, for chats that support it', async () => {
    const { api, events, stream, stop } = await signedIn()
    expect(api.capabilities(RAVI)).toEqual({ reply: true, react: true, typing: true, history: true, files: true, edit: true, delete: true, pin: true, star: true })

    const reacted = await api.react(RAVI, `${RAVI}:M1`, '🙏')
    expect(reacted.reactions).toEqual([{ emoji: '🙏', count: 1, mine: true }])
    expect(requests.at(-1)).toMatchObject({
      method: 'POST',
      path: `/api/threads/${RAVI}/reactions`,
      // What this device knows of the message goes along, in case the server no longer keeps it.
      body: { messageId: `${RAVI}:M1`, emoji: '🙏', message: { id: `${RAVI}:M1`, senderId: RAVI } },
    })
    // It doesn't: only this device's copy changes.
    reactionUnknown = true
    expect((await api.react(RAVI, `${RAVI}:M1`, '👍')).reactions).toEqual([{ emoji: '👍', count: 1, mine: true }])

    const older = await api.loadOlder(RAVI, `${RAVI}:M1`)
    expect(older).toMatchObject({ hasMore: false, messages: [{ body: 'Parcel booked?' }] })
    expect(requests.at(-1)).toMatchObject({
      method: 'GET',
      path: `/api/threads/${RAVI}/messages`,
      query: { before: `${RAVI}:M1`, senderId: RAVI, sentAt: inbox.messages[0].sentAt },
    })

    await api.setTyping(RAVI, true)
    expect(requests.at(-1)).toMatchObject({ method: 'POST', path: `/api/threads/${RAVI}/typing`, body: { typing: true } })
    stream.push({ type: 'typing', threadId: RAVI, senderId: RAVI, active: true })
    expect(events.at(-1)).toEqual({ type: 'typing', threadId: RAVI, senderId: RAVI, active: true })
    stop()
  })

  it('reports an ended session, and forgets everything about those chats on sign-out', async () => {
    const { api, stream, stop } = await signedIn()
    await api.updateThreadState(RAVI, { doneAt: at(0) })
    await api.addTask({ title: 'Check the parcel', dueAt: null, source: { threadId: RAVI, messageId: `${RAVI}:M1` } })
    expect(loadLocal().threadState[RAVI]).toBeDefined()

    const signedOut = vi.fn()
    api.connections.onSignedOut(signedOut)
    session = 'expired'
    stream.fail()
    await eventually(() => expect(signedOut).toHaveBeenCalledTimes(1))

    await api.connections.setServerSession(null)
    const inbox = await api.loadInbox()
    expect(inbox.threads).toEqual([])
    expect(inbox.tasks).toEqual([])
    expect(loadLocal().threadState[RAVI]).toBeUndefined()
    expect(api.connections.get().server).toBeNull()
    // This device's copy goes too.
    await eventually(async () => expect((await (await openDeviceStore('u1')).load(10)).threads).toEqual([]))
    stop()
  })

  it('keeps the chats on this device: shown on the next start before the server answers, and kept when the server lets go', async () => {
    const first = await signedIn()
    first.stream.push({ type: 'message.created', message: messageAt(2, 1) })
    await eventually(async () => expect((await deviceCopy()).messages.map((m) => m.id)).toContain(`${RAVI}:N2`))
    first.stop()

    // Next time, the server is slow to answer, and no longer has N2 (it keeps only the latest).
    let answer!: () => void
    inboxGate = new Promise((resolve) => (answer = resolve))
    const second = await signedIn({ waitForServer: false })
    await eventually(async () => expect((await second.api.loadInbox()).messages.map((m) => m.body)).toContain('Message 2'))
    expect(second.api.connections.get().server?.status.state).toBe('connecting')
    answer()
    await eventually(() => expect(second.api.connections.get().server?.status.state).toBe('online'))
    expect((await second.api.loadInbox()).messages.map((m) => m.body)).toEqual(expect.arrayContaining(['Message 2', 'Did the parcel arrive?']))
    second.stop()
  })

  it('sends photos and files one at a time, in the order they were sent', async () => {
    const { api, stop } = await signedIn()
    const files = ['first.jpg', 'second.pdf', 'third.png'].map((name) => new File(['x'], name, { type: 'application/octet-stream' }))
    await Promise.all(files.map((file) => api.sendMessage(RAVI, '', { file })))
    expect(uploads.started).toEqual(['first.jpg', 'second.pdf', 'third.png'])
    expect(uploads.most).toBe(1)
    stop()
  })

  it('removes what was deleted for me while this device was away', async () => {
    const store = await openDeviceStore('u1')
    const gone: Message = { id: `${RAVI}:GONE`, threadId: RAVI, senderId: RAVI, body: 'Deleted on the phone', sentAt: at(3) }
    store.put({ threads: inbox.threads, messages: [gone, messageAt(7, 2)] })
    await store.flush()
    inbox.deleted = [gone.id]

    const { api, stop } = await signedIn()
    const bodies = (await api.loadInbox()).messages.map((m) => m.body)
    expect(bodies).not.toContain('Deleted on the phone')
    // What the server simply doesn't keep stays.
    expect(bodies).toContain('Message 7')
    await eventually(async () => expect((await deviceCopy()).messages.map((m) => m.id)).not.toContain(gone.id))
    stop()
  })

  it("pages back through this device's copy before asking the server", async () => {
    const store = await openDeviceStore('u1')
    store.put({ threads: inbox.threads, messages: Array.from({ length: 5 }, (_, i) => messageAt(i, 60 * (i + 1))) })
    await store.flush()
    const { api, stop } = await signedIn()

    const before = requests.length
    const fromDevice = await api.loadOlder(RAVI, `${RAVI}:N0`)
    expect(fromDevice.messages.map((m) => m.body)).toEqual(['Message 4', 'Message 3', 'Message 2', 'Message 1'])
    expect(requests.length).toBe(before)

    // Nothing older here: the server (and through it, the network) is asked.
    const fromServer = await api.loadOlder(RAVI, `${RAVI}:N4`)
    expect(fromServer.messages.map((m) => m.body)).toEqual(['Parcel booked?'])
    expect(requests.at(-1)).toMatchObject({ method: 'GET', query: { before: `${RAVI}:N4` } })
    stop()
  })

  it('fills in what came while this device was away', async () => {
    // The device last saw a message from yesterday; since then more came than the server keeps.
    const store = await openDeviceStore('u1')
    store.put({ threads: inbox.threads, messages: [messageAt(0, 60 * 24)] })
    await store.flush()
    inbox.messages = Array.from({ length: MESSAGES_KEPT_PER_CHAT }, (_, i) => messageAt(100 + i, 100 - i))
    olderPages = [{ messages: [messageAt(50, 300), messageAt(51, 200)], hasMore: true }, { messages: [messageAt(40, 600)], hasMore: true }]

    const { api, stop } = await signedIn()
    await eventually(async () => expect((await api.loadInbox()).messages.map((m) => m.body)).toContain('Message 40'))
    const asked = requests.filter((r) => r.method === 'GET' && r.path.endsWith('/messages'))
    // From the oldest the server has, back to what this device has, a few pages at most.
    expect(asked.map((r) => r.query?.before)).toEqual([`${RAVI}:N100`, `${RAVI}:N50`, `${RAVI}:N40`])
    stop()
  })

  it('drops the chats of a network unlinked elsewhere', async () => {
    const store = await openDeviceStore('u1')
    const asha = { ...inbox.threads[0], id: 'tga:5001', network: 'telegram' as const, title: 'Asha' }
    store.put({ threads: [asha], messages: [{ id: 'tga:5001:1', threadId: 'tga:5001', senderId: 'tga:5001', body: 'Hi', sentAt: at(5) }] })
    await store.flush()

    const { api, stop } = await signedIn()
    const threads = (await api.loadInbox()).threads.map((t) => t.id)
    expect(threads).toContain(RAVI)
    expect(threads).not.toContain('tga:5001')
    await eventually(async () => expect((await deviceCopy()).threads.map((t) => t.id)).toEqual([RAVI]))
    stop()
  })
})
