import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ASHA, KABIR } from './testing/fakeGuffshuff.ts'
import { Browser, startTestServer, TEST_MONGODB_URI, waitFor, type TestServer } from './testing/helpers.ts'

const enc = encodeURIComponent
const byId = (list: { id: string }[]) => Object.fromEntries(list.map((t) => [t.id, t])) as Record<string, any>
const ASHA_CHAT = `gs:${ASHA}`

describe.skipIf(!TEST_MONGODB_URI)('Guffshuff (the user’s own site)', () => {
  let server: TestServer

  beforeAll(async () => {
    server = await startTestServer()
  })
  afterAll(() => server?.close())

  const newUser = async (email: string) => {
    const browser = new Browser(server.url)
    expect((await browser.post('/api/auth/register', { name: 'Aarav', email, password: 'long enough', acceptedTerms: true })).status).toBe(200)
    return browser
  }

  const link = (browser: Browser, password = server.guffshuff.state.password) =>
    browser.post('/api/link/guffshuff', { username: 'aarav', password })

  it('is offered, and refuses a wrong password', async () => {
    const browser = await newUser('gs-login@example.com')
    expect((await browser.get('/api/config')).json.guffshuff).toBe(true)
    const wrong = await link(browser, 'not my password')
    expect(wrong.status).toBe(401)
    expect(wrong.json.error).toMatch(/password is incorrect/i)
    // Nothing is left behind by a failed sign-in.
    expect((await browser.get('/api/accounts')).json.accounts).toEqual([])
  })

  it('links, brings the chats in, and sends and receives', async () => {
    const gs = server.guffshuff
    gs.write(ASHA, 'Did the parcel arrive?')
    gs.write(KABIR, 'Notes for tomorrow?')
    const browser = await newUser('gs-chats@example.com')
    const events = await browser.events()

    const linked = await link(browser)
    expect(linked.status).toBe(200)
    expect(linked.json).toMatchObject({ username: 'aarav' })
    expect((await browser.get('/api/accounts')).json.accounts).toEqual([
      expect.objectContaining({ network: 'guffshuff', status: 'connected', label: '@aarav' }),
    ])

    // Both conversations arrive; the stranger who never wrote is not a chat.
    const inbox = (await browser.get('/api/inbox')).json
    const threads = byId(inbox.threads)
    expect(Object.keys(threads).sort()).toEqual([ASHA_CHAT, `gs:${KABIR}`])
    expect(threads[ASHA_CHAT]).toMatchObject({ network: 'guffshuff', kind: 'direct', title: 'Asha Rao', unreadCount: 1 })
    expect(inbox.messages.map((m: { body: string }) => m.body)).toContain('Did the parcel arrive?')
    expect(byId(inbox.contacts)[ASHA_CHAT]).toMatchObject({ name: 'Asha Rao', handle: '@asha', network: 'guffshuff' })

    // A reply goes to the site, and comes back as mine.
    const sent = await browser.post(`/api/threads/${enc(ASHA_CHAT)}/messages`, { body: 'Just now, thanks!' })
    expect(sent.status).toBe(200)
    expect(sent.json.message).toMatchObject({ threadId: ASHA_CHAT, senderId: 'me', body: 'Just now, thanks!' })
    expect(gs.state.sent.at(-1)).toEqual({ to: ASHA, text: 'Just now, thanks!' })

    // A message written on the site arrives live.
    gs.write(ASHA, 'Got it 🙏')
    const live = await events.next((e) => e.type === 'message.created' && e.message.body === 'Got it 🙏')
    expect(live.message).toMatchObject({ threadId: ASHA_CHAT, senderId: ASHA_CHAT })

    // Opening the chat tells the site it was read.
    await browser.post(`/api/threads/${enc(ASHA_CHAT)}/read`, {})
    expect(gs.state.reads).toContain(ASHA)
    await waitFor(async () => expect(byId((await browser.get('/api/inbox')).json.threads)[ASHA_CHAT].unreadCount).toBe(0))
  })

  it('carries photos both ways', async () => {
    const gs = server.guffshuff
    const browser = await newUser('gs-photos@example.com')
    expect((await link(browser)).status).toBe(200)

    gs.write(ASHA, 'Here it is', { image: gs.photoUrl })
    await waitFor(async () => {
      const photo = (await browser.get('/api/inbox')).json.messages.find((m: { body: string }) => m.body === 'Here it is')
      expect(photo?.attachments?.[0]).toMatchObject({ kind: 'image', name: 'Photo' })
      // The photo comes through this server, not straight from Guffshuff.
      expect(photo.attachments[0].url).toMatch(/^\/api\/files\//)
    })
    const photo = (await browser.get('/api/inbox')).json.messages.find((m: { body: string }) => m.body === 'Here it is')
    const file = await browser.raw('GET', photo.attachments[0].url)
    expect(file.status).toBe(200)
    expect(file.body.toString()).toBe('fake-image-bytes')

    // Sent the other way, as the site's own page does: a data URL it puts on its image host.
    const upload = await browser.raw('POST', `/api/threads/${enc(ASHA_CHAT)}/files`, Buffer.from('a-photo'), {
      'X-File-Name': 'parcel.jpg',
      'X-File-Type': 'image/jpeg',
      'X-Caption': 'Qm9va2VkIQ==',
    })
    expect(upload.status).toBe(200)
    expect(gs.state.sent.at(-1)!.image).toMatch(/^data:image\/jpeg;base64,/)

    // Guffshuff takes photos only.
    const pdf = await browser.raw('POST', `/api/threads/${enc(ASHA_CHAT)}/files`, Buffer.from('%PDF-1.4'), {
      'X-File-Name': 'quote.pdf',
      'X-File-Type': 'application/pdf',
    })
    expect(pdf.status).toBe(415)
  })

  it('says what Guffshuff cannot do, rather than pretending', async () => {
    const browser = await newUser('gs-limits@example.com')
    expect((await link(browser)).status).toBe(200)
    const messageId = (await browser.get('/api/inbox')).json.messages.find((m: { threadId: string }) => m.threadId === ASHA_CHAT)?.id
    expect(messageId).toBeTruthy()

    const react = await browser.post(`/api/threads/${enc(ASHA_CHAT)}/reactions`, { messageId, emoji: '👍' })
    expect(react.status).toBe(409)
    const edit = await browser.post(`/api/threads/${enc(ASHA_CHAT)}/message-actions`, { messageId, action: { type: 'edit', body: 'oops' } })
    expect(edit.status).toBe(409)
    const unsend = await browser.post(`/api/threads/${enc(ASHA_CHAT)}/message-actions`, { messageId, action: { type: 'delete', forEveryone: true } })
    expect(unsend.status).toBe(409)

    // Starring and deleting for me are Sytext's own, so they work.
    const star = await browser.post(`/api/threads/${enc(ASHA_CHAT)}/message-actions`, { messageId, action: { type: 'star', starred: true } })
    expect(star.json.message).toMatchObject({ starred: true })
    const mine = await browser.post(`/api/threads/${enc(ASHA_CHAT)}/message-actions`, { messageId, action: { type: 'delete', forEveryone: false } })
    expect(mine.json).toMatchObject({ removed: true })

    // The whole conversation is already here, so there is nothing older to fetch.
    const older = await browser.get(`/api/threads/${enc(ASHA_CHAT)}/messages?before=${enc(`${ASHA_CHAT}:m1`)}`)
    expect(older.json).toEqual({ messages: [], hasMore: false })
  })

  it('says in Settings when the site signs in but won\'t hand over its chats', async () => {
    const gs = server.guffshuff
    const browser = await newUser('gs-broken@example.com')
    gs.state.broken = ['/api/messages/users']
    try {
      // Signing in worked, so the link stands — but it says what went wrong, rather than
      // sitting there "connected" with an empty inbox.
      expect((await link(browser)).status).toBe(200)
      const [account] = (await browser.get('/api/accounts')).json.accounts
      expect(account).toMatchObject({ network: 'guffshuff', status: 'error', label: '@aarav' })
      expect(account.detail).toMatch(/answered with an error \(500\) for \/api\/messages\/users/)
      expect((await browser.get('/api/inbox')).json.threads).toEqual([])

      // Once the site answers again, the next look puts it right.
      gs.state.broken = []
      gs.write(ASHA, 'Back up')
      await waitFor(async () => expect((await browser.get('/api/accounts')).json.accounts[0]?.status).toBe('connected'))
      expect(byId((await browser.get('/api/inbox')).json.threads)[ASHA_CHAT]).toBeDefined()
    } finally {
      gs.state.broken = []
    }
  })

  it('still syncs when the site has no unread counts to give', async () => {
    const gs = server.guffshuff
    gs.write(KABIR, 'Notes?')
    const browser = await newUser('gs-nocounts@example.com')
    gs.state.broken = ['/api/messages/unread']
    try {
      expect((await link(browser)).status).toBe(200)
      const threads = byId((await browser.get('/api/inbox')).json.threads)
      // The chats are all there; only the badge is missing.
      expect(threads[`gs:${KABIR}`]).toMatchObject({ title: 'Kabir Shah', unreadCount: 0 })
      expect((await browser.get('/api/accounts')).json.accounts[0]).toMatchObject({ status: 'connected' })
    } finally {
      gs.state.broken = []
    }
  })

  it('stops asking for unread counts the site hasn’t got', async () => {
    // Its own server, so the catch-up comes round often enough to watch several syncs go by.
    const quick = await startTestServer({ guffshuffCatchUpMs: 300 })
    try {
      const gs = quick.guffshuff
      gs.write(ASHA, 'Anyone there?')
      const browser = new Browser(quick.url)
      expect((await browser.post('/api/auth/register', { name: 'Aarav', email: 'gs-quiet@example.com', password: 'long enough', acceptedTerms: true })).status).toBe(200)
      gs.state.broken = ['/api/messages/unread']
      expect((await browser.post('/api/link/guffshuff', { username: 'aarav', password: gs.state.password })).status).toBe(200)
      expect(gs.state.calls).toContain('GET /api/messages/unread')

      // Several catch-ups later it has read the chats again, but never asked for counts again:
      // one warning in the log, not one every couple of minutes.
      gs.state.calls.length = 0
      await waitFor(async () => expect(gs.state.calls.filter((c) => c === 'GET /api/messages/users').length).toBeGreaterThan(1))
      expect(gs.state.calls).not.toContain('GET /api/messages/unread')
    } finally {
      quick.guffshuff.state.broken = []
      await quick.close()
    }
  })

  it('doesn’t re-read every chat when the stream drops and comes back', async () => {
    const gs = server.guffshuff
    gs.write(ASHA, 'You there?')
    const browser = await newUser('gs-flap@example.com')
    expect((await link(browser)).status).toBe(200)
    await waitFor(async () => expect(byId((await browser.get('/api/inbox')).json.threads)[ASHA_CHAT]).toBeDefined())

    // Guffshuff on Render drops its websocket often; each return used to re-read the lot.
    gs.state.calls.length = 0
    gs.reconnect()
    gs.reconnect()
    gs.reconnect()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(gs.state.calls).toEqual([])

    // A message still comes through live, reconnected stream or not.
    const events = await browser.events()
    gs.write(ASHA, 'Right here')
    expect((await events.next((e) => e.type === 'message.created' && e.message.body === 'Right here')).message).toMatchObject({ threadId: ASHA_CHAT })
  })

  it('keeps a working link when a re-link is mistyped, and swaps the chats for another account', async () => {
    const gs = server.guffshuff
    gs.write(ASHA, 'Still here?')
    const browser = await newUser('gs-relink@example.com')
    expect((await link(browser)).status).toBe(200)
    await waitFor(async () => expect(byId((await browser.get('/api/inbox')).json.threads)[ASHA_CHAT]).toBeDefined())

    // A typo on a re-link: the old link carries on, chats and all.
    expect((await link(browser, 'wrong again')).status).toBe(401)
    expect(byId((await browser.get('/api/inbox')).json.threads)[ASHA_CHAT]).toBeDefined()
    expect((await browser.post(`/api/threads/${enc(ASHA_CHAT)}/messages`, { body: 'Yes!' })).status).toBe(200)

    // Linking a different Guffshuff account: the first account's chats aren't this one's.
    gs.state.username = 'someone-else'
    try {
      expect((await browser.post('/api/link/guffshuff', { username: 'someone-else', password: gs.state.password })).status).toBe(200)
      expect((await browser.get('/api/accounts')).json.accounts[0]).toMatchObject({ label: '@someone-else' })
      await waitFor(async () => expect((await browser.get('/api/inbox')).json.threads).toEqual([]))
    } finally {
      gs.state.username = 'aarav'
    }
  })

  it('signs itself in again when the weekly session runs out, and unlinks cleanly', async () => {
    const gs = server.guffshuff
    const browser = await newUser('gs-session@example.com')
    expect((await link(browser)).status).toBe(200)

    // A week later Guffshuff refuses the old cookie; the sealed password gets a new one.
    gs.expireSession()
    gs.writeQuietly(KABIR, 'Still on for Friday?')
    gs.state.calls.length = 0
    const sent = await browser.post(`/api/threads/${enc(`gs:${KABIR}`)}/messages`, { body: 'Yes!' })
    expect(sent.status).toBe(200)
    expect(gs.state.calls).toContain('POST /api/auth/login')
    expect(gs.state.sent.at(-1)).toEqual({ to: KABIR, text: 'Yes!' })

    // Unlinking logs out and takes its chats with it.
    expect((await browser.delete('/api/link/guffshuff')).status).toBe(200)
    expect((await browser.get('/api/inbox')).json.threads).toEqual([])
    expect((await browser.get('/api/accounts')).json.accounts).toEqual([])
    // And nothing listens any more.
    expect((await browser.post(`/api/threads/${enc(ASHA_CHAT)}/messages`, { body: 'hello?' })).status).toBe(404)
  })
})
