import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Browser, startTestServer, TEST_MONGODB_URI, waitFor, type TestServer } from './testing/helpers.ts'

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

    it('reports which features are switched on', async () => {
      const res = await new Browser(server.url).get('/api/config')
      expect(res.json).toEqual({ googleClientId: 'test-client.apps.googleusercontent.com', whatsapp: true, telegram: true, uploads: false })
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
        { network: 'telegram', status: 'linking', label: '+919876543210', detail: 'Enter the code Telegram sent to your Telegram app.' },
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
          { id: 'tga:5001', name: 'Asha Rao', network: 'telegram', handle: '@asha' },
          { id: 'tga:6002', name: 'Kabir', network: 'telegram', handle: '@kabir' },
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

    it('explains when linking fails', async () => {
      const browser = await newUser('wa2@example.com')
      expect((await browser.post('/api/link/whatsapp', { phone: '12' })).status).toBe(400)
    })
  })
})
