import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assetLinks } from './app.ts'
import type { Message, Thread } from '../src/data/types.ts'
import { ASHA } from './testing/fakeGuffshuff.ts'
import { Browser, SIGN_UP, startTestServer, TEST_MONGODB_URI, waitFor, type TestServer } from './testing/helpers.ts'
import { messageLine, notificationFor, notifyingHub, subscriptionOf, type Push } from './push.ts'
import type { Hub } from './realtime.ts'
import type { InboxStore } from './inbox/store.ts'

const KEYS = { p256dh: 'BOr2mJ3c-lHd1yXxS0p8a7yqPZ6gZ8i1nZ8m2r1Hc4w', auth: 'k5d3mVq9e2bS1zYw0aQx7g' }
const fcm = (id: string) => `https://fcm.googleapis.com/fcm/send/${id}`

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: 'wa:123@s.whatsapp.net',
  network: 'whatsapp',
  kind: 'direct',
  title: 'Asha Rao',
  participantIds: ['wa:123@s.whatsapp.net'],
  unreadCount: 1,
  doneAt: null,
  snoozedUntil: null,
  ...over,
})
const message = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  threadId: 'wa:123@s.whatsapp.net',
  senderId: 'wa:123@s.whatsapp.net',
  body: 'Are we still on for 6?',
  sentAt: new Date().toISOString(),
  ...over,
})

describe('a device subscribing', () => {
  it('takes the push services browsers use', () => {
    for (const endpoint of [
      fcm('abc'),
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QAbc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) {
      expect(subscriptionOf({ subscription: { endpoint, keys: KEYS } })).toEqual({ endpoint, keys: KEYS })
    }
  })

  it('refuses anywhere else, so the server never posts where someone points it', () => {
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://evil.example/fcm.googleapis.com',
      'https://fcm.googleapis.com.evil.example/x',
      'https://127.0.0.1/push',
      'not a url',
    ]) {
      expect(() => subscriptionOf({ subscription: { endpoint, keys: KEYS } })).toThrow(/notification service/)
    }
    expect(() => subscriptionOf({ subscription: { endpoint: fcm('a'), keys: { p256dh: 'x y', auth: 'z' } } })).toThrow(/keys/)
    expect(() => subscriptionOf({})).toThrow()
  })
})

describe('the Android app’s asset links', () => {
  it('lists the keys of the APKs built, and any set, once each', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'assetlinks-')), 'signing-sha256.txt')
    const built = 'AB:'.repeat(31) + 'CD'
    writeFileSync(file, `${built}\nnot a fingerprint\n${built.toLowerCase()}\n`)
    const [link] = assetLinks([' ' + 'EF:'.repeat(31) + 'EF '], file)
    expect(link!.target.sha256_cert_fingerprints).toEqual([built, 'EF:'.repeat(31) + 'EF'])
    expect(assetLinks([], join(tmpdir(), 'missing-file'))).toEqual([])
  })
})

describe('what a notification says', () => {
  it('names the chat and the network, with the message', () => {
    expect(notificationFor(thread(), message(), null, true)).toMatchObject({
      title: 'Asha Rao · WhatsApp',
      body: 'Are we still on for 6?',
      tag: 'chat:wa:123@s.whatsapp.net',
      url: '/chat/wa%3A123%40s.whatsapp.net',
    })
  })

  it('says who wrote in a group', () => {
    const group = thread({ id: 'wa:1-2@g.us', kind: 'group', title: 'Family', network: 'telegram' })
    expect(notificationFor(group, message({ threadId: group.id }), 'Kabir', true)).toMatchObject({ title: 'Family · Telegram', body: 'Kabir: Are we still on for 6?' })
  })

  it('shows neither who nor what with previews off', () => {
    const quiet = notificationFor(thread(), message(), null, false)
    expect(quiet.title).toBe('Sytext')
    expect(quiet.body).toBe('New message on WhatsApp')
    expect(JSON.stringify(quiet)).not.toMatch(/Asha|still on/)
  })

  it('describes what a message without text carries', () => {
    expect(messageLine({ body: '', attachments: [{ kind: 'image', name: 'Photo' }] })).toBe('Photo')
    expect(messageLine({ body: '', attachments: [{ kind: 'audio', name: 'Voice' }] })).toBe('Voice message')
    expect(messageLine({ body: '', attachments: [{ kind: 'sticker', name: 'Sticker' }] })).toBe('Sticker')
    expect(messageLine({ body: '', attachments: [{ kind: 'file', name: 'menu.pdf' }] })).toBe('File: menu.pdf')
    expect(messageLine({ body: 'x'.repeat(400) })).toHaveLength(180)
  })
})

describe('the notifying hub', () => {
  const USER = '64b7f0c2a1b2c3d4e5f60718'

  function setup(threads: Record<string, Thread> = { [thread().id]: thread() }) {
    const published: unknown[] = []
    const sent: string[] = []
    const hub: Hub = { attach() {}, publish: (_u, e) => void published.push(e), size: () => 0, closeAll() {} }
    const push = {
      send: async (_userId: unknown, payload: Parameters<Push['send']>[1]) => {
        sent.push((typeof payload === 'function' ? payload(true) : payload).body)
        return 1
      },
    } as unknown as Push
    const store = { thread: async (_u: unknown, id: string) => threads[id] ?? null, contact: async () => null } as unknown as InboxStore
    let now = Date.now()
    const notifying = notifyingHub(hub, { push, store, now: () => now })
    return { notifying, published, sent, later: (ms: number) => (now += ms) }
  }

  it('notifies of someone else’s new message, and still streams every event', async () => {
    const { notifying, published, sent } = setup()
    notifying.publish(USER, { type: 'message.created', message: message() })
    notifying.publish(USER, { type: 'typing', threadId: 'x', senderId: 'y', active: true })
    await waitFor(() => expect(sent).toEqual(['Are we still on for 6?']))
    expect(published).toHaveLength(2)
  })

  it('stays quiet for my own messages, old ones catching up, and archived chats', async () => {
    const archived = thread({ id: 'wa:9@s.whatsapp.net', archived: true })
    const { notifying, sent } = setup({ [thread().id]: thread(), [archived.id]: archived })
    notifying.publish(USER, { type: 'message.created', message: message({ senderId: 'me' }) })
    notifying.publish(USER, { type: 'message.created', message: message({ sentAt: new Date(Date.now() - 3 * 3600_000).toISOString() }) })
    notifying.publish(USER, { type: 'message.created', message: message({ threadId: archived.id }) })
    notifying.publish(USER, { type: 'message.updated', message: message() })
    await new Promise((r) => setTimeout(r, 30))
    expect(sent).toEqual([])
  })

  it('holds back a flood to a dozen a minute', async () => {
    const { notifying, sent, later } = setup()
    for (let i = 0; i < 30; i++) notifying.publish(USER, { type: 'message.created', message: message({ id: `m${i}`, body: `${i}` }) })
    await waitFor(() => expect(sent).toHaveLength(12))
    later(61_000)
    notifying.publish(USER, { type: 'message.created', message: message({ id: 'late', body: 'later', sentAt: new Date(Date.now() + 61_000).toISOString() }) })
    await waitFor(() => expect(sent.at(-1)).toBe('later'))
  })
})

describe.skipIf(!TEST_MONGODB_URI)('notifications of new messages', () => {
  let server: TestServer

  beforeAll(async () => {
    server = await startTestServer()
  })
  afterAll(() => server?.close())

  const newUser = async (email: string) => {
    const browser = new Browser(server.url)
    expect((await browser.post('/api/auth/register', { name: 'Aarav', email, password: 'long enough', ...SIGN_UP })).status).toBe(200)
    return browser
  }
  const subscribe = (browser: Browser, endpoint: string, preview = true) => browser.post('/api/push/subscribe', { subscription: { endpoint, keys: KEYS }, preview })
  const pushesTo = (endpoint: string) => server.pushes.filter((p) => p.endpoint === endpoint)

  it('gives the signing key, the same each time, only when signed in', async () => {
    expect((await new Browser(server.url).get('/api/push/key')).status).toBe(401)
    const browser = await newUser('push-key@example.com')
    const first = (await browser.get('/api/push/key')).json.key
    expect(first).toMatch(/^[A-Za-z0-9_-]{80,}$/)
    expect((await browser.get('/api/push/key')).json.key).toBe(first)
    // Kept in the database, the private half sealed.
    const kept = await server.database.col.settings.findOne({ _id: 'vapid' })
    expect(kept?.publicKey).toBe(first)
    expect(kept?.privateKey).toMatch(/^v1:/)
  })

  it('notifies each device of a new message, and stops when told', async () => {
    const browser = await newUser('push-live@example.com')
    expect((await subscribe(browser, fcm('phone'))).status).toBe(200)
    expect((await subscribe(browser, fcm('laptop'), false)).status).toBe(200)
    expect((await new Browser(server.url).post('/api/push/subscribe', { subscription: { endpoint: fcm('x'), keys: KEYS } })).status).toBe(401)
    expect((await subscribe(browser, 'https://attacker.example/hook')).status).toBe(400)

    // The device's keys are kept sealed.
    const stored = await server.database.col.push.findOne({ endpoint: fcm('phone') })
    expect(stored?.keys).toMatch(/^v1:/)

    server.guffshuff.write(ASHA, 'Hi!')
    expect((await browser.post('/api/link/guffshuff', { username: 'aarav', password: server.guffshuff.state.password })).status).toBe(200)
    server.guffshuff.write(ASHA, 'Lunch at 1?')
    await waitFor(() => expect(pushesTo(fcm('phone')).map((p) => p.payload.body)).toContain('Lunch at 1?'), { timeout: 8000 })
    expect(pushesTo(fcm('phone')).at(-1)?.payload).toMatchObject({ title: 'Asha Rao · Guffshuff', url: `/chat/${encodeURIComponent(`gs:${ASHA}`)}` })
    expect(pushesTo(fcm('phone')).at(-1)?.keys).toEqual(KEYS)
    // Previews off: that a message came, not who or what.
    await waitFor(() => expect(pushesTo(fcm('laptop')).at(-1)?.payload).toMatchObject({ title: 'Sytext', body: 'New message on Guffshuff' }))

    // My own reply notifies no one.
    const before = server.pushes.length
    await browser.post(`/api/threads/${encodeURIComponent(`gs:${ASHA}`)}/messages`, { body: 'Yes!' })
    await new Promise((r) => setTimeout(r, 200))
    expect(server.pushes.length).toBe(before)

    // A test notification, on request.
    expect((await browser.post('/api/push/test', {})).json.sent).toBe(2)

    // Turned off on the laptop; the phone's uninstalled (its push service says it's gone).
    expect((await browser.post('/api/push/unsubscribe', { endpoint: fcm('laptop') })).status).toBe(200)
    server.gonePush.add(fcm('phone'))
    expect((await browser.post('/api/push/test', {})).json.sent).toBe(0)
    expect(await server.database.col.push.countDocuments({ endpoint: { $in: [fcm('phone'), fcm('laptop')] } })).toBe(0)
  })

  it('keeps a renewed subscription’s settings', async () => {
    const browser = await newUser('push-renew@example.com')
    await subscribe(browser, fcm('before'), false)
    expect((await browser.post('/api/push/subscribe', { subscription: { endpoint: fcm('after'), keys: KEYS }, replaces: fcm('before') })).status).toBe(200)
    expect(await server.database.col.push.countDocuments({ endpoint: fcm('before') })).toBe(0)
    expect((await server.database.col.push.findOne({ endpoint: fcm('after') }))?.preview).toBe(false)
  })

  it('gives a device to whoever signed in on it last', async () => {
    const first = await newUser('push-first@example.com')
    const second = await newUser('push-second@example.com')
    await subscribe(first, fcm('shared'))
    await subscribe(second, fcm('shared'))
    expect((await first.post('/api/push/test', {})).json.sent).toBe(0)
    expect((await second.post('/api/push/test', {})).json.sent).toBe(1)
  })

  it('forgets devices signed out by a new password, and all of them with the account', async () => {
    const browser = await newUser('push-reset@example.com')
    await subscribe(browser, fcm('old-phone'))
    expect((await browser.post('/api/me/password', { current: 'long enough', password: 'a newer password' })).status).toBe(200)
    expect((await browser.post('/api/push/test', {})).json.sent).toBe(0)
    expect(await server.database.col.push.countDocuments({ endpoint: fcm('old-phone') })).toBe(0)

    // The open app checks in again with its new session.
    await subscribe(browser, fcm('old-phone'))
    expect((await browser.post('/api/push/test', {})).json.sent).toBe(1)
    expect((await browser.request('DELETE', '/api/me', { current: 'a newer password' })).status).toBe(200)
    expect(await server.database.col.push.countDocuments({ endpoint: fcm('old-phone') })).toBe(0)
  })

  it('vouches for the Android app', async () => {
    const res = await new Browser(server.url).get('/.well-known/assetlinks.json')
    expect(res.status).toBe(200)
    expect(res.json[0]).toMatchObject({
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: 'com.sytext.app' },
    })
    expect(res.json[0].target.sha256_cert_fingerprints).toContain('AA:'.repeat(31) + 'AA')
  })
})
