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

    it("replaces the recovery key when the password changes, so an old one can't take the account back", async () => {
      // Someone who knew the password made themselves a key…
      const intruder = new Browser(server.url)
      await intruder.post('/api/auth/register', { name: 'Meera', email: 'key-thief@example.com', password: 'long enough' })
      const stolen = (await intruder.post('/api/me/recovery-key', { current: 'long enough' })).json.recoveryKey
      // …and the owner changes the password.
      const changed = await intruder.post('/api/me/password', { password: 'only mine now', current: 'long enough' })
      expect(changed.status).toBe(200)
      expect(changed.json.recoveryKey).toMatch(/^([0-9A-Z]{5}-){4}[0-9A-Z]{5}$/)
      expect(changed.json.recoveryKey).not.toBe(stolen)
      const recover = (recoveryKey: string) =>
        new Browser(server.url).post('/api/auth/recover', { email: 'key-thief@example.com', recoveryKey, password: 'taken back' })
      expect((await recover(stolen)).status).toBe(401)
      expect((await recover(changed.json.recoveryKey)).status).toBe(200)
    })

    it('slows down guessing at recovery keys', async () => {
      const guesser = new Browser(server.url)
      const guess = () => guesser.post('/api/auth/recover', { email: 'zoya@example.com', recoveryKey: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', password: 'new password' })
      for (let i = 0; i < 10; i++) expect((await guess()).status).toBe(401)
      const blocked = await guess()
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('retry-after')).toBeTruthy()
      // Someone else (another address) isn't held back by it.
      expect((await new Browser(server.url).post('/api/auth/recover', { email: 'zoya@example.com', recoveryKey: 'x', password: 'new password' })).status).toBe(401)
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
        ai: false,
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
      tg.emit({ type: 'edited', message: { id: 13, chat: tg.asha, out: false, text: 'Bring the big tent?', date: now, editDate: now + 5 } })
      const edited = await events.next((e) => e.type === 'message.updated' && e.message.body === 'Bring the big tent?')
      expect(edited).toMatchObject({ message: { editedAt: new Date((now + 5) * 1000).toISOString() } })
      // A change Telegram doesn't call an edit (no edit date) isn't marked as one.
      tg.emit({ type: 'edited', message: { id: 12, chat: tg.asha, out: false, text: 'Are we still on for Saturday?', date: now - 60, replyToId: 11 } })
      const unchanged = await events.next((e) => e.type === 'message.updated' && e.message.id === 'tga:5001:12')
      expect(unchanged.message.editedAt).toBeUndefined()

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
      // Saved, it comes with its size (as WhatsApp reported it), so the browser shows the progress.
      expect(saved.headers.get('content-length')).toBe(String(PIXEL.length))
      expect(saved.body).toEqual(PIXEL)
      // Shown in the page, it streams as it is.
      expect(shown.headers.get('content-length')).toBeNull()

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

      // Voice messages play in the chat, with their length and waveform; audio files too.
      const ogg = Buffer.from('OggS voice message')
      const waveform = Buffer.from([0, 20, 60, 100, 140, 40])
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [
          {
            key: { remoteJid: RAVI, fromMe: false, id: 'VOX1' },
            message: mediaMessage('audioMessage', ogg, { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 7, waveform }),
            messageTimestamp: ts + 4,
          },
          { key: { remoteJid: RAVI, fromMe: false, id: 'MP3' }, message: mediaMessage('audioMessage', Buffer.from('ID3 song'), { mimetype: 'audio/mpeg', seconds: 185 }), messageTimestamp: ts + 5 },
        ],
      } as never)
      const voice = (await events.next((e) => e.type === 'message.created' && e.message.id === `wa:${RAVI}:VOX1`)).message
      expect(voice.body).toBe('')
      expect(voice.attachments).toEqual([
        { kind: 'audio', name: 'Voice message', mime: 'audio/ogg', size: '1 KB', voice: true, duration: 7, waveform: [0, 20, 60, 100, 100, 40], url: expect.stringMatching(FILE_LINK) },
      ])
      const voiceFile = await browser.raw('GET', voice.attachments[0].url)
      expect(voiceFile.body).toEqual(ogg)
      expect(voiceFile.headers.get('content-type')).toBe('audio/ogg')
      expect(voiceFile.headers.get('content-disposition')).toMatch(/^inline; filename="Voice message.ogg"/)
      const song = (await events.next((e) => e.type === 'message.created' && e.message.id === `wa:${RAVI}:MP3`)).message
      expect(song.attachments).toEqual([{ kind: 'audio', name: 'Audio', mime: 'audio/mpeg', size: '1 KB', duration: 185, url: expect.stringMatching(FILE_LINK) }])

      // A file whose reported size turns out wrong: the download fails, rather than saving a
      // broken file. Shown in the page, it's fine.
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [
          {
            key: { remoteJid: RAVI, fromMe: false, id: 'ODD' },
            message: mediaMessage('documentMessage', Buffer.from('twelve bytes'), { mimetype: 'application/pdf', fileName: 'odd.pdf', fileLength: 99 }),
            messageTimestamp: ts + 6,
          },
        ],
      } as never)
      const odd = (await events.next((e) => e.type === 'message.created' && e.message.id === `wa:${RAVI}:ODD`)).message
      await expect(browser.raw('GET', `${odd.attachments[0].url}?download=1`)).rejects.toThrow()
      expect((await browser.raw('GET', odd.attachments[0].url)).body.toString()).toBe('twelve bytes')
      // From then on it downloads without a size, rather than failing every time.
      const again = await browser.raw('GET', `${odd.attachments[0].url}?download=1`)
      expect(again.body.toString()).toBe('twelve bytes')
      expect(again.headers.get('content-length')).toBeNull()

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
      // WebP isn't a photo to WhatsApp: it goes as a file, as the app shows it while sending.
      await browser.upload(thread, Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '), { name: 'sticker.webp', type: 'image/webp' })
      expect(socket.files[5]).toMatchObject({ kind: 'document', mimetype: 'image/webp' })

      // Refused: no name, too big, someone else's chat, a chat that doesn't exist (before the file
      // is read), not signed in.
      expect((await browser.raw('POST', `/api/threads/${enc(thread)}/files`, pdf, { 'Content-Type': 'application/octet-stream' })).status).toBe(400)
      const big = await browser.upload(thread, Buffer.alloc(MAX_TEST_FILE_BYTES + 1), { name: 'big.bin', type: 'application/octet-stream' })
      expect(big.status).toBe(413)
      expect(big.json.error).toMatch(/Files up to/)
      const stranger = await newUser('files-wa-send-stranger@example.com')
      expect((await stranger.upload(thread, pdf, { name: 'x.pdf', type: 'application/pdf' })).status).toBe(404)
      expect((await browser.upload('wa:000@s.whatsapp.net', pdf, { name: 'x.pdf', type: 'application/pdf' })).status).toBe(404)
      // Refused before it's read, a whole file still gets its answer (not a dropped connection).
      const nowhere = await browser.upload('wa:000@s.whatsapp.net', Buffer.alloc(MAX_TEST_FILE_BYTES), { name: 'x.bin', type: 'application/octet-stream' })
      expect(nowhere).toEqual({ status: 404, json: { error: 'No such chat.' } })
      expect((await new Browser(server.url).upload(thread, pdf, { name: 'x.pdf', type: 'application/pdf' })).status).toBe(401)
      expect(socket.files).toHaveLength(6)
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
      await keep('OLDVOX', '🎤 Voice message')
      await keep('OLDTXT', 'Just text')
      // One the phone no longer has either.
      await keep('NEVER', 'Sticker')

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
      reopened.phone.set('OLDVOX', {
        key: { remoteJid: RAVI, fromMe: false, id: 'OLDVOX' },
        message: mediaMessage('audioMessage', Buffer.from('OggS old voice'), { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 4 }),
        messageTimestamp: ts - 60,
      } as never)
      reopened.user = { id: '919876543210:4@s.whatsapp.net' }
      reopened.emit('connection.update', { connection: 'open' })

      const messages = await waitFor(
        async () => {
          const found = byId((await browser.get('/api/inbox')).json.messages)
          expect(found[`${thread}:OLDSTK`].attachments?.[0]?.url).toMatch(FILE_LINK)
          expect(found[`${thread}:OLDIMG`].attachments?.[0]?.url).toMatch(FILE_LINK)
          expect(found[`${thread}:OLDVOX`].attachments?.[0]?.url).toMatch(FILE_LINK)
          return found
        },
        { timeout: 8000 },
      )
      expect(messages[`${thread}:OLDSTK`]).toMatchObject({ body: '', attachments: [{ kind: 'sticker', name: 'Sticker', mime: 'image/webp' }] })
      expect(messages[`${thread}:OLDIMG`]).toMatchObject({ body: 'From the shop', attachments: [{ kind: 'image', mime: 'image/png' }] })
      // Only what had no link was asked for; text messages weren't.
      expect(messages[`${thread}:OLDVOX`]).toMatchObject({ body: '', attachments: [{ kind: 'audio', voice: true, duration: 4 }] })
      expect(reopened.resendRequests.map((k) => k.id).sort()).toEqual(['NEVER', 'OLDIMG', 'OLDSTK', 'OLDVOX'])
      expect((await browser.raw('GET', messages[`${thread}:OLDSTK`].attachments[0].url)).body).toEqual(webp)
      // Not counted as new.
      expect((await browser.get('/api/inbox')).json.threads.find((t: { id: string }) => t.id === thread).unreadCount).toBe(0)

      // WhatsApp sending a photo again doesn't bring back one deleted since, or undo an edited caption.
      const photo = (id: string, caption: string) => ({
        key: { remoteJid: RAVI, fromMe: false, id },
        message: mediaMessage('imageMessage', PIXEL, { mimetype: 'image/png', caption }),
        messageTimestamp: ts - 60,
      })
      await keep('DELPIC', 'Gone soon', { attachments: [{ kind: 'image', name: 'Photo' }] })
      await store.updateMessage(userId, `${thread}:DELPIC`, { deleted: true })
      await keep('EDPIC', 'Old caption', { attachments: [{ kind: 'image', name: 'Photo' }] })
      await store.updateMessage(userId, `${thread}:EDPIC`, { body: 'New caption', editedAt: new Date().toISOString() })
      reopened.emit('messages.upsert', { type: 'append', messages: [photo('DELPIC', 'Gone soon'), photo('EDPIC', 'Old caption')] } as never)
      const after = await waitFor(async () => {
        const found = byId((await browser.get('/api/inbox')).json.messages)
        expect(found[`${thread}:EDPIC`].attachments?.[0]?.url).toMatch(FILE_LINK)
        return found
      })
      expect(after[`${thread}:EDPIC`].body).toBe('New caption')
      expect(after[`${thread}:DELPIC`]).toMatchObject({ deleted: true, body: '' })
      expect(after[`${thread}:DELPIC`].attachments).toBeUndefined()

      // Looked at once: a message with nothing to fetch isn't read again to find out.
      const docs = server.database.col.messages
      expect(await docs.findOne({ userId, id: `${thread}:OLDTXT` })).toMatchObject({ filesOk: true })
      expect(await docs.findOne({ userId, id: `${thread}:NEVER` })).toMatchObject({ fileAskedAt: expect.any(Date) })

      // The connection coming back within the hour doesn't ask again, even for one new since.
      await keep('LATER', 'Sticker')
      reopened.emit('connection.update', { connection: 'close', lastDisconnect: { error: Object.assign(new Error('restart'), { output: { statusCode: 515 } }), date: new Date() } })
      await waitFor(() => expect(server.sockets.at(-1)).not.toBe(reopened))
      const resumed = server.sockets.at(-1)!
      resumed.user = { id: '919876543210:4@s.whatsapp.net' }
      resumed.emit('connection.update', { connection: 'open' })
      await new Promise((r) => setTimeout(r, 300))
      expect(resumed.resendRequests).toEqual([])

      // Reconnecting soon after, what was just asked for isn't asked for again (some never come).
      await server.restart()
      const again = server.sockets.at(-1)!
      again.user = { id: '919876543210:4@s.whatsapp.net' }
      again.emit('connection.update', { connection: 'open' })
      // (Only the one new since, from a new start of the server.)
      await waitFor(() => expect(again.resendRequests.map((k) => k.id)).toEqual(['LATER']))
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

      // And one Telegram refuses (a chat left since, say): asked once, then left for a day.
      await server.current().store.updateMessage(userId, 'tga:5001:11', { attachments: [{ kind: 'image', name: 'Photo' }] })
      tg.state.unreachable.add(11)
      try {
        await server.restart()
        await waitFor(async () => expect(byId((await browser.get('/api/inbox')).json.messages)['tga:-100777:7'].attachments[0].url).toMatch(FILE_LINK), {
          timeout: 8000,
        })
        await waitFor(async () => expect(await server.database.col.messages.findOne({ userId, id: 'tga:5001:11' })).toMatchObject({ fileAskedAt: expect.any(Date) }))
      } finally {
        tg.state.unreachable.delete(11)
      }
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
      // Telegram says exactly how big it is: the browser can show the download's progress.
      expect(again.headers.get('content-length')).toBe(String(notes.length))
      expect(again.headers.get('content-disposition')).toMatch(/^attachment; filename="notes.txt"/)
    })
  })

  describe('editing, deleting, pinning and starring', () => {
    const RAVI = '919812345678@s.whatsapp.net'
    const thread = `wa:${RAVI}`
    const act = (browser: Browser, threadId: string, messageId: string, action: Record<string, unknown>) =>
      browser.post(`/api/threads/${enc(threadId)}/message-actions`, { messageId, action })

    it('WhatsApp: both ways, and kept however old once pinned or starred', async () => {
      const browser = await newUser('actions-wa@example.com')
      const socket = await linkWhatsApp(browser)
      const events = await browser.events()
      const ts = Math.floor(Date.now() / 1000)
      socket.emit('messaging-history.set', {
        chats: [{ id: RAVI }],
        contacts: [{ id: RAVI, name: 'Ravi Kumar' }],
        messages: [
          { key: { remoteJid: RAVI, fromMe: true, id: 'MINE' }, message: { conversation: 'Shipping on Monday' }, messageTimestamp: ts - 300, status: 3 },
          { key: { remoteJid: RAVI, fromMe: false, id: 'HIS' }, message: { conversation: 'Great, my address is 12 MG Road' }, messageTimestamp: ts - 200 },
          { key: { remoteJid: RAVI, fromMe: false, id: 'OTHER' }, message: { conversation: 'Thanks!' }, messageTimestamp: ts - 100 },
          { key: { remoteJid: RAVI, fromMe: true, id: 'LASTWEEK' }, message: { conversation: 'Invoice attached' }, messageTimestamp: ts - 7 * 86400, status: 4 },
        ],
        isLatest: true,
        syncType: 0,
      } as never)
      await waitFor(async () => expect(byId((await browser.get('/api/inbox')).json.messages)[`${thread}:OTHER`]).toBeDefined())

      // Editing: my own messages only.
      const edited = await act(browser, thread, `${thread}:MINE`, { type: 'edit', body: 'Shipping on Tuesday' })
      expect(edited.status).toBe(200)
      expect(edited.json.message).toMatchObject({ body: 'Shipping on Tuesday', editedAt: expect.any(String) })
      expect(socket.changes.at(-1)).toEqual({ jid: RAVI, change: 'edit', id: 'MINE', text: 'Shipping on Tuesday' })
      expect((await act(browser, thread, `${thread}:HIS`, { type: 'edit', body: 'Nope' })).status).toBe(403)
      expect((await act(browser, thread, `${thread}:MINE`, { type: 'edit', body: '   ' })).status).toBe(400)
      expect((await act(browser, thread, `${thread}:MINE`, { type: 'rename' })).status).toBe(400)
      // Past WhatsApp's limits, which phones would quietly ignore.
      const changesBeforeLimits = socket.changes.length
      const late = await act(browser, thread, `${thread}:LASTWEEK`, { type: 'edit', body: 'Invoice attached (v2)' })
      expect(late.status).toBe(400)
      expect(late.json.error).toMatch(/15 minutes/)
      expect((await act(browser, thread, `${thread}:LASTWEEK`, { type: 'delete', forEveryone: true })).json.error).toMatch(/about 2 days/)
      expect(socket.changes.length).toBe(changesBeforeLimits)

      // Pinning and starring.
      const pinnedHis = (await act(browser, thread, `${thread}:HIS`, { type: 'pin', pinned: true })).json.message
      expect(pinnedHis).toMatchObject({ pinned: true })
      // For 30 days, as WhatsApp keeps it.
      expect(Date.parse(pinnedHis.pinnedUntil) - Date.now()).toBeGreaterThan(29 * 86_400_000)
      expect(socket.changes.at(-1)).toEqual({ jid: RAVI, change: 'pin', id: 'HIS', pinned: true })
      expect((await act(browser, thread, `${thread}:HIS`, { type: 'star', starred: true })).json.message).toMatchObject({ starred: true })
      expect(socket.changes.at(-1)).toEqual({ jid: RAVI, change: 'star', id: 'HIS', starred: true })

      // Deleting for everyone (mine), and for me.
      expect((await act(browser, thread, `${thread}:HIS`, { type: 'delete', forEveryone: true })).status).toBe(403)
      const unsent = await act(browser, thread, `${thread}:MINE`, { type: 'delete', forEveryone: true })
      expect(unsent.json.message).toMatchObject({ deleted: true, body: '' })
      expect(socket.changes.at(-1)).toEqual({ jid: RAVI, change: 'delete', id: 'MINE' })
      expect((await act(browser, thread, `${thread}:MINE`, { type: 'edit', body: 'Back again' })).status).toBe(409)
      // Nor reacted to.
      const reactionsBefore = socket.reactions.length
      expect((await browser.post(`/api/threads/${enc(thread)}/reactions`, { messageId: `${thread}:MINE`, emoji: '👍' })).status).toBe(409)
      expect(socket.reactions.length).toBe(reactionsBefore)

      // A message that can't be opened (sealed with another key) is never sealed over.
      const userIdHere = new ObjectId((await browser.get('/api/auth/me')).json.user.id)
      const sealedElsewhere = 'v1:c2VhbGVkIHdpdGggYW5vdGhlciBrZXk='
      await server.database.col.messages.insertOne({
        userId: userIdHere,
        id: `${thread}:OTHERKEY`,
        threadId: thread,
        senderId: thread,
        sentAt: new Date((ts - 3600) * 1000),
        payload: sealedElsewhere,
      })
      const { store: storeHere } = server.current()
      await storeHere.updateMessage(userIdHere, `${thread}:OTHERKEY`, { body: 'Edited', editedAt: new Date().toISOString() })
      await storeHere.setReaction(userIdHere, `${thread}:OTHERKEY`, 'me', '👍', { at: Date.now() })
      await storeHere.linkFiles(userIdHere, `${thread}:OTHERKEY`, '', [{ kind: 'image', name: 'Photo', url: '/api/files/x' }])
      expect((await server.database.col.messages.findOne({ userId: userIdHere, id: `${thread}:OTHERKEY` }))?.payload).toBe(sealedElsewhere)
      const gone = await act(browser, thread, `${thread}:OTHER`, { type: 'delete', forEveryone: false })
      expect(gone.json).toEqual({ message: null, removed: true })
      // With the message's time in seconds, as WhatsApp keeps it.
      expect(socket.changes.at(-1)).toEqual({ jid: RAVI, change: 'delete-for-me', id: 'OTHER', timestamp: ts - 100 })
      await events.next((e) => e.type === 'message.deleted' && e.messageId === `${thread}:OTHER`)
      expect(byId((await browser.get('/api/inbox')).json.messages)[`${thread}:OTHER`]).toBeUndefined()
      // Remembered, for devices that were away when it happened: for a month.
      expect((await browser.get('/api/inbox')).json.deleted).toContain(`${thread}:OTHER`)
      const deletedBy = { userId: new ObjectId((await browser.get('/api/auth/me')).json.user.id), id: thread }
      const threads = server.database.col.threads
      await threads.updateOne({ ...deletedBy, 'deletedIds.id': `${thread}:OTHER` }, { $set: { 'deletedIds.$.at': new Date(Date.now() - 31 * 86_400_000) } })
      // (Kept as a bare id at first.)
      await threads.updateOne(deletedBy, { $push: { deletedIds: `${thread}:EARLIER` } })
      const remembered = (await browser.get('/api/inbox')).json
      expect(remembered.deleted).not.toContain(`${thread}:OTHER`)
      expect(remembered.deleted).toContain(`${thread}:EARLIER`)
      // A device away since before the one no longer listed starts that chat afresh.
      const DAY = 86_400_000
      expect(Date.parse(remembered.at) - Date.parse(remembered.deletedSince[thread])).toBeGreaterThan(31 * DAY - 60_000)
      expect(Date.parse(remembered.at) - Date.parse(remembered.deletedSince[thread])).toBeLessThan(31 * DAY + 60_000)
      // So does one away since before the oldest still listed, once there are too many to list them all.
      const many = Array.from({ length: 60 }, (_, i) => ({ id: `${thread}:MANY${i}`, at: new Date(Date.now() - (60 - i) * 60_000) }))
      await threads.updateOne(deletedBy, { $push: { deletedIds: { $each: many, $slice: -50 } } })
      const full = (await browser.get('/api/inbox')).json
      expect(full.deleted).not.toContain(`${thread}:MANY9`)
      expect(full.deletedSince[thread]).toBe(many[10].at.toISOString())

      // Starring a message the server no longer keeps: it keeps a copy, from what the device says.
      const old = { id: `${thread}:ANCIENT`, senderId: thread, sentAt: new Date((ts - 90 * 86400) * 1000).toISOString(), body: 'Here is the warranty card' }
      const attachments = [
        { kind: 'image', name: 'Photo', mime: 'image/jpeg', url: '/api/files/abc' },
        { kind: 'file', name: 'evil.html', url: 'https://evil.example/x' },
      ]
      const starredOld = await browser.post(`/api/threads/${enc(thread)}/message-actions`, {
        messageId: old.id,
        action: { type: 'star', starred: true },
        message: { ...old, attachments },
      })
      expect(starredOld.json.message).toMatchObject({ id: old.id, body: 'Here is the warranty card', starred: true })
      // Only links to this server's own files are kept.
      expect(starredOld.json.message.attachments).toEqual([{ kind: 'image', name: 'Photo', mime: 'image/jpeg', url: '/api/files/abc' }, { kind: 'file', name: 'evil.html' }])
      expect(byId((await browser.get('/api/inbox')).json.messages)[old.id]).toMatchObject({ starred: true })

      // A pin WhatsApp refuses keeps nothing; one it takes keeps everything the device showed.
      const older = {
        id: `${thread}:OLDER`,
        senderId: 'me',
        sentAt: new Date((ts - 80 * 86400) * 1000).toISOString(),
        body: 'Booked for the 14th',
        replyTo: { id: `${thread}:Q`, senderId: thread, body: 'Did you book it?' },
        reactions: [{ emoji: '👍', count: 1, mine: false }, { emoji: 'not an emoji at all', count: 1, mine: true }],
        editedAt: new Date((ts - 80 * 86400 + 60) * 1000).toISOString(),
        status: 'read',
      }
      const pinOlder = () => browser.post(`/api/threads/${enc(thread)}/message-actions`, { messageId: older.id, action: { type: 'pin', pinned: true }, message: older })
      socket.failSends = true
      expect((await pinOlder()).status).toBe(502)
      socket.failSends = false
      expect(byId((await browser.get('/api/inbox')).json.messages)[older.id]).toBeUndefined()
      expect((await pinOlder()).json.message).toMatchObject({
        id: older.id,
        pinned: true,
        replyTo: older.replyTo,
        reactions: [{ emoji: '👍', count: 1, mine: false }],
        editedAt: older.editedAt,
        status: 'read',
      })
      // Reacted to since: in a chat with one other person, the ones it had that weren't mine were
      // theirs, so their new one takes their place.
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [
          { key: { remoteJid: RAVI, fromMe: false, id: 'R-OLDER' }, message: { reactionMessage: { key: { remoteJid: RAVI, fromMe: true, id: 'OLDER' }, text: '❤️' } }, messageTimestamp: ts },
        ],
      } as never)
      const reacted = await events.next((e) => e.type === 'message.updated' && e.message.id === older.id && !!e.message.reactions?.some((r: { emoji: string }) => r.emoji === '❤️'))
      expect(reacted.message.reactions).toEqual([{ emoji: '❤️', count: 1, mine: false }])
      expect(reacted.message.reactedBy).toEqual({ [thread]: '❤️' })
      // Said again (as a history replay does), it still counts once; changed, it moves.
      const ravisReaction = (id: string, text: string, at = ts * 1000) => ({
        key: { remoteJid: RAVI, fromMe: false, id },
        message: { reactionMessage: { key: { remoteJid: RAVI, fromMe: true, id: 'OLDER' }, text, senderTimestampMs: at } },
        messageTimestamp: Math.floor(at / 1000),
      })
      socket.emit('messages.upsert', { type: 'append', messages: [ravisReaction('R-OLDER', '❤️'), ravisReaction('R-OLDER2', '😂', ts * 1000 + 5000)] } as never)
      const changed = await events.next((e) => e.type === 'message.updated' && e.message.id === older.id && !!e.message.reactions?.some((r: { emoji: string }) => r.emoji === '😂'))
      expect(changed.message.reactions).toEqual([{ emoji: '😂', count: 1, mine: false }])
      // An older word of it, late (a replay), changes nothing; taking it back does.
      socket.emit('messages.upsert', { type: 'append', messages: [ravisReaction('R-OLDER', '❤️')] } as never)
      socket.emit('messages.upsert', { type: 'notify', messages: [ravisReaction('R-OLDER3', '', ts * 1000 + 9000)] } as never)
      const takenBack = await events.next((e) => e.type === 'message.updated' && e.message.id === older.id && !e.message.reactions)
      expect(takenBack.message.reactedBy).toBeUndefined()
      // One given before that, arriving late, changes nothing either.
      socket.emit('messages.upsert', { type: 'append', messages: [ravisReaction('R-OLDER4', '🙏', ts * 1000 + 7000)] } as never)
      await new Promise((r) => setTimeout(r, 300))
      expect(byId((await browser.get('/api/inbox')).json.messages)[older.id].reactions).toBeUndefined()

      // The same, done on the phone.
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [
          { key: { remoteJid: RAVI, fromMe: false, id: 'P1' }, message: { conversation: 'Call me when you leave' }, messageTimestamp: ts },
          { key: { remoteJid: RAVI, fromMe: true, id: 'UNPIN' }, message: { pinInChatMessage: { key: { remoteJid: RAVI, fromMe: false, id: 'HIS' }, type: 2 } }, messageTimestamp: ts },
          {
            key: { remoteJid: RAVI, fromMe: false, id: 'PINP1' },
            message: { pinInChatMessage: { key: { remoteJid: RAVI, fromMe: false, id: 'P1' }, type: 1 }, messageContextInfo: { messageAddOnDurationInSecs: 86400 } },
            messageTimestamp: ts,
          },
        ],
      } as never)
      const pinnedP1 = await events.next((e) => e.type === 'message.updated' && e.message.id === `${thread}:P1` && e.message.pinned === true)
      // A pin for 24 hours (WhatsApp says how long with the pin) ends a day after it was made.
      expect(pinnedP1.message.pinnedUntil).toBe(new Date((ts + 86400) * 1000).toISOString())
      await events.next((e) => e.type === 'message.updated' && e.message.id === `${thread}:HIS` && !e.message.pinned)
      socket.emit('messages.update', [{ key: { remoteJid: RAVI, fromMe: false, id: 'P1' }, update: { starred: true } }] as never)
      await events.next((e) => e.type === 'message.updated' && e.message.id === `${thread}:P1` && e.message.starred === true)
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: RAVI, fromMe: false, id: 'REV' }, message: { protocolMessage: { key: { remoteJid: RAVI, fromMe: false, id: 'P1' }, type: 0 } }, messageTimestamp: ts }],
      } as never)
      await events.next((e) => e.type === 'message.updated' && e.message.id === `${thread}:P1` && e.message.deleted === true)
      socket.emit('messages.delete', { keys: [{ remoteJid: RAVI, fromMe: false, id: 'HIS' }] } as never)
      await events.next((e) => e.type === 'message.deleted' && e.messageId === `${thread}:HIS`)

      // Pinned and starred messages stay on the server however many come after them.
      const userId = new ObjectId((await browser.get('/api/auth/me')).json.user.id)
      const { store } = server.current()
      const busy = `wa:120363999999@g.us`
      await store.upsertThread(userId, { id: busy, network: 'whatsapp', kind: 'group', title: 'Busy group' })
      const lapsed = new Date((ts - 3600) * 1000).toISOString()
      for (let i = 0; i < 45; i++) {
        await store.addMessage(userId, {
          id: `${busy}:B${i}`,
          threadId: busy,
          senderId: 'me',
          body: `Message ${i}`,
          sentAt: new Date((ts - 1000 + i) * 1000).toISOString(),
          ...(i === 0 ? { starred: true } : {}),
          ...(i === 1 ? { pinned: true } : {}),
          // A pin that ran out keeps nothing.
          ...(i === 2 ? { pinned: true, pinnedUntil: lapsed } : {}),
        })
      }
      await store.trim()
      const kept = (await browser.get('/api/inbox')).json.messages.filter((m: { threadId: string }) => m.threadId === busy).map((m: { id: string }) => m.id)
      expect(kept).toHaveLength(42)
      expect(kept).toEqual(expect.arrayContaining([`${busy}:B0`, `${busy}:B1`, `${busy}:B44`]))
      expect(kept).not.toContain(`${busy}:B2`)
      events.close()
      await browser.delete('/api/link/whatsapp')
    })

    it('WhatsApp: a batch from several new chats, with a pin and a reaction pointing into it', async () => {
      const browser = await newUser('batch-wa@example.com')
      const socket = await linkWhatsApp(browser)
      const ts = Math.floor(Date.now() / 1000)
      const ASHA = '919800055566@s.whatsapp.net'
      const DEV = '919800077788@s.whatsapp.net'
      const text = (jid: string, id: string, body: string, at: number) => ({ key: { remoteJid: jid, fromMe: false, id }, message: { conversation: body }, messageTimestamp: at })
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [
          // Pointers first, as WhatsApp may send them: they still find their messages.
          { key: { remoteJid: ASHA, fromMe: false, id: 'PIN-A2' }, message: { pinInChatMessage: { key: { remoteJid: ASHA, fromMe: false, id: 'A2' }, type: 1 } }, messageTimestamp: ts + 5 },
          { key: { remoteJid: DEV, fromMe: false, id: 'R-D1' }, message: { reactionMessage: { key: { remoteJid: DEV, fromMe: false, id: 'D1' }, text: '🔥' } }, messageTimestamp: ts + 5 },
          text(ASHA, 'A1', 'Hi! New customer here', ts),
          text(DEV, 'D1', 'Shipping update', ts + 1),
          text(ASHA, 'A2', 'Order #42: 3 mugs', ts + 2),
          text(DEV, 'D2', 'Out for delivery', ts + 3),
        ],
      } as never)
      const inbox = async () => (await browser.get('/api/inbox')).json
      await waitFor(async () => {
        const { messages, threads } = await inbox()
        const byIdMessages = byId(messages)
        expect(byIdMessages[`wa:${ASHA}:A2`]).toMatchObject({ pinned: true })
        expect(byIdMessages[`wa:${DEV}:D1`].reactions).toEqual([{ emoji: '🔥', count: 1, mine: false }])
        // Each new chat made once, with both of its messages counted.
        expect(byId(threads)[`wa:${ASHA}`]).toMatchObject({ unreadCount: 2 })
        expect(byId(threads)[`wa:${DEV}`]).toMatchObject({ unreadCount: 2 })
      })
      const { threads } = await inbox()
      expect(threads.filter((t: { id: string }) => t.id === `wa:${ASHA}`)).toHaveLength(1)

      // A reaction in the next batch, while a new group from the one before is still being made.
      const GROUP = '120363555555@g.us'
      socket.groupDelayMs = 300
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: GROUP, fromMe: false, id: 'G1', participant: DEV }, message: { conversation: 'Welcome all' }, messageTimestamp: ts + 6 }],
      } as never)
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: GROUP, fromMe: false, id: 'R-G1', participant: ASHA }, message: { reactionMessage: { key: { remoteJid: GROUP, fromMe: false, id: 'G1', participant: DEV }, text: '🎉' } }, messageTimestamp: ts + 7 }],
      } as never)
      await waitFor(async () => expect(byId((await inbox()).messages)[`wa:${GROUP}:G1`]?.reactions).toEqual([{ emoji: '🎉', count: 1, mine: false }]))

      // A group WhatsApp is slow to name: its messages wait for the name briefly, and once, and
      // other chats not at all; the name comes when it does.
      const SLOW = '120363666666@g.us'
      socket.groupDelayMs = 1500
      const lookupsBefore = socket.groupLookups
      const inGroup = (id: string, body: string) => ({ key: { remoteJid: SLOW, fromMe: false, id, participant: DEV }, message: { conversation: body }, messageTimestamp: ts + 8 })
      socket.emit('messages.upsert', { type: 'notify', messages: [inGroup('S1', 'Hello group')] } as never)
      socket.emit('messages.upsert', { type: 'notify', messages: [inGroup('S2', 'Anyone?')] } as never)
      socket.emit('messages.upsert', { type: 'notify', messages: [text(ASHA, 'A3', 'Also, gift wrap please', ts + 9)] } as never)
      await waitFor(async () => expect(byId((await inbox()).messages)[`wa:${ASHA}:A3`]).toBeDefined(), { timeout: 300 })
      expect(byId((await inbox()).messages)[`wa:${SLOW}:S1`]).toBeUndefined()
      await waitFor(async () => {
        const { messages } = await inbox()
        expect(byId(messages)[`wa:${SLOW}:S1`]).toBeDefined()
        expect(byId(messages)[`wa:${SLOW}:S2`]).toBeDefined()
      })
      expect(socket.groupLookups - lookupsBefore).toBe(1)
      await waitFor(async () => expect(byId((await inbox()).threads)[`wa:${SLOW}`].title).toBe('Family'), { timeout: 3000 })
      socket.groupDelayMs = 0

      // Group messages kept again from a device's copy.
      const sorted = <T extends { emoji: string }>(reactions: T[] = []) => [...reactions].sort((a, b) => a.emoji.localeCompare(b.emoji))
      const keepAgain = (id: string, extra: object) =>
        browser.post(`/api/threads/${enc(`wa:${GROUP}`)}/message-actions`, {
          messageId: `wa:${GROUP}:${id}`,
          action: { type: 'star', starred: true },
          message: { id: `wa:${GROUP}:${id}`, senderId: 'me', sentAt: new Date((ts - 90 * 86400) * 1000).toISOString(), body: 'Trip on Saturday', ...extra },
        })
      const reactTo = (target: string, id: string, who: string, text: string, at: number) => ({
        key: { remoteJid: GROUP, fromMe: false, id, participant: who },
        message: { reactionMessage: { key: { remoteJid: GROUP, fromMe: true, id: target }, text, senderTimestampMs: at } },
        messageTimestamp: Math.floor(at / 1000),
      })
      // Showing only totals (who gave them unknown): members' reactions go on top, each counted
      // once however often it's told (until WhatsApp lists them all, below).
      await keepAgain('OLDG', { reactions: [{ emoji: '👍', count: 2, mine: false }] })
      socket.emit('messages.upsert', {
        type: 'append',
        messages: [reactTo('OLDG', 'RG1', DEV, '👍', Date.now()), reactTo('OLDG', 'RG2', ASHA, '❤️', Date.now()), reactTo('OLDG', 'RG1', DEV, '👍', Date.now())],
      } as never)
      await waitFor(async () =>
        expect(sorted(byId((await inbox()).messages)[`wa:${GROUP}:OLDG`].reactions)).toEqual(
          sorted([
            { emoji: '👍', count: 3, mine: false },
            { emoji: '❤️', count: 1, mine: false },
          ]),
        ),
      )
      // Knowing who gave which: exact, whoever changes theirs.
      await keepAgain('OLDX', {
        reactions: [
          { emoji: '👍', count: 1, mine: false },
          { emoji: '🙏', count: 1, mine: true },
        ],
        reactedBy: { [`wa:${DEV}`]: '👍', me: '🙏' },
      })
      expect(byId((await inbox()).messages)[`wa:${GROUP}:OLDX`].reactedBy).toEqual({ [`wa:${DEV}`]: '👍', me: '🙏' })
      // Givers that don't add up to what it shows (mine among them, but given by Dev) aren't believed.
      await keepAgain('OLDY', { reactions: [{ emoji: '👍', count: 1, mine: true }], reactedBy: { [`wa:${DEV}`]: '👍' } })
      expect(byId((await inbox()).messages)[`wa:${GROUP}:OLDY`]).toMatchObject({ reactions: [{ emoji: '👍', count: 1, mine: true }] })
      expect(byId((await inbox()).messages)[`wa:${GROUP}:OLDY`].reactedBy).toBeUndefined()
      socket.emit('messages.upsert', { type: 'notify', messages: [reactTo('OLDX', 'RX1', DEV, '🔥', Date.now())] } as never)
      await waitFor(async () =>
        expect(sorted(byId((await inbox()).messages)[`wa:${GROUP}:OLDX`].reactions)).toEqual(
          sorted([
            { emoji: '🔥', count: 1, mine: false },
            { emoji: '🙏', count: 1, mine: true },
          ]),
        ),
      )
      // Mine changed here is newer than an older word of it arriving late from the phone.
      expect((await browser.post(`/api/threads/${enc(`wa:${GROUP}`)}/reactions`, { messageId: `wa:${GROUP}:OLDX`, emoji: '❤️' })).status).toBe(200)
      socket.emit('messages.upsert', {
        type: 'append',
        messages: [{ key: { remoteJid: GROUP, fromMe: true, id: 'RX-MINE' }, message: { reactionMessage: { key: { remoteJid: GROUP, fromMe: true, id: 'OLDX' }, text: '🙏', senderTimestampMs: Date.now() - 60_000 } }, messageTimestamp: ts }],
      } as never)
      await new Promise((r) => setTimeout(r, 300))
      expect(byId((await inbox()).messages)[`wa:${GROUP}:OLDX`].reactedBy.me).toBe('❤️')
      // Many at once on one message: none lost.
      const userIdHere = new ObjectId((await browser.get('/api/auth/me')).json.user.id)
      await Promise.all(
        Array.from({ length: 8 }, (_, i) => server.current().store.setReaction(userIdHere, `wa:${GROUP}:OLDX`, `wa:9198000000${i}@s.whatsapp.net`, '👏', { at: Date.now() })),
      )
      expect(byId((await inbox()).messages)[`wa:${GROUP}:OLDX`].reactions).toEqual(expect.arrayContaining([{ emoji: '👏', count: 8, mine: false }]))
      // WhatsApp listing everyone's reactions with a message (as history does): in place of totals
      // kept from a device's copy, now exact (those told of as they happened stay as told).
      socket.emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [
          {
            key: { remoteJid: GROUP, fromMe: true, id: 'OLDG' },
            message: { conversation: 'Trip on Saturday' },
            messageTimestamp: ts - 90 * 86400,
            reactions: [
              { key: { remoteJid: GROUP, fromMe: false, participant: DEV }, text: '👍' },
              { key: { remoteJid: GROUP, fromMe: true }, text: '🎉' },
            ],
          },
          {
            key: { remoteJid: GROUP, fromMe: false, id: 'H1', participant: ASHA },
            message: { conversation: 'Photos from last time' },
            messageTimestamp: ts - 60,
            reactions: [{ key: { remoteJid: GROUP, fromMe: false, participant: DEV }, text: '😍' }],
          },
        ],
      } as never)
      await waitFor(async () => {
        const found = byId((await inbox()).messages)
        expect(sorted(found[`wa:${GROUP}:OLDG`].reactions)).toEqual(
          sorted([
            { emoji: '👍', count: 1, mine: false },
            { emoji: '🎉', count: 1, mine: true },
            { emoji: '❤️', count: 1, mine: false },
          ]),
        )
        expect(found[`wa:${GROUP}:OLDG`].reactedBy).toEqual({ [`wa:${DEV}`]: '👍', me: '🎉', [`wa:${ASHA}`]: '❤️' })
        expect(found[`wa:${GROUP}:H1`]).toMatchObject({ reactions: [{ emoji: '😍', count: 1, mine: false }], reactedBy: { [`wa:${DEV}`]: '😍' } })
      })
      // A newer list changes Dev's (newer by his clock); Asha's, told of as it happened, stays; mine,
      // known only from the older list, goes with this one not naming it.
      socket.emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [
          {
            key: { remoteJid: GROUP, fromMe: true, id: 'OLDG' },
            message: { conversation: 'Trip on Saturday' },
            messageTimestamp: ts - 90 * 86400,
            reactions: [{ key: { remoteJid: GROUP, fromMe: false, participant: DEV }, text: '😂', senderTimestampMs: Date.now() + 60_000 }],
          },
        ],
      } as never)
      await waitFor(async () => expect(byId((await inbox()).messages)[`wa:${GROUP}:OLDG`].reactedBy).toEqual({ [`wa:${DEV}`]: '😂', [`wa:${ASHA}`]: '❤️' }))
      // Changed live since, a later copy of the same list doesn't undo it.
      socket.emit('messages.upsert', { type: 'notify', messages: [reactTo('H1', 'RH1', DEV, '👏', Date.now())] } as never)
      await waitFor(async () => expect(byId((await inbox()).messages)[`wa:${GROUP}:H1`].reactedBy).toEqual({ [`wa:${DEV}`]: '👏' }))
      socket.emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [
          {
            key: { remoteJid: GROUP, fromMe: false, id: 'H1', participant: ASHA },
            message: { conversation: 'Photos from last time' },
            messageTimestamp: ts - 60,
            reactions: [{ key: { remoteJid: GROUP, fromMe: false, participant: DEV }, text: '😍', senderTimestampMs: (ts - 30) * 1000 }],
          },
        ],
      } as never)
      await new Promise((r) => setTimeout(r, 300))
      expect(byId((await inbox()).messages)[`wa:${GROUP}:H1`].reactedBy).toEqual({ [`wa:${DEV}`]: '👏' })
      // A list newer than that one does.
      socket.emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [
          {
            key: { remoteJid: GROUP, fromMe: false, id: 'H1', participant: ASHA },
            message: { conversation: 'Photos from last time' },
            messageTimestamp: ts - 60,
            reactions: [{ key: { remoteJid: GROUP, fromMe: false, participant: DEV }, text: '😮', senderTimestampMs: Date.now() + 60_000 }],
          },
        ],
      } as never)
      await waitFor(async () => expect(byId((await inbox()).messages)[`wa:${GROUP}:H1`].reactedBy).toEqual({ [`wa:${DEV}`]: '😮' }))
      // A message deleted for everyone takes no reactions.
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: GROUP, fromMe: false, id: 'REVH1', participant: ASHA }, message: { protocolMessage: { key: { remoteJid: GROUP, fromMe: false, id: 'H1', participant: ASHA }, type: 0 } }, messageTimestamp: ts }],
      } as never)
      await waitFor(async () => expect(byId((await inbox()).messages)[`wa:${GROUP}:H1`]).toMatchObject({ deleted: true }))
      socket.emit('messages.upsert', { type: 'notify', messages: [reactTo('H1', 'RH2', DEV, '😮', Date.now() + 1000)] } as never)
      await new Promise((r) => setTimeout(r, 300))
      expect(byId((await inbox()).messages)[`wa:${GROUP}:H1`].reactions).toBeUndefined()
      await browser.delete('/api/link/whatsapp')
    }, 20_000)

    it('Telegram: edits, deletes and pins in Telegram; stars are kept in Sytext', async () => {
      const tg = server.telegram
      tg.state.needsPassword = false
      const browser = await newUser('actions-tg@example.com')
      await browser.post('/api/link/telegram/code', { phone: '+91 90000 00011' })
      expect((await browser.post('/api/link/telegram/verify', { code: '12345' })).json).toEqual({ status: 'connected' })
      await waitFor(async () => expect(byId((await browser.get('/api/inbox')).json.messages)['tga:5001:12']).toBeDefined())
      const events = await browser.events()
      const before = tg.state.changes.length

      const edited = await act(browser, 'tga:5001', 'tga:5001:11', { type: 'edit', body: 'Yes! See you at 10' })
      expect(edited.json.message).toMatchObject({ body: 'Yes! See you at 10', editedAt: expect.any(String) })
      expect((await act(browser, 'tga:5001', 'tga:5001:12', { type: 'edit', body: 'Not mine' })).status).toBe(403)
      const late = await act(browser, 'tga:5001', 'tga:5001:11', { type: 'edit', body: 'too late' })
      expect(late.status).toBe(400)
      expect(late.json.error).toMatch(/too old to edit/)
      expect((await act(browser, 'tga:5001', 'tga:5001:12', { type: 'pin', pinned: true })).json.message).toMatchObject({ pinned: true })
      const changesBeforeStar = tg.state.changes.length
      expect((await act(browser, 'tga:5001', 'tga:5001:12', { type: 'star', starred: true })).json.message).toMatchObject({ starred: true })
      expect(tg.state.changes.length).toBe(changesBeforeStar) // Telegram has no stars: kept in Sytext only.
      expect((await act(browser, 'tga:5001', 'tga:5001:11', { type: 'delete', forEveryone: true })).json).toEqual({ message: null, removed: true })
      expect(tg.state.changes.slice(before)).toEqual([
        { chatId: '5001', change: 'edit', id: 11, text: 'Yes! See you at 10' },
        { chatId: '5001', change: 'pin', id: 12 },
        { chatId: '5001', change: 'delete', id: 11 },
      ])
      expect(byId((await browser.get('/api/inbox')).json.messages)['tga:5001:11']).toBeUndefined()

      // A supergroup has no "delete for me" (it would delete for everyone): it's only removed from Sytext.
      await waitFor(async () => expect(byId((await browser.get('/api/inbox')).json.messages)['tga:-100777:7']).toBeDefined())
      const changesBeforeHiding = tg.state.changes.length
      expect((await act(browser, 'tga:-100777', 'tga:-100777:7', { type: 'delete', forEveryone: false })).json).toEqual({ message: null, removed: true })
      expect(tg.state.changes.length).toBe(changesBeforeHiding)
      expect(byId((await browser.get('/api/inbox')).json.messages)['tga:-100777:7']).toBeUndefined()

      // Deleted and unpinned in Telegram's own app: a private chat's deletion names only the message.
      tg.emit({ type: 'pinned', chatId: '5001', ids: [12], pinned: false })
      await events.next((e) => e.type === 'message.updated' && e.message.id === 'tga:5001:12' && !e.message.pinned)
      tg.emit({ type: 'deleted', ids: [12] })
      await events.next((e) => e.type === 'message.deleted' && e.messageId === 'tga:5001:12')
      expect(byId((await browser.get('/api/inbox')).json.messages)['tga:5001:12']).toBeUndefined()
      events.close()
      await browser.delete('/api/link/telegram')
    })
  })

  describe('done, snoozed and tasks', () => {
    it('are kept with the account: after signing out and in again, and on other devices', async () => {
      const RAVI = '919812345678@s.whatsapp.net'
      const thread = `wa:${RAVI}`
      const browser = await newUser('kept-state@example.com')
      const socket = await linkWhatsApp(browser)
      const ts = Math.floor(Date.now() / 1000)
      socket.emit('messaging-history.set', {
        chats: [{ id: RAVI }],
        contacts: [],
        messages: [{ key: { remoteJid: RAVI, fromMe: false, id: 'Q1' }, message: { conversation: 'Can you send the invoice?' }, messageTimestamp: ts - 120 }],
        isLatest: true,
        syncType: 0,
      } as never)
      const threads = async (b: Browser) => byId((await b.get('/api/inbox')).json.threads)
      await waitFor(async () => expect((await threads(browser))[thread]).toMatchObject({ doneAt: null, snoozedUntil: null }))

      // Another device sees it as it happens.
      const other = new Browser(server.url)
      expect((await other.post('/api/auth/login', { email: 'kept-state@example.com', password: 'long enough' })).status).toBe(200)
      const events = await other.events()

      const doneAt = new Date().toISOString()
      const done = await browser.post(`/api/threads/${enc(thread)}/state`, { doneAt })
      expect(done.json.thread).toMatchObject({ id: thread, doneAt, snoozedUntil: null })
      await events.next((e) => e.type === 'thread.updated' && e.thread.id === thread && e.thread.doneAt === doneAt)

      const task = { id: 't_kept1', title: 'Send the invoice', dueAt: null, done: false, createdAt: doneAt, source: { threadId: thread, messageId: `${thread}:Q1` } }
      expect((await browser.put(`/api/tasks/${task.id}`, task)).json.task).toEqual(task)
      await events.next((e) => e.type === 'task.updated' && e.task.id === task.id)

      // Signed out and in again: still done, and the task is still there.
      await browser.post('/api/auth/logout', {})
      expect((await browser.get('/api/inbox')).status).toBe(401)
      expect((await browser.post('/api/auth/login', { email: 'kept-state@example.com', password: 'long enough' })).status).toBe(200)
      const inbox = (await browser.get('/api/inbox')).json
      expect(byId(inbox.threads)[thread].doneAt).toBe(doneAt)
      expect(inbox.tasks).toEqual([task])

      // Ticked off, then deleted.
      expect((await browser.put(`/api/tasks/${task.id}`, { ...task, done: true })).json.task.done).toBe(true)
      expect((await browser.get('/api/inbox')).json.tasks[0].done).toBe(true)
      await browser.delete(`/api/tasks/${task.id}`)
      await events.next((e) => e.type === 'task.removed' && e.taskId === task.id)
      expect((await browser.get('/api/inbox')).json.tasks).toEqual([])

      // Snoozed: a new message from them brings it back; one from history doesn't.
      const until = new Date(Date.now() + 86_400_000).toISOString()
      expect((await browser.post(`/api/threads/${enc(thread)}/state`, { snoozedUntil: until })).json.thread).toMatchObject({ doneAt, snoozedUntil: until })
      socket.emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [{ key: { remoteJid: RAVI, fromMe: false, id: 'OLD' }, message: { conversation: 'From last year' }, messageTimestamp: ts - 86_400 * 300 }],
        isLatest: false,
        syncType: 6,
      } as never)
      await waitFor(async () => expect((await browser.get(`/api/threads/${enc(thread)}/messages?before=${enc(`${thread}:Q1`)}`)).json.messages.map((m: { id: string }) => m.id)).toContain(`${thread}:OLD`))
      expect((await threads(browser))[thread].snoozedUntil).toBe(until)
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: RAVI, fromMe: false, id: 'Q2' }, message: { conversation: 'Hello?' }, messageTimestamp: ts }],
      } as never)
      await waitFor(async () => expect((await threads(browser))[thread].snoozedUntil).toBeNull())

      // Undone.
      expect((await browser.post(`/api/threads/${enc(thread)}/state`, { doneAt: null })).json.thread.doneAt).toBeNull()
    })

    it('are checked, and only ever the owner\'s', async () => {
      const RAVI = '919812345678@s.whatsapp.net'
      const thread = `wa:${RAVI}`
      const owner = await newUser('kept-owner@example.com')
      const socket = await linkWhatsApp(owner)
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: RAVI, fromMe: false, id: 'X1' }, message: { conversation: 'Hi' }, messageTimestamp: Math.floor(Date.now() / 1000) }],
      } as never)
      await waitFor(async () => expect(byId((await owner.get('/api/inbox')).json.threads)[thread]).toBeDefined())

      expect((await owner.post(`/api/threads/${enc(thread)}/state`, { doneAt: 'yesterday' })).status).toBe(400)
      expect((await owner.post(`/api/threads/${enc('wa:nobody@s.whatsapp.net')}/state`, { doneAt: null })).status).toBe(404)
      const task = { title: 'X', dueAt: null, done: false, createdAt: new Date().toISOString(), source: { threadId: thread, messageId: 'm' } }
      expect((await owner.put('/api/tasks/bad id!', task)).status).toBe(400)
      expect((await owner.put('/api/tasks/t1', { ...task, source: undefined })).status).toBe(400)
      expect((await owner.put('/api/tasks/t1', { ...task, title: '' })).status).toBe(400)
      expect((await owner.put('/api/tasks/t1', { ...task, dueAt: 'soon' })).status).toBe(400)
      expect((await owner.put('/api/tasks/t1', task)).status).toBe(200)

      // Someone else can't see or change them.
      const stranger = await newUser('kept-stranger@example.com')
      expect((await stranger.post(`/api/threads/${enc(thread)}/state`, { doneAt: null })).status).toBe(404)
      expect((await stranger.put('/api/tasks/t1', task)).status).toBe(404)
      await stranger.delete('/api/tasks/t1')
      expect((await stranger.get('/api/inbox')).json.tasks).toEqual([])
      expect((await owner.get('/api/inbox')).json.tasks).toHaveLength(1)

      // Unlinking WhatsApp takes its tasks too.
      await owner.delete('/api/link/whatsapp')
      await waitFor(async () => expect((await owner.get('/api/inbox')).json.tasks).toEqual([]))
    })
  })

  describe('archiving chats', () => {
    const archive = (browser: Browser, threadId: string, archived: unknown) =>
      browser.post(`/api/threads/${enc(threadId)}/archive`, { archived })

    it('WhatsApp: archived here or on the phone, either way', async () => {
      const RAVI = '919812345678@s.whatsapp.net'
      const KIRAN = '919800011122@s.whatsapp.net'
      const NEHA = '919800033344@s.whatsapp.net'
      const browser = await newUser('archive-wa@example.com')
      const socket = await linkWhatsApp(browser)
      const events = await browser.events()
      const ts = Math.floor(Date.now() / 1000)
      socket.emit('messaging-history.set', {
        chats: [{ id: RAVI }, { id: KIRAN, archived: true }],
        contacts: [],
        messages: [
          { key: { remoteJid: RAVI, fromMe: false, id: 'R1' }, message: { conversation: 'Parcel arrived' }, messageTimestamp: ts - 60 },
          { key: { remoteJid: KIRAN, fromMe: false, id: 'K1' }, message: { conversation: 'Old offer' }, messageTimestamp: ts - 600 },
        ],
        isLatest: true,
        syncType: 0,
      } as never)
      const threads = async () => byId((await browser.get('/api/inbox')).json.threads)
      await waitFor(async () => expect((await threads())[`wa:${KIRAN}`]).toMatchObject({ archived: true }))
      expect((await threads())[`wa:${RAVI}`].archived).toBeUndefined()

      // Archived in Sytext: on WhatsApp too, with the chat's latest message as it asks (one it
      // knows the key of).
      const userId = new ObjectId((await browser.get('/api/auth/me')).json.user.id)
      await server.current().store.addMessage(userId, { id: `wa:${RAVI}:NOKEY`, threadId: `wa:${RAVI}`, senderId: 'me', body: 'Kept without a key', sentAt: new Date().toISOString() })
      const archived = await archive(browser, `wa:${RAVI}`, true)
      expect(archived.json.thread).toMatchObject({ id: `wa:${RAVI}`, archived: true })
      expect(socket.changes.at(-1)).toEqual({ jid: RAVI, change: 'archive', id: 'R1', archived: true })
      expect((await archive(browser, `wa:${RAVI}`, 'yes')).status).toBe(400)

      // Unarchived on the phone.
      socket.emit('chats.update', [{ id: RAVI, archived: false }] as never)
      await events.next((e) => e.type === 'thread.updated' && e.thread.id === `wa:${RAVI}` && !e.thread.archived)

      // Archived on the phone before any of its messages got here: it arrives archived.
      socket.emit('chats.update', [{ id: NEHA, archived: true }] as never)
      await new Promise((r) => setTimeout(r, 50))
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: NEHA, fromMe: false, id: 'N1' }, message: { conversation: 'Hi!' }, messageTimestamp: ts }],
      } as never)
      await waitFor(async () => expect((await threads())[`wa:${NEHA}`]).toMatchObject({ archived: true }))
      events.close()
      await browser.delete('/api/link/whatsapp')
    })

    it("Telegram: follows its Archive, and moves chats in and out of it", async () => {
      const tg = server.telegram
      tg.state.needsPassword = false
      tg.state.archived.add('-100777')
      const browser = await newUser('archive-tg@example.com')
      await browser.post('/api/link/telegram/code', { phone: '+91 90000 00012' })
      await browser.post('/api/link/telegram/verify', { code: '12345' })
      const threads = async () => byId((await browser.get('/api/inbox')).json.threads)
      await waitFor(async () => expect((await threads())['tga:-100777']).toMatchObject({ archived: true }))
      expect((await threads())['tga:5001'].archived).toBeUndefined()
      const events = await browser.events()

      expect((await archive(browser, 'tga:5001', true)).json.thread).toMatchObject({ archived: true })
      expect(tg.state.changes.at(-1)).toEqual({ chatId: '5001', change: 'archive', id: 0 })
      // Telegram takes it out of the Archive (a new message, or another device).
      tg.state.archived.delete('5001')
      tg.emit({ type: 'archived', chatId: '5001', archived: false })
      await events.next((e) => e.type === 'thread.updated' && e.thread.id === 'tga:5001' && !e.thread.archived)
      expect((await archive(browser, 'tga:-100777', false)).json.thread.archived).toBeUndefined()
      expect(tg.state.archived.size).toBe(0)

      // Archived in Telegram before its first message got here: it arrives archived.
      const newcomer = { id: '5999', kind: 'direct' as const, name: 'Meera' }
      tg.emit({ type: 'archived', chatId: newcomer.id, archived: true })
      tg.emit({ type: 'message', message: { id: 1, chat: newcomer, out: false, text: 'Hi!', date: Math.floor(Date.now() / 1000) } })
      await waitFor(async () => expect((await threads())['tga:5999']).toMatchObject({ archived: true }))
      events.close()
      await browser.delete('/api/link/telegram')
    })
  })

  describe('incognito mode', () => {
    it('reads and types without WhatsApp or Telegram showing it, until a read receipt is asked for', async () => {
      const RAVI = '919812345678@s.whatsapp.net'
      const tg = server.telegram
      tg.state.needsPassword = false
      const browser = await newUser('incognito@example.com')
      const socket = await linkWhatsApp(browser)
      await browser.post('/api/link/telegram/code', { phone: '+91 90000 00013' })
      await browser.post('/api/link/telegram/verify', { code: '12345' })
      const ts = Math.floor(Date.now() / 1000)
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: RAVI, fromMe: false, id: 'SEEN1' }, message: { conversation: 'Did you get my email?' }, messageTimestamp: ts }],
      } as never)
      const threads = async () => byId((await browser.get('/api/inbox')).json.threads)
      await waitFor(async () => {
        expect((await threads())[`wa:${RAVI}`]?.unreadCount).toBe(1)
        expect((await threads())['tga:5001']).toBeDefined()
      })

      // Turned on for the account: every device, and the server, go by it.
      expect((await browser.request('PATCH', '/api/me', { incognito: 'yes' })).status).toBe(400)
      expect((await browser.request('PATCH', '/api/me', {})).status).toBe(400)
      const otherDevice = await browser.events()
      const on = await browser.request('PATCH', '/api/me', { incognito: true })
      expect(on.json.user).toMatchObject({ incognito: true, name: expect.any(String) })
      // Other devices hear of it at once.
      await otherDevice.next((e) => e.type === 'user.updated' && e.user.incognito === true)
      otherDevice.close()
      expect((await browser.get('/api/auth/me')).json.user.incognito).toBe(true)

      const readBefore = { wa: socket.read.length, tg: tg.state.read.length }
      const presenceBefore = socket.presence.length
      const typingBefore = tg.state.typing.length
      expect((await browser.post(`/api/threads/${enc(`wa:${RAVI}`)}/read`)).json).toEqual({ ok: true, receipt: false })
      expect((await browser.post(`/api/threads/${enc('tga:5001')}/read`)).json.receipt).toBe(false)
      await browser.post(`/api/threads/${enc(`wa:${RAVI}`)}/typing`, { typing: true })
      await browser.post(`/api/threads/${enc('tga:5001')}/typing`, { typing: true })
      // Read in Sytext, on every device; nothing went to WhatsApp or Telegram.
      expect((await threads())[`wa:${RAVI}`].unreadCount).toBe(0)
      expect(socket.read.length).toBe(readBefore.wa)
      expect(tg.state.read.length).toBe(readBefore.tg)
      // (Subscribing to their typing notices tells them nothing.)
      expect(socket.presence.slice(presenceBefore).filter((p) => p.type !== 'subscribe')).toEqual([])
      expect(tg.state.typing.length).toBe(typingBefore)

      // Stopping typing always goes through (it may have started before Incognito was on).
      await browser.post(`/api/threads/${enc(`wa:${RAVI}`)}/typing`, { typing: false })
      expect(socket.presence.at(-1)).toMatchObject({ type: 'paused' })

      // WhatsApp still counts it unread, and says so: what was read here stays read, and only
      // what comes in after counts.
      socket.emit('chats.update', [{ id: RAVI, unreadCount: 1 }] as never)
      await new Promise((r) => setTimeout(r, 100))
      expect((await threads())[`wa:${RAVI}`].unreadCount).toBe(0)
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: RAVI, fromMe: false, id: 'SEEN2' }, message: { conversation: 'Hello??' }, messageTimestamp: ts + 5 }],
      } as never)
      await waitFor(async () => expect((await threads())[`wa:${RAVI}`].unreadCount).toBe(1))
      socket.emit('chats.update', [{ id: RAVI, unreadCount: 2 }] as never)
      await new Promise((r) => setTimeout(r, 100))
      expect((await threads())[`wa:${RAVI}`].unreadCount).toBe(1)

      // "Mark as read for them": a read receipt, asked for; one that can't go out says so.
      socket.failReads = true
      const failed = await browser.post(`/api/threads/${enc(`wa:${RAVI}`)}/read`, { receipt: true })
      expect(failed.status).toBe(502)
      socket.failReads = false
      expect((await browser.post(`/api/threads/${enc(`wa:${RAVI}`)}/read`, { receipt: true })).json.receipt).toBe(true)
      expect(socket.read.map((k) => k.id)).toEqual(expect.arrayContaining(['SEEN1', 'SEEN2']))
      // Told, WhatsApp's own counts are believed again.
      socket.emit('chats.update', [{ id: RAVI, unreadCount: 3 }] as never)
      await waitFor(async () => expect((await threads())[`wa:${RAVI}`].unreadCount).toBe(3))

      // Telegram, catching up on a message missed while the connection was down: Telegram counts
      // the one read here and the new one; only the new one counts here.
      expect((await threads())['tga:5001'].unreadCount).toBe(0)
      tg.ashaMessages.unshift({ id: 15, chat: tg.asha, out: false, text: 'Missed this one?', date: Math.floor(Date.now() / 1000) + 1 })
      tg.state.ashaUnread = 2
      try {
        await server.current().telegram.checkAll()
        expect((await threads())['tga:5001'].unreadCount).toBe(1)
      } finally {
        tg.ashaMessages.shift()
        tg.state.ashaUnread = 1
      }

      // Off again: reading sends read receipts as before.
      expect((await browser.request('PATCH', '/api/me', { incognito: false })).json.user.incognito).toBeUndefined()
      expect((await browser.post(`/api/threads/${enc('tga:5001')}/read`)).json.receipt).toBe(true)
      expect(tg.state.read.length).toBe(readBefore.tg + 1)
      await browser.delete('/api/link/whatsapp')
      await browser.delete('/api/link/telegram')
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
