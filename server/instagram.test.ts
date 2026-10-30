import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GROUP_THREAD, ME, PRIYA, PRIYA_THREAD } from './testing/fakeInstagram.ts'
import { Browser, SIGN_UP, startTestServer, TEST_MONGODB_URI, waitFor, type TestServer } from './testing/helpers.ts'

const enc = encodeURIComponent
const byId = (list: { id: string }[]) => Object.fromEntries(list.map((t) => [t.id, t])) as Record<string, any>
const PRIYA_CHAT = `ig:${PRIYA_THREAD}`
const GROUP_CHAT = `ig:${GROUP_THREAD}`

describe.skipIf(!TEST_MONGODB_URI)('Instagram DMs', () => {
  let server: TestServer

  beforeAll(async () => {
    server = await startTestServer({ instagramCatchUpMs: 300 })
  })
  afterAll(() => server?.close())

  const newUser = async (email: string) => {
    const browser = new Browser(server.url)
    expect((await browser.post('/api/auth/register', { name: 'Aarav', email, password: 'long enough', ...SIGN_UP })).status).toBe(200)
    return browser
  }

  const link = (browser: Browser, password = server.instagram.state.password) =>
    browser.post('/api/link/instagram', { username: 'aarav.mehta', password })

  it('is offered, and says what Instagram says about a bad sign-in', async () => {
    const browser = await newUser('ig-login@example.com')
    expect((await browser.get('/api/config')).json.instagram).toBe(true)

    const wrong = await link(browser, 'not my password')
    expect(wrong.status).toBe(401)
    expect(wrong.json.error).toMatch(/password is wrong/i)
    expect((await browser.get('/api/accounts')).json.accounts).toEqual([])

    const unknown = await browser.post('/api/link/instagram', { username: 'nobody', password: 'whatever' })
    expect(unknown.json.error).toMatch(/doesn’t know that username|doesn't know that username/i)
  })

  it('answers a “was this you?” check itself', async () => {
    const ig = server.instagram
    const browser = await newUser('ig-delta@example.com')
    ig.state.checkpoint = 'delta'
    try {
      // Instagram asks about the sign-in rather than prompting anyone: it's this one, so it's
      // answered here and the link goes through without bothering the user.
      const linked = await link(browser)
      expect(linked.json.error ?? null).toBeNull()
      expect(linked.status).toBe(200)
      expect((await browser.get('/api/accounts')).json.accounts[0]).toMatchObject({ status: 'connected', label: '@aarav.mehta' })
    } finally {
      ig.state.checkpoint = false
    }
  })

  it('asks for the code Instagram sends to check a sign-in', async () => {
    const ig = server.instagram
    const browser = await newUser('ig-check-code@example.com')
    ig.state.checkpoint = 'code'
    ig.state.codeSent = false
    try {
      // No prompt arrives in the app for this: Instagram sends a code, and says where to.
      const asked = await link(browser)
      expect(asked.json).toEqual({ step: 'code', via: 'email' })
      expect(ig.state.codeSent).toBe(true)

      const wrong = await browser.post('/api/link/instagram/verify', { code: '000000' })
      expect(wrong.status).toBe(401)
      expect((await browser.get('/api/accounts')).json.accounts[0]).toMatchObject({ status: 'linking', step: 'code' })

      const verified = await browser.post('/api/link/instagram/verify', { code: ig.state.code })
      expect(verified.status).toBe(200)
      expect((await browser.get('/api/accounts')).json.accounts[0]).toMatchObject({ status: 'connected', label: '@aarav.mehta' })
    } finally {
      ig.state.checkpoint = false
      ig.state.codeSent = false
    }
  })

  it('says to clear a check it can’t answer in a browser', async () => {
    const ig = server.instagram
    const browser = await newUser('ig-checkpoint@example.com')
    ig.state.checkpoint = 'by-hand'
    try {
      const refused = await link(browser)
      expect(refused.status).toBe(409)
      expect(refused.json.error).toMatch(/security check Sytext can’t answer|can't answer/i)
      expect(refused.json.error).toMatch(/instagram\.com/i)
      // Nothing half-linked is left behind.
      expect((await browser.get('/api/accounts')).json.accounts).toEqual([])
    } finally {
      ig.state.checkpoint = false
    }
  })

  it('finds the token in the page’s own data when no cookie comes with it', async () => {
    const ig = server.instagram
    const browser = await newUser('ig-csrf@example.com')
    ig.state.csrfVia = 'shared_data'
    try {
      const result = await link(browser)
      expect(result.json.error ?? null).toBeNull()
      expect(result.status).toBe(200)
      expect((await browser.get('/api/accounts')).json.accounts[0]).toMatchObject({ status: 'connected', label: '@aarav.mehta' })
    } finally {
      ig.state.csrfVia = 'page'
    }
  })

  it('says so plainly when Instagram turns the server away', async () => {
    const ig = server.instagram
    const browser = await newUser('ig-blocked@example.com')
    ig.state.blocked = true
    try {
      const refused = await link(browser)
      expect(refused.status).toBe(502)
      expect(refused.json.error).toMatch(/turned this server away \(403\)/i)
      expect(refused.json.error).toMatch(/nothing to do with your password/i)
    } finally {
      ig.state.blocked = false
    }
  })

  it('links, brings the DMs in, and sends and receives', async () => {
    const ig = server.instagram
    ig.write(PRIYA_THREAD, PRIYA, 'Are the planters still available?')
    ig.write(GROUP_THREAD, PRIYA, 'Who is booking the cab?')
    const browser = await newUser('ig-chats@example.com')
    const events = await browser.events()

    const linked = await link(browser)
    expect(linked.status).toBe(200)
    expect(linked.json).toMatchObject({ username: 'aarav.mehta' })
    expect((await browser.get('/api/accounts')).json.accounts).toEqual([
      expect.objectContaining({ network: 'instagram', status: 'connected', label: '@aarav.mehta' }),
    ])

    const inbox = (await browser.get('/api/inbox')).json
    const threads = byId(inbox.threads)
    expect(threads[PRIYA_CHAT]).toMatchObject({ network: 'instagram', kind: 'direct', title: 'Priya Nair', unreadCount: 1 })
    expect(threads[GROUP_CHAT]).toMatchObject({ network: 'instagram', kind: 'group', title: 'Trip plans' })
    expect(inbox.messages.map((m: { body: string }) => m.body)).toContain('Are the planters still available?')
    expect(byId(inbox.contacts)[PRIYA_CHAT]).toMatchObject({ name: 'Priya Nair', handle: '@priya.makes', network: 'instagram' })
    // In a group, each person who wrote is their own contact, so names show on the messages.
    expect(byId(inbox.contacts)[`ig:u:${PRIYA}`]).toMatchObject({ name: 'Priya Nair' })

    // A reply reaches Instagram, and comes back as mine.
    const sent = await browser.post(`/api/threads/${enc(PRIYA_CHAT)}/messages`, { body: 'Yes — two left!' })
    expect(sent.status).toBe(200)
    expect(sent.json.message).toMatchObject({ threadId: PRIYA_CHAT, senderId: 'me', body: 'Yes — two left!' })
    expect(ig.state.sent.at(-1)).toEqual({ threadId: PRIYA_THREAD, text: 'Yes — two left!' })

    // Instagram has no stream, so a new message turns up on the next look.
    ig.write(PRIYA_THREAD, PRIYA, 'Brilliant, I’ll take both')
    const live = await events.next((e) => e.type === 'message.created' && e.message.body === 'Brilliant, I’ll take both')
    expect(live.message).toMatchObject({ threadId: PRIYA_CHAT, senderId: PRIYA_CHAT })

    // Opening the chat tells Instagram it was read.
    await browser.post(`/api/threads/${enc(PRIYA_CHAT)}/read`, {})
    expect(ig.state.seen.length).toBeGreaterThan(0)
    await waitFor(async () => expect(byId((await browser.get('/api/inbox')).json.threads)[PRIYA_CHAT].unreadCount).toBe(0))
  })

  it('carries photos in, through this server', async () => {
    const ig = server.instagram
    const browser = await newUser('ig-photos@example.com')
    ig.write(PRIYA_THREAD, PRIYA, '', { photo: true })
    expect((await link(browser)).status).toBe(200)

    const photo = (await browser.get('/api/inbox')).json.messages.find((m: { attachments?: unknown[] }) => m.attachments?.length)
    expect(photo.attachments[0]).toMatchObject({ kind: 'image', name: 'Photo' })
    // Fetched through Sytext, not straight from Instagram's servers.
    expect(photo.attachments[0].url).toMatch(/^\/api\/files\//)
    const file = await browser.raw('GET', photo.attachments[0].url)
    expect(file.status).toBe(200)
    expect(file.body.subarray(1, 4).toString()).toBe('PNG')

    // Sending one isn't there yet, and says so rather than failing oddly.
    const upload = await browser.raw('POST', `/api/threads/${enc(PRIYA_CHAT)}/files`, Buffer.from('a-photo'), {
      'X-File-Name': 'planter.jpg',
      'X-File-Type': 'image/jpeg',
    })
    expect(upload.status).toBe(415)
  })

  it('asks for the code Instagram sends, and links once it has it', async () => {
    const ig = server.instagram
    const browser = await newUser('ig-2fa@example.com')
    ig.state.twoFactor = true
    try {
      const asked = await link(browser)
      expect(asked.json).toEqual({ step: 'code', via: 'sms' })
      expect((await browser.get('/api/accounts')).json.accounts[0]).toMatchObject({ status: 'linking', step: 'code' })

      // A wrong code leaves the sign-in waiting rather than throwing it away.
      const wrong = await browser.post('/api/link/instagram/verify', { code: '000000' })
      expect(wrong.status).toBe(401)
      expect((await browser.get('/api/accounts')).json.accounts[0]).toMatchObject({ status: 'linking', step: 'code' })

      const verified = await browser.post('/api/link/instagram/verify', { code: ig.state.code })
      expect(verified.status).toBe(200)
      expect((await browser.get('/api/accounts')).json.accounts[0]).toMatchObject({ status: 'connected', label: '@aarav.mehta' })
      expect(byId((await browser.get('/api/inbox')).json.threads)[PRIYA_CHAT]).toBeDefined()
    } finally {
      ig.state.twoFactor = false
    }
  })

  it('says what Instagram cannot do here, rather than pretending', async () => {
    const browser = await newUser('ig-limits@example.com')
    expect((await link(browser)).status).toBe(200)
    const messageId = (await browser.get('/api/inbox')).json.messages.find((m: { threadId: string }) => m.threadId === PRIYA_CHAT)?.id
    expect(messageId).toBeTruthy()

    const react = await browser.post(`/api/threads/${enc(PRIYA_CHAT)}/reactions`, { messageId, emoji: '👍' })
    expect(react.status).toBe(409)
    const edit = await browser.post(`/api/threads/${enc(PRIYA_CHAT)}/message-actions`, { messageId, action: { type: 'edit', body: 'oops' } })
    expect(edit.status).toBe(409)
    const unsend = await browser.post(`/api/threads/${enc(PRIYA_CHAT)}/message-actions`, {
      messageId,
      action: { type: 'delete', forEveryone: true },
    })
    expect(unsend.status).toBe(409)

    // Starring and deleting for me are Sytext's own, so they work.
    const star = await browser.post(`/api/threads/${enc(PRIYA_CHAT)}/message-actions`, { messageId, action: { type: 'star', starred: true } })
    expect(star.json.message).toMatchObject({ starred: true })
    const older = await browser.get(`/api/threads/${enc(PRIYA_CHAT)}/messages?before=${enc(messageId)}`)
    expect(older.json).toEqual({ messages: [], hasMore: false })
  })

  it('stops and says so when Instagram throws the session out', async () => {
    const ig = server.instagram
    const browser = await newUser('ig-signedout@example.com')
    expect((await link(browser)).status).toBe(200)

    ig.state.signedOut = true
    try {
      await waitFor(async () => {
        const [account] = (await browser.get('/api/accounts')).json.accounts
        expect(account).toMatchObject({ network: 'instagram', status: 'disconnected' })
        expect(account.detail).toMatch(/signed this session out/i)
      })
      // Nothing keeps trying with a session Instagram has thrown away.
      expect((await browser.post(`/api/threads/${enc(PRIYA_CHAT)}/messages`, { body: 'hello?' })).status).toBe(409)
    } finally {
      ig.state.signedOut = false
    }
  })

  it('keeps going over a restart, and unlinks cleanly', async () => {
    const ig = server.instagram
    const browser = await newUser('ig-restart@example.com')
    expect((await link(browser)).status).toBe(200)
    await waitFor(async () => expect(byId((await browser.get('/api/inbox')).json.threads)[PRIYA_CHAT]).toBeDefined())

    // The saved session signs back in by itself: no password is kept, and none is needed.
    await server.restart()
    await waitFor(async () => expect((await browser.get('/api/accounts')).json.accounts[0]?.status).toBe('connected'))
    ig.write(PRIYA_THREAD, PRIYA, 'Still there?')
    await waitFor(async () =>
      expect((await browser.get('/api/inbox')).json.messages.map((m: { body: string }) => m.body)).toContain('Still there?'),
    )

    expect((await browser.delete('/api/link/instagram')).status).toBe(200)
    expect((await browser.get('/api/inbox')).json.threads).toEqual([])
    expect((await browser.get('/api/accounts')).json.accounts).toEqual([])
    expect((await browser.post(`/api/threads/${enc(PRIYA_CHAT)}/messages`, { body: 'hello?' })).status).toBe(404)
  })

  it('never keeps the password, only the session', async () => {
    const browser = await newUser('ig-secrets@example.com')
    expect((await link(browser)).status).toBe(200)
    const account = await server.database.col.accounts.findOne({ network: 'instagram' })
    expect(account?.session).toBeTruthy()
    expect(JSON.stringify(account)).not.toContain(server.instagram.state.password)
    expect(JSON.stringify(account)).not.toContain('sessionid')
    void ME
  })
})
