import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eventually } from '@/test/fakeTelegram'
import { storage, writeJson } from '../storage'
import type { InboxEvent, Message } from '../types'
import { CONFIG_KEY, LOCAL_KEY, loadLocal } from '../unified/persisted'
import { createUnifiedApi } from '../unified/unifiedApi'
import type { ServerEvent, ServerInbox } from './types'

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

let requests: { method: string; path: string; body?: unknown }[]
let session: 'valid' | 'expired'
let sendGate: Promise<void>
let openSendGate: () => void

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
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
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, path: decodeURIComponent(url.pathname), body })
    if (session === 'expired') return json({ error: 'Sign in to continue.' }, 401)
    if (url.pathname === '/api/inbox') return json(serverInbox())
    if (url.pathname.endsWith('/messages') && method === 'POST') {
      await sendGate
      const message: Message = { id: `${RAVI}:SENT1`, threadId: RAVI, senderId: 'me', body: body.body, sentAt: at(0), status: 'sent' }
      return json({ message })
    }
    if (url.pathname.endsWith('/read')) return json({ ok: true })
    return json({ error: 'Not found.' }, 404)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function signedIn() {
  const api = createUnifiedApi()
  const events: InboxEvent[] = []
  const stop = api.subscribe((e) => events.push(e))
  await api.connections.setServerSession({ name: 'Aarav Mehta' })
  await eventually(() => expect(events.some((e) => e.type === 'reset' && e.snapshot.threads.some((t) => t.id === RAVI))).toBe(true))
  return { api, events, stop, stream: FakeEventSource.instances.at(-1)! }
}

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
    stop()
  })
})
