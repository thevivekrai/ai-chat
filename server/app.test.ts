import { MongoClient, ObjectId } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectDatabase } from './db.ts'
import {
  Browser,
  mediaMessage,
  MAX_TEST_FILE_BYTES,
  PIXEL,
  startTestServer,
  TEST_MONGODB_URI,
  waitFor,
  waMedia,
  type FakeWaSocket,
  type TestServer,
} from './testing/helpers.ts'

const enc = encodeURIComponent
const byId = (messages: { id: string }[]) => Object.fromEntries(messages.map((m) => [m.id, m])) as Record<string, any>

describe.skipIf(!TEST_MONGODB_URI)('a database shared with another app', () => {
  it('is explained, rather than failing with MongoDB\'s error', async () => {
    const name = `sytext_shared_${Date.now()}`
    const other = await new MongoClient(TEST_MONGODB_URI!).connect()
    try {
      // Another app's "users", with its own index on email.
      await other.db(name).collection('users').createIndex({ email: 1 })
      await expect(connectDatabase(TEST_MONGODB_URI!, name)).rejects.toThrow(
        new RegExp(`The database "${name}" already has a "users" collection, set up by another app\\. Give Sytext a database of its own`),
      )
    } finally {
      await other.db(name).dropDatabase()
      await other.close()
    }
  })
})

describe.skipIf(!TEST_MONGODB_URI)('server (with MongoDB)', () => {
  let server: TestServer

  beforeAll(async () => {
    server = await startTestServer()
  })

  afterAll(async () => {
    await server?.close()
  })

  const newUser = async (email: string) => {
    const browser = new Browser(server.url)
    const res = await browser.post('/api/auth/register', { name: 'Aarav', email, password: 'long enough' })
    expect(res.status).toBe(200)
    return browser
  }

  /** Links WhatsApp the way a phone would, and returns the connected socket. */
  async function linkWhatsApp(browser: Browser): Promise<FakeWaSocket> {
    await browser.post('/api/link/whatsapp', { phone: '+91 98765 43210' })
    const socket = server.sockets.at(-1)!
    // The code was entered: WhatsApp registers the device, and its keys are saved.
    socket.authState.creds.registered = true
    socket.emit('creds.update', {})
    socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: Object.assign(new Error('restart'), { output: { statusCode: 515 } }), date: new Date() },
    })
    const linked = await waitFor(() => {
      const s = server.sockets.at(-1)!
      if (s === socket) throw new Error('Not reconnected yet')
      return s
    })
    linked.user = { id: '919876543210:4@s.whatsapp.net' }
    linked.emit('connection.update', { connection: 'open' })
    await waitFor(async () => expect((await browser.get('/api/accounts')).json.accounts[0]?.status).toBe('connected'))
    return linked
  }

  describe('sign-in', () => {
    it('registers, keeps the session in an httpOnly cookie, and signs out', async () => {
      const browser = new Browser(server.url)
      const res = await browser.post('/api/auth/register', { name: 'Aarav', email: 'Aarav@Example.com', password: 'long enough' })
      expect(res.status).toBe(200)
      expect(res.json.user).toMatchObject({ email: 'aarav@example.com', name: 'Aarav', hasPassword: true, google: false })
      expect(res.headers.get('set-cookie')).toMatch(/tidings_session=.+; Path=\/; Expires=.+; HttpOnly; SameSite=Lax/)

      expect((await browser.get('/api/auth/me')).json.user.email).toBe('aarav@example.com')
      await browser.post('/api/auth/logout')
      expect((await browser.get('/api/auth/me')).status).toBe(401)
    })

    it('signs in with the right password only', async () => {
      await newUser('meera@example.com')
      const browser = new Browser(server.url)
      expect((await browser.post('/api/auth/login', { email: 'meera@example.com', password: 'wrong password' })).status).toBe(401)
      expect((await browser.post('/api/auth/login', { email: 'nobody@example.com', password: 'long enough' })).status).toBe(401)
      const ok = await browser.post('/api/auth/login', { email: 'MEERA@example.com', password: 'long enough' })
      expect(ok.status).toBe(200)
      expect((await browser.get('/api/auth/me')).json.user.email).toBe('meera@example.com')
    })

    it('rejects bad sign-ups', async () => {
      const browser = new Browser(server.url)
      expect((await browser.post('/api/auth/register', { name: 'A', email: 'not-an-email', password: 'long enough' })).status).toBe(400)
      expect((await browser.post('/api/auth/register', { name: 'A', email: 'a@b.co', password: 'short' })).status).toBe(400)
      await newUser('taken@example.com')
      const again = await browser.post('/api/auth/register', { name: 'A', email: 'taken@example.com', password: 'long enough' })
      expect(again.status).toBe(409)
    })

    it('only accepts JSON for changes, so other sites cannot post forms', async () => {
      const browser = new Browser(server.url)
      const res = await browser.request('POST', '/api/auth/login', 'email=a@b.co&password=x', { 'Content-Type': 'application/x-www-form-urlencoded' })
      expect(res.status).toBe(415)
    })

    it('ignores forged session cookies', async () => {
      const browser = new Browser(server.url)
      browser.cookie = 'tidings_session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI2NjUwYzBmZmVlMDAwMDAwMDAwMGFiY2QifQ.c2lnbmF0dXJl'
      expect((await browser.get('/api/inbox')).status).toBe(401)
    })

    it('signs in with Google, creating the account once', async () => {
      const browser = new Browser(server.url)
      const credential = await server.google.idToken({ sub: 'google-1', email: 'divya@example.com', name: 'Divya' })
      const first = await browser.post('/api/auth/google', { credential })
      expect(first.status).toBe(200)
      expect(first.json.user).toMatchObject({ email: 'divya@example.com', name: 'Divya', google: true, hasPassword: false })

      const second = await new Browser(server.url).post('/api/auth/google', { credential })
      expect(second.json.user.id).toBe(first.json.user.id)
      const password = await new Browser(server.url).post('/api/auth/login', { email: 'divya@example.com', password: 'whatever!' })
      expect(password.status).toBe(400)
      expect(password.json.error).toMatch(/Google/)
    })

    it('rejects Google tokens with an unverified email', async () => {
      const credential = await server.google.idToken({ sub: 'google-2', email: 'x@example.com', email_verified: false })
      expect((await new Browser(server.url).post('/api/auth/google', { credential })).status).toBe(401)
    })

    it('links Google to an account with the same email, ending its password and sessions', async () => {
      // Someone signs up with an address before its owner does…
      const squatter = await newUser('owner@example.com')
      expect((await squatter.get('/api/auth/me')).status).toBe(200)
      // …until the owner signs in with Google.
      await new Promise((r) => setTimeout(r, 1100)) // Session times are in whole seconds.
      const owner = new Browser(server.url)
      const credential = await server.google.idToken({ sub: 'google-3', email: 'owner@example.com' })
      const res = await owner.post('/api/auth/google', { credential })
      expect(res.json).toMatchObject({ passwordRemoved: true, user: { google: true, hasPassword: false } })

      expect((await squatter.get('/api/auth/me')).status).toBe(401)
      expect((await new Browser(server.url).post('/api/auth/login', { email: 'owner@example.com', password: 'long enough' })).status).toBe(400)
      expect((await owner.get('/api/auth/me')).status).toBe(200)

      // The owner can set a password of their own.
      expect((await owner.post('/api/me/password', { password: 'brand new pw' })).status).toBe(200)
      const login = await new Browser(server.url).post('/api/auth/login', { email: 'owner@example.com', password: 'brand new pw' })
      expect(login.status).toBe(200)
    })

    it('gives a recovery key on sign-up that resets a forgotten password, once', async () => {
      const first = new Browser(server.url)
      const signUp = await first.post('/api/auth/register', { name: 'Kabir', email: 'kabir@example.com', password: 'long enough' })
      const key: string = signUp.json.recoveryKey
      expect(key).toMatch(/^([0-9A-Z]{5}-){4}[0-9A-Z]{5}$/)
      expect(signUp.json.user.recoveryKeyCreatedAt).toEqual(expect.any(String))
      // It's shown once: never again.
      expect(JSON.stringify((await first.get('/api/auth/me')).json)).not.toContain(key)

      const recover = (body: Record<string, string>) => new Browser(server.url).post('/api/auth/recover', body)
      expect((await recover({ email: 'kabir@example.com', recoveryKey: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', password: 'new password' })).status).toBe(401)
      const otherEmail = await recover({ email: 'nobody@example.com', recoveryKey: key, password: 'new password' })
      expect(otherEmail.status).toBe(401)
      expect(otherEmail.json.error).toMatch(/don't match/)
      expect((await recover({ email: 'kabir@example.com', recoveryKey: key, password: 'short' })).status).toBe(400)

      await new Promise((r) => setTimeout(r, 1100)) // Session times are in whole seconds.
      const second = new Browser(server.url)
      // Typed loosely: lower case, spaces instead of dashes.
      const reset = await second.post('/api/auth/recover', {
        email: 'Kabir@Example.com',
        recoveryKey: key.toLowerCase().replace(/-/g, ' '),
        password: 'new password',
      })
      expect(reset.status).toBe(200)
      expect(reset.json.recoveryKey).toMatch(/^([0-9A-Z]{5}-){4}[0-9A-Z]{5}$/)
      expect(reset.json.recoveryKey).not.toBe(key)
      expect((await second.get('/api/auth/me')).json.user.email).toBe('kabir@example.com')

      // The old password, the old key and the other sessions all stop working.
      expect((await first.get('/api/auth/me')).status).toBe(401)
      expect((await new Browser(server.url).post('/api/auth/login', { email: 'kabir@example.com', password: 'long enough' })).status).toBe(401)
      expect((await new Browser(server.url).post('/api/auth/login', { email: 'kabir@example.com', password: 'new password' })).status).toBe(200)
      expect((await recover({ email: 'kabir@example.com', recoveryKey: key, password: 'another one' })).status).toBe(401)
      expect((await recover({ email: 'kabir@example.com', recoveryKey: reset.json.recoveryKey, password: 'another one' })).status).toBe(200)
    })

    it('makes a new recovery key in Settings, with the current password', async () => {
      const browser = new Browser(server.url)
      const signUp = await browser.post('/api/auth/register', { name: 'Zoya', email: 'zoya@example.com', password: 'long enough' })
      expect((await browser.post('/api/me/recovery-key', { current: 'wrong password' })).status).toBe(400)
      const fresh = await browser.post('/api/me/recovery-key', { current: 'long enough' })
      expect(fresh.status).toBe(200)
      expect(fresh.json.recoveryKey).not.toBe(signUp.json.recoveryKey)

      const recover = (recoveryKey: string) =>
        new Browser(server.url).post('/api/auth/recover', { email: 'zoya@example.com', recoveryKey, password: 'new password' })
      expect((await recover(signUp.json.recoveryKey)).status).toBe(401)
      expect((await recover(fresh.json.recoveryKey)).status).toBe(200)
    })

    it('drops the recovery key when Google takes over an account made with the same email', async () => {
      const squatter = new Browser(server.url)
      const signUp = await squatter.post('/api/auth/register', { name: 'X', email: 'real-owner@example.com', password: 'long enough' })
      const credential = await server.google.idToken({ sub: 'google-4', email: 'real-owner@example.com' })
      const owner = await new Browser(server.url).post('/api/auth/google', { credential })
      expect(owner.json.user.recoveryKeyCreatedAt).toBeUndefined()
      const recover = await new Browser(server.url).post('/api/auth/recover', {
        email: 'real-owner@example.com',
        recoveryKey: signUp.json.recoveryKey,
        password: 'taken back',
      })
      expect(recover.status).toBe(401)
    })

    it('reports which features are switched on', async () => {
      const res = await new Browser(server.url).get('/api/config')
      expect(res.json).toEqual({
        googleClientId: 'test-client.apps.googleusercontent.com',
        whatsapp: true,
        telegram: true,
        uploads: false,
        database: true,
        storage: 'database',
      })
    })
  })

  describe('Telegram', () => {
    it('links with phone, code and password, then syncs, sends and unlinks', async () => {
      const tg = server.telegram
      const browser = await newUser('tg@example.com')
      const events = await browser.events()

      // A wrong number and a wrong code are explained.
      expect((await browser.post('/api/link/telegram/code', { phone: '+1 000 000 0000' })).json.error).toMatch(/doesn't recognise/)
      const code = await browser.post('/api/link/telegram/code', { phone: '+91 98765 43210' })
      expect(code.json).toEqual({ via: 'app' })
      expect(tg.state.codesSent).toContain('+919876543210')
      expect((await browser.get('/api/accounts')).json.accounts).toEqual([
        { network: 'telegram', status: 'linking', step: 'code', label: '+919876543210', detail: 'Enter the code Telegram sent to your Telegram app.' },
      ])
      expect((await browser.post('/api/link/telegram/verify', { code: '11111' })).json.error).toMatch(/isn't right/)

      // Two-step verification.
      const verify = await browser.post('/api/link/telegram/verify', { code: '12 345' })
      expect(verify.json).toEqual({ status: 'password', hint: 'first pet' })
      expect((await browser.post('/api/link/telegram/password', { password: 'nope' })).status).toBe(400)
      expect((await browser.post('/api/link/telegram/password', { password: 'hunter2' })).json).toEqual({ status: 'connected' })

      // Recent chats are copied in; broadcast channels are left out.
      await events.next((e) => e.type === 'reloaded')
      const inbox = (await browser.get('/api/inbox')).json
      expect(inbox.accounts).toEqual([{ network: 'telegram', status: 'connected', label: '@aarav' }])
      expect(inbox.threads.map((t: { id: string }) => t.id)).toEqual(['tga:5001', 'tga:-100777'])
      expect(inbox.threads[0]).toMatchObject({ title: 'Asha Rao', kind: 'direct', network: 'telegram', unreadCount: 1, participantIds: ['tga:5001'] })
      expect(inbox.threads[1]).toMatchObject({ title: 'Trek crew', kind: 'group', participantIds: ['tga:6002'] })
      expect(inbox.contacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'tga:5001', name: 'Asha Rao', network: 'telegram', handle: '@asha' }),
          expect.objectContaining({ id: 'tga:6002', name: 'Kabir', network: 'telegram', handle: '@kabir' }),
        ]),
      )
      const byId = Object.fromEntries(inbox.messages.map((m: { id: string }) => [m.id, m]))
      expect(byId['tga:5001:12']).toMatchObject({ senderId: 'tga:5001', body: 'Are we still on for Saturday?' })
      expect(byId['tga:5001:11']).toMatchObject({ senderId: 'me', status: 'read' })
      expect(byId['tga:-100777:7']).toMatchObject({ senderId: 'tga:6002', attachments: [{ kind: 'image', name: 'Photo' }] })

      // Live messages, edits and read receipts arrive as events.
      const now = Math.floor(Date.now() / 1000)
      tg.emit({ type: 'message', message: { id: 13, chat: tg.asha, out: false, text: 'Bring the tent?', date: now } })
      await events.next((e) => e.type === 'message.created' && e.message.id === 'tga:5001:13')
      await events.next((e) => e.type === 'thread.updated' && e.thread.id === 'tga:5001' && e.thread.unreadCount === 2)
      tg.emit({ type: 'edited', message: { id: 13, chat: tg.asha, out: false, text: 'Bring the big tent?', date: now } })
      await events.next((e) => e.type === 'message.updated' && e.message.body === 'Bring the big tent?')

      // Sending, then the other side reading it.
      const sent = await browser.post(`/api/threads/${encodeURIComponent('tga:5001')}/messages`, { body: 'Yes, packing it now' })
      expect(sent.json.message).toMatchObject({ id: 'tga:5001:101', senderId: 'me', body: 'Yes, packing it now', status: 'sent' })
      expect(tg.state.sent).toEqual([{ chatId: '5001', text: 'Yes, packing it now' }])
      tg.emit({ type: 'read-outbox', chatId: '5001', maxId: 101 })
      await events.next((e) => e.type === 'message.updated' && e.message.id === 'tga:5001:101' && e.message.status === 'read')

      // Reading the chat here marks it read in Telegram too.
      expect((await browser.post(`/api/threads/${encodeURIComponent('tga:5001')}/read`)).status).toBe(200)
      expect(tg.state.read).toEqual([{ chatId: '5001', maxId: 13 }])
      expect((await browser.get('/api/inbox')).json.threads[0].unreadCount).toBe(0)
      // Read on the phone: the count follows.
      tg.emit({ type: 'read', chatId: '-100777', unreadCount: 0 })
      await events.next((e) => e.type === 'thread.updated' && e.thread.id === 'tga:-100777')

      // Nothing readable is stored: names, text and the session are sealed.
      const raw = JSON.stringify(await server.database.db.collection('messages').find().toArray())
      expect(raw).not.toContain('tent')
      const account = await server.database.col.accounts.findOne({ network: 'telegram' })
      expect(account?.session).toMatch(/^v1:/)
      expect(account?.session).not.toContain('tg-session-secret')

      // Another user sees none of it.
      const stranger = await newUser('stranger@example.com')
      expect((await stranger.get('/api/inbox')).json.threads).toEqual([])
      expect((await stranger.post(`/api/threads/${encodeURIComponent('tga:5001')}/messages`, { body: 'hi' })).status).toBe(404)

      // After a restart the link carries on, and catches up.
      events.close()
      await server.restart()
      expect(tg.state.sessions.at(-1)).toBe('tg-session-secret')
      expect((await browser.get('/api/accounts')).json.accounts[0]).toMatchObject({ status: 'connected' })
      const again = await browser.post(`/api/threads/${encodeURIComponent('tga:5001')}/messages`, { body: 'Back online' })
      expect(again.status).toBe(200)

      // Unlinking ends the session in Telegram and forgets the chats.
      expect((await browser.delete('/api/link/telegram')).status).toBe(200)
      expect(tg.state.loggedOut).toBe(1)
      const after = (await browser.get('/api/inbox')).json
      expect(after.threads).toEqual([])
      expect(after.accounts).toEqual([])
      expect(await server.database.col.messages.countDocuments({ id: /^tga:/ })).toBe(0)
    })

    it('brings in replies, reactions, pictures and older messages; sends replies, reactions and typing', async () => {
      const tg = server.telegram
      tg.state.needsPassword = false
      const browser = await newUser('tg-extras@example.com')
      await browser.post('/api/link/telegram/code', { phone: '+91 90000 00003' })
      expect((await browser.post('/api/link/telegram/verify', { code: '12345' })).json).toEqual({ status: 'connected' })

      // Quotes, reactions and pictures come in with the first sync.
      const inbox = await waitFor(async () => {
        const json = (await browser.get('/api/inbox')).json
        if (!json.contacts.find((c: { id: string; avatarUrl?: string }) => c.id === 'tga:5001')?.avatarUrl) throw new Error('No picture yet')
        return json
      })
      const messages = byId(inbox.messages)
      expect(messages['tga:5001:12'].replyTo).toEqual({ id: 'tga:5001:11', senderId: 'me', body: 'Yes! See you at 9' })
      expect(messages['tga:5001:11'].reactions).toEqual([{ emoji: '👍', count: 1, mine: false }])

      // Pictures are served to their owner only.
      const { avatarUrl } = inbox.contacts.find((c: { id: string }) => c.id === 'tga:5001')
      expect(avatarUrl).toMatch(/^\/api\/avatars\/tga%3A5001\?v=\w+$/)
      const picture = await fetch(server.url + avatarUrl, { headers: { Cookie: browser.cookie } })
      expect(picture.headers.get('content-type')).toBe('image/jpeg')
      expect(Buffer.from(await picture.arrayBuffer())).toEqual(PIXEL)
      expect((await fetch(server.url + avatarUrl)).status).toBe(401)
      const stranger = await newUser('tg-extras-stranger@example.com')
      expect((await fetch(server.url + avatarUrl, { headers: { Cookie: stranger.cookie } })).status).toBe(404)

      // Earlier messages, fetched from Telegram.
      const older = await browser.get(`/api/threads/${enc('tga:5001')}/messages?before=${enc('tga:5001:11')}`)
      expect(older.json.messages.map((m: { body: string }) => m.body)).toEqual(['Rajmachi, the long one', 'Which trail are we doing?'])
      expect(older.json.hasMore).toBe(false)

      // Replying quotes the message.
      const events = await browser.events()
      const reply = await browser.post(`/api/threads/${enc('tga:5001')}/messages`, { body: 'Yes, Saturday', replyToId: 'tga:5001:12' })
      expect(reply.json.message.replyTo).toEqual({ id: 'tga:5001:12', senderId: 'tga:5001', body: 'Are we still on for Saturday?' })
      expect(tg.state.sent.at(-1)).toEqual({ chatId: '5001', text: 'Yes, Saturday', replyToId: 12 })

      // Reacting, and what Telegram doesn't allow.
      const react = await browser.post(`/api/threads/${enc('tga:5001')}/reactions`, { messageId: 'tga:5001:12', emoji: '❤️' })
      expect(react.json.message.reactions).toEqual([{ emoji: '❤️', count: 1, mine: true }])
      expect(tg.state.reactions.at(-1)).toEqual({ chatId: '5001', messageId: 12, emoji: '❤️' })
      const refused = await browser.post(`/api/threads/${enc('tga:5001')}/reactions`, { messageId: 'tga:5001:12', emoji: '🦄' })
      expect(refused.json.error).toMatch(/doesn't allow/)
      const notEmoji = await browser.post(`/api/threads/${enc('tga:5001')}/reactions`, { messageId: 'tga:5001:12', emoji: 'definitely not an emoji' })
      expect(notEmoji.status).toBe(400)
      tg.emit({ type: 'reactions', chatId: '5001', messageId: 11, reactions: [{ emoji: '🔥', count: 2, mine: false }] })
      await events.next((e) => e.type === 'message.updated' && e.message.id === 'tga:5001:11' && e.message.reactions?.[0]?.emoji === '🔥')

      // Typing, both ways.
      await browser.post(`/api/threads/${enc('tga:5001')}/typing`, { typing: true })
      expect(tg.state.typing.at(-1)).toEqual({ chatId: '5001', typing: true })
      tg.emit({ type: 'typing', chatId: '5001', senderId: '5001', active: true })
      await events.next((e) => e.type === 'typing' && e.threadId === 'tga:5001' && e.senderId === 'tga:5001' && e.active)
      events.close()

      // Messages the server no longer keeps (it keeps only the latest of each chat) still work,
      // from what the device knows of them.
      await server.database.col.messages.deleteOne({ id: 'tga:5001:10' })
      const hint = { id: 'tga:5001:10', senderId: 'tga:5001', sentAt: new Date().toISOString(), body: 'Which trail are we doing?' }
      const lateReact = await browser.post(`/api/threads/${enc('tga:5001')}/reactions`, { messageId: hint.id, emoji: '👍', message: hint })
      expect(lateReact.json).toEqual({ message: null })
      expect(tg.state.reactions.at(-1)).toEqual({ chatId: '5001', messageId: 10, emoji: '👍' })
      const lateReply = await browser.post(`/api/threads/${enc('tga:5001')}/messages`, { body: 'Rajmachi', replyToId: hint.id, replyTo: hint })
      expect(lateReply.json.message.replyTo).toEqual({ id: hint.id, senderId: hint.senderId, body: hint.body })
      expect(tg.state.sent.at(-1)).toEqual({ chatId: '5001', text: 'Rajmachi', replyToId: 10 })
      const beforeGone = await browser.get(`/api/threads/${enc('tga:5001')}/messages?before=${enc(hint.id)}`)
      expect(beforeGone.json.messages.map((m: { body: string }) => m.body)).toEqual(['Rajmachi, the long one'])

      // Only that there is a picture is stored; after a restart it's downloaded from Telegram again.
      const userId = new ObjectId((await browser.get('/api/auth/me')).json.user.id)
      const record = await server.database.col.avatars.findOne({ userId, id: 'tga:5001' })
      expect(record).toMatchObject({ version: expect.any(String) })
      expect(record).not.toHaveProperty('data')
      await server.restart()
      await waitFor(() => expect(server.current().telegram.isConnected(userId)).toBe(true))
      const again = await fetch(server.url + avatarUrl, { headers: { Cookie: browser.cookie } })
      expect(again.status).toBe(200)
      expect(Buffer.from(await again.arrayBuffer())).toEqual(PIXEL)

      await browser.delete('/api/link/telegram')
      expect(await server.database.col.avatars.countDocuments({ userId })).toBe(0)
    })

    it('links by QR code, then the two-step password', async () => {
      const tg = server.telegram
      tg.state.needsPassword = true
      const browser = await newUser('tg-qr@example.com')
      const events = await browser.events()

      const qr = await browser.post('/api/link/telegram/qr')
      expect(qr.json.qr).toMatch(/^data:image\/png;base64,/)
      expect((await browser.get('/api/accounts')).json.accounts[0]).toMatchObject({ status: 'linking', step: 'qr' })

      tg.state.scanQr()
      await events.next((e) => e.type === 'account.updated' && e.account.step === 'password')
      expect((await browser.get('/api/accounts')).json.accounts[0]).toMatchObject({ step: 'password', hint: 'first pet' })
      expect((await browser.post('/api/link/telegram/password', { password: 'nope' })).status).toBe(400)
      expect((await browser.post('/api/link/telegram/password', { password: 'hunter2' })).json).toEqual({ status: 'connected' })
      await events.next((e) => e.type === 'reloaded')
      events.close()
      await browser.delete('/api/link/telegram')

      // Cancelling a QR sign-in midway leaves nothing behind.
      await browser.post('/api/link/telegram/qr')
      await browser.delete('/api/link/telegram')
      expect((await browser.get('/api/accounts')).json.accounts).toEqual([])
    })

    it('notices a session ended from Telegram when restarting', async () => {
      const tg = server.telegram
      tg.state.needsPassword = false
      const browser = await newUser('tg2@example.com')
      await browser.post('/api/link/telegram/code', { phone: '+91 90000 00001' })
      expect((await browser.post('/api/link/telegram/verify', { code: '12345' })).json).toEqual({ status: 'connected' })
      await waitFor(async () => expect((await browser.get('/api/inbox')).json.threads.length).toBeGreaterThan(0))

      tg.state.revoked = true
      await server.restart()
      const accounts = (await browser.get('/api/accounts')).json.accounts
      expect(accounts[0]).toMatchObject({ network: 'telegram', status: 'disconnected' })
      expect(accounts[0].detail).toMatch(/Settings → Devices/)
      tg.state.revoked = false
      await browser.delete('/api/link/telegram')
    })

    it('catches up on messages missed while the connection was down', async () => {
      const tg = server.telegram
      tg.state.needsPassword = false
      const browser = await newUser('tg-catchup@example.com')
      await browser.post('/api/link/telegram/code', { phone: '+91 90000 00004' })
      await browser.post('/api/link/telegram/verify', { code: '12345' })
      await waitFor(async () => expect(byId((await browser.get('/api/inbox')).json.messages)['tga:5001:12']).toBeDefined())
      const events = await browser.events()

      // A message Telegram never told the server about: the regular check finds it.
      tg.ashaMessages.unshift({ id: 15, chat: tg.asha, out: false, text: 'Missed this one?', date: Math.floor(Date.now() / 1000) })
      try {
        await server.current().telegram.checkAll()
        await events.next((e) => e.type === 'reloaded')
        expect(byId((await browser.get('/api/inbox')).json.messages)['tga:5001:15']).toMatchObject({ body: 'Missed this one?' })
      } finally {
        tg.ashaMessages.shift()
      }
      // Nothing new: nothing to tell the browser.
      const before = events.received.length
      await server.current().telegram.checkAll()
      expect(events.received.slice(before).some((e) => e.type === 'reloaded')).toBe(false)

      events.close()
      await browser.delete('/api/link/telegram')
    })
  })

  describe('WhatsApp', () => {
    it('links with a pairing code, syncs history, receives, sends and unlinks', async () => {
      const browser = await newUser('wa@example.com')
      const events = await browser.events()

      const link = await browser.post('/api/link/whatsapp', { phone: '+91 98765 43210' })
      expect(link.json).toEqual({ code: 'ABCD-1234' })
      const socket = server.sockets.at(-1)!
      expect(socket.pairingPhone).toBe('919876543210')
      expect((await browser.get('/api/accounts')).json.accounts[0]).toMatchObject({ network: 'whatsapp', status: 'linking' })

      // The user types the code on their phone; WhatsApp asks for a restart, then the link opens.
      socket.authState.creds.registered = true
      socket.emit('creds.update', {})
      socket.emit('connection.update', { connection: 'close', lastDisconnect: { error: Object.assign(new Error('restart'), { output: { statusCode: 515 } }), date: new Date() } })
      const reopened = await waitFor(() => {
        const s = server.sockets.at(-1)!
        if (s === socket) throw new Error('not reconnected yet')
        return s
      })
      reopened.user = { id: '919876543210:4@s.whatsapp.net' }
      reopened.emit('connection.update', { connection: 'open' })
      await events.next((e) => e.type === 'account.updated' && e.account.status === 'connected')
      expect((await browser.get('/api/accounts')).json.accounts[0]).toMatchObject({ label: '+919876543210' })

      // History arrives in a batch.
      const ts = Math.floor(Date.now() / 1000)
      reopened.emit('messaging-history.set', {
        chats: [{ id: '919812345678@s.whatsapp.net', unreadCount: 1 }, { id: '120363000000@g.us', name: 'Family' }],
        contacts: [{ id: '919812345678@s.whatsapp.net', name: 'Ravi Kumar' }],
        messages: [
          { key: { remoteJid: '919812345678@s.whatsapp.net', fromMe: false, id: 'M1' }, message: { conversation: 'Did the parcel arrive?' }, messageTimestamp: ts - 50 },
          { key: { remoteJid: '919812345678@s.whatsapp.net', fromMe: true, id: 'M0' }, message: { conversation: 'Sent it Monday' }, messageTimestamp: ts - 100, status: 4 },
          {
            key: { remoteJid: '120363000000@g.us', fromMe: false, id: 'G1', participant: '919800000001@s.whatsapp.net' },
            message: { extendedTextMessage: { text: 'Dinner at 8' } },
            messageTimestamp: ts - 30,
            pushName: 'Maa',
          },
          { key: { remoteJid: 'status@broadcast', fromMe: false, id: 'S1' }, message: { conversation: 'status update' }, messageTimestamp: ts },
        ],
        isLatest: true,
        syncType: 0,
      } as never)
      await events.next((e) => e.type === 'reloaded')
      const inbox = (await browser.get('/api/inbox')).json
      const threads = Object.fromEntries(inbox.threads.map((t: { id: string }) => [t.id, t]))
      expect(Object.keys(threads).sort()).toEqual(['wa:120363000000@g.us', 'wa:919812345678@s.whatsapp.net'])
      expect(threads['wa:919812345678@s.whatsapp.net']).toMatchObject({ title: 'Ravi Kumar', kind: 'direct', unreadCount: 1 })
      expect(threads['wa:120363000000@g.us']).toMatchObject({ title: 'Family', kind: 'group', participantIds: ['wa:919800000001@s.whatsapp.net'] })
      const byId = Object.fromEntries(inbox.messages.map((m: { id: string }) => [m.id, m]))
      expect(byId['wa:919812345678@s.whatsapp.net:M0']).toMatchObject({ senderId: 'me', status: 'read' })
      expect(byId['wa:120363000000@g.us:G1']).toMatchObject({ senderId: 'wa:919800000001@s.whatsapp.net', body: 'Dinner at 8' })

      // A live message.
      reopened.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: '919812345678@s.whatsapp.net', fromMe: false, id: 'M2' }, message: { conversation: 'Call me when free' }, messageTimestamp: ts }],
      } as never)
      await events.next((e) => e.type === 'message.created' && e.message.body === 'Call me when free')
      await events.next((e) => e.type === 'thread.updated' && e.thread.unreadCount === 2)

      // Sending and reading.
      const threadId = encodeURIComponent('wa:919812345678@s.whatsapp.net')
      const sent = await browser.post(`/api/threads/${threadId}/messages`, { body: 'Calling in 5' })
      expect(sent.json.message).toMatchObject({ id: 'wa:919812345678@s.whatsapp.net:SENT1', status: 'sent' })
      expect(reopened.sent).toEqual([{ jid: '919812345678@s.whatsapp.net', text: 'Calling in 5' }])
      reopened.emit('messages.update', [{ key: { remoteJid: '919812345678@s.whatsapp.net', fromMe: true, id: 'SENT1' }, update: { status: 3 } }] as never)
      await events.next((e) => e.type === 'message.updated' && e.message.status === 'delivered')
      await browser.post(`/api/threads/${threadId}/read`)
      expect(reopened.read.map((k) => k.id).sort()).toEqual(['M1', 'M2'])

      // Unlinking logs the device out of WhatsApp and forgets everything.
      events.close()
      expect((await browser.delete('/api/link/whatsapp')).status).toBe(200)
      expect(reopened.loggedOut).toBe(true)
      expect((await browser.get('/api/inbox')).json).toMatchObject({ threads: [], accounts: [] })
      expect(await server.database.col.waAuth.countDocuments({})).toBe(0)
    })

    it('handles replies, reactions, typing, pictures and older messages', async () => {
      const RAVI = '919812345678@s.whatsapp.net'
      const thread = enc(`wa:${RAVI}`)
      const browser = await newUser('wa-extras@example.com')
      const socket = await linkWhatsApp(browser)
      const events = await browser.events()
      const ts = Math.floor(Date.now() / 1000)

      socket.emit('messaging-history.set', {
        chats: [{ id: RAVI }],
        contacts: [{ id: RAVI, name: 'Ravi Kumar' }],
        messages: [
          // Newest first, as WhatsApp sends them: the reaction and the reply come before what they point at.
          { key: { remoteJid: RAVI, fromMe: false, id: 'R1' }, message: { reactionMessage: { key: { remoteJid: RAVI, fromMe: true, id: 'M0' }, text: '🙏' } }, messageTimestamp: ts - 40 },
          {
            key: { remoteJid: RAVI, fromMe: false, id: 'M1' },
            message: {
              extendedTextMessage: {
                text: 'Got it, thanks!',
                contextInfo: { stanzaId: 'M0', participant: '919876543210@s.whatsapp.net', quotedMessage: { conversation: 'Sent it Monday' } },
              },
            },
            messageTimestamp: ts - 50,
          },
          { key: { remoteJid: RAVI, fromMe: true, id: 'M0' }, message: { conversation: 'Sent it Monday' }, messageTimestamp: ts - 100, status: 4 },
        ],
        isLatest: true,
        syncType: 0,
      } as never)
      await events.next((e) => e.type === 'reloaded')

      const inbox = await waitFor(async () => {
        const json = (await browser.get('/api/inbox')).json
        if (!json.contacts.find((c: { id: string; avatarUrl?: string }) => c.id === `wa:${RAVI}`)?.avatarUrl) throw new Error('No picture yet')
        return json
      })
      const messages = byId(inbox.messages)
      expect(messages[`wa:${RAVI}:M1`].replyTo).toEqual({ id: `wa:${RAVI}:M0`, senderId: 'me', body: 'Sent it Monday' })
      expect(messages[`wa:${RAVI}:M0`].reactions).toEqual([{ emoji: '🙏', count: 1, mine: false }])
      expect(messages[`wa:${RAVI}:R1`]).toBeUndefined()
      const { avatarUrl } = inbox.contacts.find((c: { id: string }) => c.id === `wa:${RAVI}`)
      const picture = await fetch(server.url + avatarUrl, { headers: { Cookie: browser.cookie } })
      expect(picture.headers.get('content-type')).toBe('image/png')

      // Replying and reacting.
      const reply = await browser.post(`/api/threads/${thread}/messages`, { body: 'Great!', replyToId: `wa:${RAVI}:M1` })
      expect(reply.json.message.replyTo).toEqual({ id: `wa:${RAVI}:M1`, senderId: `wa:${RAVI}`, body: 'Got it, thanks!' })
      expect(socket.sent.at(-1)).toEqual({ jid: RAVI, text: 'Great!', quotedId: 'M1' })
      const react = await browser.post(`/api/threads/${thread}/reactions`, { messageId: `wa:${RAVI}:M1`, emoji: '👍' })
      expect(react.json.message.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }])
      expect(socket.reactions.at(-1)).toEqual({ jid: RAVI, emoji: '👍', targetId: 'M1' })
      const unreact = await browser.post(`/api/threads/${thread}/reactions`, { messageId: `wa:${RAVI}:M1`, emoji: null })
      expect(unreact.json.message.reactions).toBeUndefined()
      expect(socket.reactions.at(-1)).toEqual({ jid: RAVI, emoji: '', targetId: 'M1' })

      // Ravi reacts to my reply, live.
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: RAVI, fromMe: false, id: 'R2' }, message: { reactionMessage: { key: { remoteJid: RAVI, fromMe: true, id: 'SENT1' }, text: '❤️' } }, messageTimestamp: ts }],
      } as never)
      await events.next((e) => e.type === 'message.updated' && e.message.id === `wa:${RAVI}:SENT1` && e.message.reactions?.[0]?.emoji === '❤️')

      // Typing, both ways.
      await browser.post(`/api/threads/${thread}/typing`, { typing: true })
      expect(socket.presence).toContainEqual({ type: 'composing', jid: RAVI })
      socket.emit('presence.update', { id: RAVI, presences: { [RAVI]: { lastKnownPresence: 'composing' } } })
      await events.next((e) => e.type === 'typing' && e.senderId === `wa:${RAVI}` && e.active)

      // Older messages: none stored, so the phone is asked; they arrive as new messages.
      const first = await browser.get(`/api/threads/${thread}/messages?before=${enc(`wa:${RAVI}:M0`)}`)
      expect(first.json).toEqual({ messages: [], hasMore: true })
      expect(socket.historyRequests).toEqual([{ count: 50, oldestId: 'M0' }])
      socket.emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [{ key: { remoteJid: RAVI, fromMe: false, id: 'OLD1' }, message: { conversation: 'Parcel booked?' }, messageTimestamp: ts - 86400 }],
        syncType: 6,
      } as never)
      await events.next((e) => e.type === 'message.created' && e.message.id === `wa:${RAVI}:OLD1`)
      const second = await browser.get(`/api/threads/${thread}/messages?before=${enc(`wa:${RAVI}:M0`)}`)
      expect(second.json.messages.map((m: { body: string }) => m.body)).toEqual(['Parcel booked?'])
      // Nothing older on the phone either: asking from the same message again ends it.
      const third = await browser.get(`/api/threads/${thread}/messages?before=${enc(`wa:${RAVI}:OLD1`)}`)
      expect(third.json).toEqual({ messages: [], hasMore: false })
      events.close()

      // Messages the server no longer keeps still work, from what the device knows of them.
      await server.database.col.messages.deleteOne({ id: `wa:${RAVI}:M1` })
      const hint = { id: `wa:${RAVI}:M1`, senderId: `wa:${RAVI}`, sentAt: new Date((ts - 50) * 1000).toISOString(), body: 'Got it, thanks!' }
      const lateReact = await browser.post(`/api/threads/${thread}/reactions`, { messageId: hint.id, emoji: '😂', message: hint })
      expect(lateReact.json).toEqual({ message: null })
      expect(socket.reactions.at(-1)).toEqual({ jid: RAVI, emoji: '😂', targetId: 'M1' })
      const lateReply = await browser.post(`/api/threads/${thread}/messages`, { body: 'Haha', replyToId: hint.id, replyTo: hint })
      expect(lateReply.json.message.replyTo).toEqual({ id: hint.id, senderId: hint.senderId, body: hint.body })
      expect(socket.sent.at(-1)).toEqual({ jid: RAVI, text: 'Haha', quotedId: 'M1' })
      // Without it (or with a hint for another message), there's nothing to go on.
      expect((await browser.post(`/api/threads/${thread}/reactions`, { messageId: hint.id, emoji: '😂' })).status).toBe(404)
      const mismatched = { ...hint, id: `wa:${RAVI}:OTHER` }
      expect((await browser.post(`/api/threads/${thread}/reactions`, { messageId: hint.id, emoji: '😂', message: mismatched })).status).toBe(404)
      // Paging back from a message only the device has asks the phone from it.
      const gone = { id: `wa:${RAVI}:GONE`, sentAt: new Date((ts - 90_000) * 1000).toISOString() }
      const fromDevice = await browser.get(`/api/threads/${thread}/messages?before=${enc(gone.id)}&senderId=me&sentAt=${enc(gone.sentAt)}`)
      expect(fromDevice.json).toEqual({ messages: [], hasMore: true })
      expect(socket.historyRequests.at(-1)).toEqual({ count: 50, oldestId: 'GONE' })

      // After a restart the picture is downloaded again from the link WhatsApp gave.
      await server.restart()
      const again = await fetch(server.url + avatarUrl, { headers: { Cookie: browser.cookie } })
      expect(again.status).toBe(200)
      expect(Buffer.from(await again.arrayBuffer())).toEqual(PIXEL)

      await browser.delete('/api/link/whatsapp')
    })

    it('names chats that WhatsApp sends under private ids, whatever order the names come in', async () => {
      const browser = await newUser('wa-names@example.com')
      const socket = await linkWhatsApp(browser)
      const userId = new ObjectId((await browser.get('/api/auth/me')).json.user.id)
      const events = await browser.events()
      const ts = Math.floor(Date.now() / 1000)
      const PRIYA = { lid: '11111@lid', pn: '919811111111@s.whatsapp.net' }
      const KABIR = { lid: '22222@lid', pn: '919822222222@s.whatsapp.net' }
      const inbox = async () => (await browser.get('/api/inbox')).json
      const titles = async () => Object.fromEntries((await inbox()).threads.map((t: { id: string; title: string }) => [t.id, t.title]))

      // History: the chat under her private id, her saved name under her number, and the pair.
      socket.emit('messaging-history.set', {
        chats: [{ id: PRIYA.lid }],
        contacts: [{ id: PRIYA.pn, name: 'Priya Shah' }],
        messages: [{ key: { remoteJid: PRIYA.lid, fromMe: false, id: 'P1' }, message: { conversation: 'Lunch?' }, messageTimestamp: ts - 60 }],
        lidPnMappings: [{ lid: PRIYA.lid, pn: PRIYA.pn }],
        isLatest: true,
        syncType: 0,
      } as never)
      await events.next((e) => e.type === 'reloaded')
      expect((await titles())[`wa:${PRIYA.pn}`]).toBe('Priya Shah')
      expect((await inbox()).contacts.find((c: { id: string }) => c.id === `wa:${PRIYA.pn}`)).toMatchObject({
        name: 'Priya Shah',
        handle: '+919811111111',
      })

      // A message from someone known only by private id: no name, no number yet.
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: KABIR.lid, fromMe: false, id: 'K1' }, message: { conversation: 'Hey' }, messageTimestamp: ts }],
      } as never)
      await events.next((e) => e.type === 'message.created' && e.message.id === `wa:${KABIR.lid}:K1`)
      expect((await titles())[`wa:${KABIR.lid}`]).toBe('WhatsApp contact')
      // Then his saved name (under his number) and the pair: the chat is renamed where it is.
      socket.emit('contacts.upsert', [{ id: KABIR.pn, name: 'Kabir' }])
      socket.emit('lid-mapping.update', { lid: KABIR.lid, pn: KABIR.pn })
      await waitFor(async () => expect((await titles())[`wa:${KABIR.lid}`]).toBe('Kabir'))
      // His next message, now with both ids, lands in the same chat rather than a new one.
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: KABIR.lid, remoteJidAlt: KABIR.pn, fromMe: false, id: 'K2' }, message: { conversation: 'You there?' }, messageTimestamp: ts + 1 }],
      } as never)
      await events.next((e) => e.type === 'message.created' && e.message.id === `wa:${KABIR.lid}:K2`)
      expect(await titles()).not.toHaveProperty(`wa:${KABIR.pn}`)
      events.close()

      // Chats stored as "WhatsApp" by an earlier version are named once the link reopens.
      const MEERA = { lid: '33333@lid', pn: '919833333333@s.whatsapp.net' }
      const { store } = server.current()
      await store.upsertThread(userId, { id: `wa:${MEERA.lid}`, network: 'whatsapp', kind: 'direct', title: 'WhatsApp' })
      await store.upsertContact(userId, { id: `wa:${MEERA.lid}`, network: 'whatsapp', name: 'WhatsApp', handle: 'WhatsApp' })
      await store.upsertContact(userId, { id: `wa:${MEERA.pn}`, network: 'whatsapp', name: 'Meera', handle: '+919833333333' })
      await server.restart()
      const reopened = server.sockets.at(-1)!
      reopened.lids.set(MEERA.lid, MEERA.pn) // What the phone told this device before the update.
      reopened.user = { id: '919876543210:4@s.whatsapp.net' }
      reopened.emit('connection.update', { connection: 'open' })
      await waitFor(async () => expect((await titles())[`wa:${MEERA.lid}`]).toBe('Meera'), { timeout: 8000 })
      expect((await inbox()).contacts.find((c: { id: string }) => c.id === `wa:${MEERA.lid}`)).toMatchObject({
        name: 'Meera',
        handle: '+919833333333',
      })

      await browser.delete('/api/link/whatsapp')
    }, 20_000)

    it('keeps only the latest messages of each chat', async () => {
      const RAVI = '919812345678@s.whatsapp.net'
      const browser = await newUser('wa-trim@example.com')
      const socket = await linkWhatsApp(browser)
      const userId = new ObjectId((await browser.get('/api/auth/me')).json.user.id)
      const ts = Math.floor(Date.now() / 1000)
      const say = (target: FakeWaSocket, n: number) =>
        target.emit('messages.upsert', {
          type: 'notify',
          messages: [{ key: { remoteJid: RAVI, fromMe: false, id: `N${n}` }, message: { conversation: `Message ${n}` }, messageTimestamp: ts - 1000 + n }],
        } as never)
      const stored = () => server.database.col.messages.countDocuments({ userId, threadId: `wa:${RAVI}` })

      for (let n = 1; n <= 45; n++) say(socket, n)
      await waitFor(async () => expect(await stored()).toBe(45))
      expect(await server.current().store.trim()).toBe(5)
      expect(await stored()).toBe(40)
      const inbox = (await browser.get('/api/inbox')).json
      const bodies = inbox.messages.map((m: { body: string }) => m.body)
      expect(bodies).toHaveLength(40)
      expect(bodies).toContain('Message 45')
      expect(bodies).not.toContain('Message 5')

      // Data stored before the limit existed is trimmed on start.
      await server.restart()
      const reopened = server.sockets.at(-1)!
      reopened.emit('connection.update', { connection: 'open' })
      for (let n = 46; n <= 48; n++) say(reopened, n)
      await waitFor(async () => expect(await stored()).toBe(43))
      expect(await server.current().store.trimAll()).toBe(3)
      expect(await stored()).toBe(40)

      await browser.delete('/api/link/whatsapp')
    })

    it('explains when linking fails', async () => {
      const browser = await newUser('wa2@example.com')
      expect((await browser.post('/api/link/whatsapp', { phone: '12' })).status).toBe(400)
    })
  })

  describe('photos and files', () => {
    const RAVI = '919812345678@s.whatsapp.net'
    const FILE_LINK = /^\/api\/files\/[\w-]+$/

    it('WhatsApp: opens what people send, from WhatsApp itself, only for its owner, and safely', async () => {
      const browser = await newUser('files-wa@example.com')
      const socket = await linkWhatsApp(browser)
      const events = await browser.events()
      const ts = Math.floor(Date.now() / 1000)
      const page = Buffer.from('<html><script>alert(document.cookie)</script></html>')
      const pageMedia = mediaMessage('documentMessage', page, { mimetype: 'text/html', fileName: 'invite.html' })
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [
          { key: { remoteJid: RAVI, fromMe: false, id: 'IMG1' }, message: mediaMessage('imageMessage', PIXEL, { mimetype: 'image/png', caption: 'Look!' }), messageTimestamp: ts },
          { key: { remoteJid: RAVI, fromMe: false, id: 'DOC1' }, message: pageMedia, messageTimestamp: ts + 1 },
        ],
      } as never)
      const image = (await events.next((e) => e.type === 'message.created' && e.message.id === `wa:${RAVI}:IMG1`)).message
      const doc = (await events.next((e) => e.type === 'message.created' && e.message.id === `wa:${RAVI}:DOC1`)).message
      expect(image.body).toBe('Look!')
      expect(image.attachments).toEqual([{ kind: 'image', name: 'Photo', mime: 'image/png', size: '1 KB', url: expect.stringMatching(FILE_LINK) }])
      expect(doc.attachments).toEqual([{ kind: 'file', name: 'invite.html', mime: 'text/html', size: '1 KB', url: expect.stringMatching(FILE_LINK) }])

      // A photo is shown in the page, fetched from WhatsApp now (nothing was stored).
      const shown = await browser.raw('GET', image.attachments[0].url)
      expect(shown.status).toBe(200)
      expect(shown.body).toEqual(PIXEL)
      expect(shown.headers.get('content-type')).toBe('image/png')
      expect(shown.headers.get('content-disposition')).toMatch(/^inline; filename="Photo.png"/)
      expect(shown.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
      expect(shown.headers.get('content-security-policy')).toMatch(/sandbox/)
      const saved = await browser.raw('GET', `${image.attachments[0].url}?download=1`)
      expect(saved.headers.get('content-disposition')).toMatch(/^attachment; filename="Photo.png"/)

      // A page someone sends is only ever downloaded: it never runs as part of the site.
      const html = await browser.raw('GET', doc.attachments[0].url)
      expect(html.body).toEqual(page)
      expect(html.headers.get('content-type')).toBe('application/octet-stream')
      expect(html.headers.get('content-disposition')).toMatch(/^attachment; filename="invite.html"/)

      // Only its owner can open it, and only with a real link.
      expect((await new Browser(server.url).raw('GET', image.attachments[0].url)).status).toBe(401)
      const stranger = await newUser('files-wa-stranger@example.com')
      expect((await stranger.raw('GET', image.attachments[0].url)).status).toBe(404)
      expect((await browser.raw('GET', `${image.attachments[0].url.slice(0, -4)}AAAA`)).status).toBe(404)

      // Stickers show as stickers, fetched the same way; animated (Lottie) ones too, for the app to play.
      const webp = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 sticker')
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [
          { key: { remoteJid: RAVI, fromMe: false, id: 'STK1' }, message: mediaMessage('stickerMessage', webp, { mimetype: 'image/webp' }), messageTimestamp: ts + 2 },
          {
            key: { remoteJid: RAVI, fromMe: false, id: 'STK2' },
            message: mediaMessage('stickerMessage', Buffer.from('lottie'), { mimetype: 'application/was', isLottie: true }),
            messageTimestamp: ts + 3,
          },
        ],
      } as never)
      const sticker = (await events.next((e) => e.type === 'message.created' && e.message.id === `wa:${RAVI}:STK1`)).message
      expect(sticker.body).toBe('')
      expect(sticker.attachments).toEqual([{ kind: 'sticker', name: 'Sticker', mime: 'image/webp', size: '1 KB', url: expect.stringMatching(FILE_LINK) }])
      const stickerFile = await browser.raw('GET', sticker.attachments[0].url)
      expect(stickerFile.body).toEqual(webp)
      expect(stickerFile.headers.get('content-type')).toBe('image/webp')
      expect(stickerFile.headers.get('content-disposition')).toMatch(/^inline; filename="Sticker.webp"/)
      const lottie = (await events.next((e) => e.type === 'message.created' && e.message.id === `wa:${RAVI}:STK2`)).message
      expect(lottie.attachments).toEqual([{ kind: 'sticker', name: 'Sticker', mime: 'application/was', size: '1 KB', url: expect.stringMatching(FILE_LINK) }])
      // Not an image a browser shows by itself: fetched by the app, which plays it.
      expect((await browser.raw('GET', lottie.attachments[0].url)).headers.get('content-type')).toBe('application/octet-stream')

      // Gone from WhatsApp's servers (and the phone): said so, rather than failing.
      waMedia.delete(pageMedia.documentMessage!.url)
      const gone = await browser.raw('GET', doc.attachments[0].url)
      expect(gone.status).toBe(410)
      expect(JSON.parse(gone.body.toString()).error).toMatch(/no longer available on WhatsApp/)
    })

    it('WhatsApp: sends photos, videos and files as they are, with a caption and a quote', async () => {
      const thread = `wa:${RAVI}`
      const browser = await newUser('files-wa-send@example.com')
      const socket = await linkWhatsApp(browser)
      socket.emit('messaging-history.set', {
        chats: [{ id: RAVI }],
        contacts: [{ id: RAVI, name: 'Ravi Kumar' }],
        messages: [{ key: { remoteJid: RAVI, fromMe: false, id: 'Q1' }, message: { conversation: 'Send me the quote?' }, messageTimestamp: Math.floor(Date.now() / 1000) }],
        isLatest: true,
        syncType: 0,
      } as never)
      await waitFor(async () => expect((await browser.get('/api/inbox')).json.threads.map((t: { id: string }) => t.id)).toContain(thread))

      const pdf = Buffer.from('%PDF-1.7 quote for Ravi')
      const sent = await browser.upload(thread, pdf, { name: 'Quote #2.pdf', type: 'application/pdf', caption: 'Here it is', replyToId: `${thread}:Q1` })
      expect(sent.status).toBe(200)
      expect(sent.json.message).toMatchObject({
        id: `${thread}:FILE1`,
        senderId: 'me',
        body: 'Here it is',
        status: 'sent',
        replyTo: { id: `${thread}:Q1`, senderId: thread, body: 'Send me the quote?' },
        attachments: [{ kind: 'file', name: 'Quote #2.pdf', mime: 'application/pdf', size: '1 KB', url: expect.stringMatching(FILE_LINK) }],
      })
      expect(socket.files[0]).toEqual({ jid: RAVI, kind: 'document', mimetype: 'application/pdf', fileName: 'Quote #2.pdf', caption: 'Here it is', size: pdf.length, quotedId: 'Q1' })
      // It can be downloaded again, from WhatsApp.
      const again = await browser.raw('GET', `${sent.json.message.attachments[0].url}?download=1`)
      expect(again.body).toEqual(pdf)
      expect(again.headers.get('content-disposition')).toMatch(/filename="Quote #2.pdf"; filename\*=UTF-8''Quote%20%232.pdf/)

      // A photo goes as a photo; an MP4 as a video; a JSON file is just a file (not read as a request).
      const photo = await browser.upload(thread, PIXEL, { name: 'IMG_0001.png', type: 'image/png' })
      expect(photo.json.message.attachments[0]).toMatchObject({ kind: 'image', name: 'Photo', mime: 'image/png' })
      expect(socket.files[1]).toMatchObject({ kind: 'image', mimetype: 'image/png' })
      await browser.upload(thread, Buffer.from('fake mp4'), { name: 'clip.mp4', type: 'video/mp4' })
      expect(socket.files[2]).toMatchObject({ kind: 'video', mimetype: 'video/mp4' })
      const json = await browser.upload(thread, Buffer.from('{"not":"a request"}'), { name: 'data.json', type: 'application/json' })
      expect(json.status).toBe(200)
      expect(socket.files[3]).toMatchObject({ kind: 'document', fileName: 'data.json', mimetype: 'application/json' })
      // A name with a path in it keeps only the name.
      await browser.upload(thread, Buffer.from('x'), { name: '../../etc/passwd', type: '' })
      expect(socket.files[4]).toMatchObject({ fileName: '.. .. etc passwd', mimetype: 'application/octet-stream' })

      // Refused: no name, too big, someone else's chat, not signed in.
      expect((await browser.raw('POST', `/api/threads/${enc(thread)}/files`, pdf, { 'Content-Type': 'application/octet-stream' })).status).toBe(400)
      const big = await browser.upload(thread, Buffer.alloc(MAX_TEST_FILE_BYTES + 1), { name: 'big.bin', type: 'application/octet-stream' })
      expect(big.status).toBe(413)
      expect(big.json.error).toMatch(/Files up to/)
      const stranger = await newUser('files-wa-send-stranger@example.com')
      expect((await stranger.upload(thread, pdf, { name: 'x.pdf', type: 'application/pdf' })).status).toBe(404)
      expect((await new Browser(server.url).upload(thread, pdf, { name: 'x.pdf', type: 'application/pdf' })).status).toBe(401)
      expect(socket.files).toHaveLength(5)
    })

    it('WhatsApp: brings back stickers and photos kept before they could be opened', async () => {
      const thread = `wa:${RAVI}`
      const browser = await newUser('files-wa-repair@example.com')
      await linkWhatsApp(browser)
      const userId = new ObjectId((await browser.get('/api/auth/me')).json.user.id)
      // As an earlier version kept them: a sticker only by name, a photo without a link.
      const { store } = server.current()
      await store.upsertThread(userId, { id: thread, network: 'whatsapp', kind: 'direct', title: 'Ravi Kumar' })
      const ts = Math.floor(Date.now() / 1000)
      const keep = (id: string, body: string, extra: object = {}) =>
        store.addMessage(userId, {
          id: `${thread}:${id}`,
          threadId: thread,
          senderId: thread,
          body,
          sentAt: new Date((ts - 60) * 1000).toISOString(),
          ...extra,
          ref: { key: { remoteJid: RAVI, fromMe: false, id } },
        })
      await keep('OLDSTK', 'Sticker')
      await keep('OLDIMG', 'From the shop', { attachments: [{ kind: 'image', name: 'Photo' }] })
      await keep('OLDTXT', 'Just text')

      await server.restart()
      const reopened = server.sockets.at(-1)!
      // The phone still has them, and sends each again when asked.
      const webp = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 an old sticker')
      reopened.phone.set('OLDSTK', { key: { remoteJid: RAVI, fromMe: false, id: 'OLDSTK' }, message: mediaMessage('stickerMessage', webp, { mimetype: 'image/webp' }), messageTimestamp: ts - 60 } as never)
      reopened.phone.set('OLDIMG', {
        key: { remoteJid: RAVI, fromMe: false, id: 'OLDIMG' },
        message: mediaMessage('imageMessage', PIXEL, { mimetype: 'image/png', caption: 'From the shop' }),
        messageTimestamp: ts - 60,
      } as never)
      reopened.user = { id: '919876543210:4@s.whatsapp.net' }
      reopened.emit('connection.update', { connection: 'open' })

      const messages = await waitFor(
        async () => {
          const found = byId((await browser.get('/api/inbox')).json.messages)
          expect(found[`${thread}:OLDSTK`].attachments?.[0]?.url).toMatch(FILE_LINK)
          expect(found[`${thread}:OLDIMG`].attachments?.[0]?.url).toMatch(FILE_LINK)
          return found
        },
        { timeout: 8000 },
      )
      expect(messages[`${thread}:OLDSTK`]).toMatchObject({ body: '', attachments: [{ kind: 'sticker', name: 'Sticker', mime: 'image/webp' }] })
      expect(messages[`${thread}:OLDIMG`]).toMatchObject({ body: 'From the shop', attachments: [{ kind: 'image', mime: 'image/png' }] })
      // Only what had no link was asked for; text messages weren't.
      expect(reopened.resendRequests.map((k) => k.id).sort()).toEqual(['OLDIMG', 'OLDSTK'])
      expect((await browser.raw('GET', messages[`${thread}:OLDSTK`].attachments[0].url)).body).toEqual(webp)
      // Not counted as new.
      expect((await browser.get('/api/inbox')).json.threads.find((t: { id: string }) => t.id === thread).unreadCount).toBe(0)
      await browser.delete('/api/link/whatsapp')
    }, 20_000)

    it('Telegram: brings back photos kept before they could be opened', async () => {
      const tg = server.telegram
      tg.state.needsPassword = false
      const browser = await newUser('files-tg-repair@example.com')
      await browser.post('/api/link/telegram/code', { phone: '+91 90000 00010' })
      expect((await browser.post('/api/link/telegram/verify', { code: '12345' })).json).toEqual({ status: 'connected' })
      const userId = new ObjectId((await browser.get('/api/auth/me')).json.user.id)
      await waitFor(async () => expect(byId((await browser.get('/api/inbox')).json.messages)['tga:-100777:7']).toBeDefined())
      // As an earlier version kept it: without a link.
      await server.current().store.updateMessage(userId, 'tga:-100777:7', { attachments: [{ kind: 'image', name: 'Photo' }] })
      expect(byId((await browser.get('/api/inbox')).json.messages)['tga:-100777:7'].attachments[0].url).toBeUndefined()

      await server.restart()
      await waitFor(async () => expect(byId((await browser.get('/api/inbox')).json.messages)['tga:-100777:7'].attachments[0].url).toMatch(FILE_LINK), {
        timeout: 8000,
      })
      await browser.delete('/api/link/telegram')
    })

    it('Telegram: opens photos and files from Telegram, and sends them', async () => {
      const tg = server.telegram
      tg.state.needsPassword = false
      const browser = await newUser('files-tg@example.com')
      await browser.post('/api/link/telegram/code', { phone: '+91 90000 00009' })
      expect((await browser.post('/api/link/telegram/verify', { code: '12345' })).json).toEqual({ status: 'connected' })

      const photo = await waitFor(async () => {
        const found = (await browser.get('/api/inbox')).json.messages.find((m: { id: string }) => m.id === 'tga:-100777:7')
        if (!found) throw new Error('Not synced yet')
        return found
      })
      expect(photo.attachments).toEqual([{ kind: 'image', name: 'Photo', mime: 'image/jpeg', url: expect.stringMatching(FILE_LINK) }])
      const shown = await browser.raw('GET', photo.attachments[0].url)
      expect(shown.body).toEqual(PIXEL)
      expect(shown.headers.get('content-type')).toBe('image/jpeg')

      const notes = Buffer.from('Trail notes: start at 6am, carry water')
      const sent = await browser.upload('tga:5001', notes, { name: 'notes.txt', type: 'text/plain', caption: 'For Saturday', replyToId: 'tga:5001:12' })
      expect(sent.status).toBe(200)
      expect(sent.json.message).toMatchObject({
        id: 'tga:5001:201',
        body: 'For Saturday',
        replyTo: { id: 'tga:5001:12' },
        attachments: [{ kind: 'file', name: 'notes.txt', mime: 'text/plain', url: expect.stringMatching(FILE_LINK) }],
      })
      expect(tg.state.files[0]).toMatchObject({ chatId: '5001', name: 'notes.txt', mime: 'text/plain', caption: 'For Saturday', replyToId: 12 })
      // Streamed back from Telegram in pieces, as a download.
      const again = await browser.raw('GET', sent.json.message.attachments[0].url)
      expect(again.body).toEqual(notes)
      expect(again.headers.get('content-disposition')).toMatch(/^attachment; filename="notes.txt"/)
    })
  })

  describe('signing out of Sytext', () => {
    it('leaves WhatsApp and Telegram linked: messages keep coming in, and are there on signing back in', async () => {
      const RAVI = '919812345678@s.whatsapp.net'
      const tg = server.telegram
      tg.state.needsPassword = false
      const browser = await newUser('away@example.com')
      const socket = await linkWhatsApp(browser)
      await browser.post('/api/link/telegram/code', { phone: '+91 90000 00005' })
      await browser.post('/api/link/telegram/verify', { code: '12345' })
      await waitFor(async () => expect(byId((await browser.get('/api/inbox')).json.messages)['tga:5001:12']).toBeDefined())
      const userId = new ObjectId((await browser.get('/api/auth/me')).json.user.id)
      const loggedOutBefore = tg.state.loggedOut

      await browser.post('/api/auth/logout')
      expect((await browser.get('/api/inbox')).status).toBe(401)

      // Signed out, both links carry on.
      const now = Math.floor(Date.now() / 1000)
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: RAVI, fromMe: false, id: 'AWAY1' }, message: { conversation: 'Are you there?' }, messageTimestamp: now }],
      } as never)
      tg.emit({ type: 'message', message: { id: 16, chat: tg.asha, out: false, text: 'Ping', date: now } })
      expect(server.current().whatsapp.isConnected(userId)).toBe(true)
      expect(server.current().telegram.isConnected(userId)).toBe(true)
      expect(socket.ended || socket.loggedOut).toBe(false)
      expect(tg.state.loggedOut).toBe(loggedOutBefore)

      // Back in: what arrived meanwhile is there.
      expect((await browser.post('/api/auth/login', { email: 'away@example.com', password: 'long enough' })).status).toBe(200)
      const inbox = await waitFor(async () => {
        const json = (await browser.get('/api/inbox')).json
        const messages = byId(json.messages)
        expect(messages[`wa:${RAVI}:AWAY1`]).toMatchObject({ body: 'Are you there?' })
        expect(messages['tga:5001:16']).toMatchObject({ body: 'Ping' })
        return json
      })
      expect(inbox.accounts.map((a: { network: string; status: string }) => `${a.network}:${a.status}`).sort()).toEqual([
        'telegram:connected',
        'whatsapp:connected',
      ])

      await browser.delete('/api/link/whatsapp')
      await browser.delete('/api/link/telegram')
    })
  })
})
