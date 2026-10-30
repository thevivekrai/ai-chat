import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ARJUN, AUTH_TOKEN, CT0, GROUP_DM, MAYA, MAYA_DM, ME } from './testing/fakeX.ts'
import { Browser, SIGN_UP, startTestServer, TEST_MONGODB_URI, waitFor, type TestServer } from './testing/helpers.ts'

const enc = encodeURIComponent
const byId = (list: { id: string }[]) => Object.fromEntries(list.map((t) => [t.id, t])) as Record<string, any>
const MAYA_CHAT = `x:${MAYA_DM}`
const GROUP_CHAT = `x:${GROUP_DM}`

describe.skipIf(!TEST_MONGODB_URI)('X (Twitter) DMs', () => {
  let server: TestServer

  beforeAll(async () => {
    server = await startTestServer({ xCatchUpMs: 300 })
  })
  afterAll(() => server?.close())

  const newUser = async (email: string) => {
    const browser = new Browser(server.url)
    expect((await browser.post('/api/auth/register', { name: 'Aarav', email, password: 'long enough', ...SIGN_UP })).status).toBe(200)
    return browser
  }
  const link = (browser: Browser, cookies = server.x.cookies) => browser.post('/api/link/x', { cookies })

  it('is offered, and takes only a real session from the browser', async () => {
    const browser = await newUser('x-login@example.com')
    expect((await browser.get('/api/config')).json.x).toBe(true)

    expect((await link(browser, `auth_token=${AUTH_TOKEN}`)).json.error).toMatch(/auth_token.*ct0/)
    const stale = await link(browser, `auth_token=${'0'.repeat(40)}; ct0=${CT0}`)
    expect(stale.status).toBe(401)
    expect(stale.json.error).toMatch(/didn't accept those cookies/)
    // Only cookie characters: nothing smuggled into the request's headers.
    expect((await link(browser, `auth_token=${AUTH_TOKEN}"X-Evil: 1; ct0=${CT0}`)).status).toBe(400)
    expect((await browser.get('/api/accounts')).json.accounts).toEqual([])
  })

  it('links, brings the DMs in, and sends, reads and shows photos', async () => {
    const x = server.x
    x.write(MAYA_DM, MAYA, 'Are we still on for Friday?')
    x.write(GROUP_DM, ARJUN, 'Launch moved to Monday', { photo: true })
    const browser = await newUser('x-chats@example.com')

    // As the browser's tools copy them, one per line, with no twid: whoever it is comes from X.
    const linked = await link(browser, `auth_token=${AUTH_TOKEN}\nct0=${CT0}`)
    expect(linked.json).toEqual({ username: 'aarav', fullName: 'Aarav Mehta' })
    expect((await browser.get('/api/accounts')).json.accounts).toEqual([expect.objectContaining({ network: 'x', status: 'connected', label: '@aarav' })])

    const inbox = (await browser.get('/api/inbox')).json
    const threads = byId(inbox.threads)
    expect(threads[MAYA_CHAT]).toMatchObject({ network: 'x', kind: 'direct', title: 'Maya Iyer', unreadCount: 1 })
    expect(threads[GROUP_CHAT]).toMatchObject({ network: 'x', kind: 'group', title: 'Launch crew' })
    const contacts = byId(inbox.contacts)
    expect(contacts[MAYA_CHAT]).toMatchObject({ name: 'Maya Iyer', handle: '@mayaiyer', network: 'x' })
    expect(contacts[`x:u:${ARJUN}`]).toMatchObject({ name: 'Arjun Rao' })

    // The photo's t.co link isn't left in the text; the photo comes through this server.
    const photoMessage = inbox.messages.find((m: { threadId: string }) => m.threadId === GROUP_CHAT)
    expect(photoMessage.body).toBe('Launch moved to Monday')
    const photo = await browser.raw('GET', photoMessage.attachments[0].url)
    expect(photo.status).toBe(200)
    expect(photo.headers.get('content-type')).toBe('image/jpeg')

    // A reply goes out to X at once.
    const sent = await browser.post(`/api/threads/${enc(MAYA_CHAT)}/messages`, { body: 'Yes, 7pm!' })
    expect(sent.json.message).toMatchObject({ body: 'Yes, 7pm!', senderId: 'me', status: 'sent' })
    expect(x.state.sent).toContainEqual({ conversation: MAYA_DM, text: 'Yes, 7pm!' })

    // Reading it here tells X.
    expect((await browser.post(`/api/threads/${enc(MAYA_CHAT)}/read`, {})).status).toBe(200)
    await waitFor(async () => expect(x.state.read.map((r) => r.conversation)).toContain(MAYA_DM))

    // A new DM arrives within a look.
    const events = await browser.events()
    x.write(MAYA_DM, MAYA, 'Great, see you')
    await waitFor(async () => expect(events.received.some((e) => e.type === 'message.created' && e.message?.body === 'Great, see you')).toBe(true))
    events.close()

    // Kept sealed: the cookies are nowhere in the database as they are.
    const stored = JSON.stringify(await server.database.col.accounts.findOne({ network: 'x', label: '@aarav' }))
    expect(stored).not.toContain(AUTH_TOKEN)
    await browser.delete('/api/link/x')
  })

  it('says what it cannot do on X, rather than pretending', async () => {
    const browser = await newUser('x-limits@example.com')
    expect((await link(browser)).status).toBe(200)
    const messageId = (await browser.get('/api/inbox')).json.messages.find((m: { threadId: string }) => m.threadId === MAYA_CHAT)?.id
    expect((await browser.post(`/api/threads/${enc(MAYA_CHAT)}/reactions`, { messageId, emoji: '👍' })).status).toBe(409)
    expect(
      (await browser.post(`/api/threads/${enc(MAYA_CHAT)}/message-actions`, { messageId, action: { type: 'delete', forEveryone: true } })).status,
    ).toBe(409)
    const star = await browser.post(`/api/threads/${enc(MAYA_CHAT)}/message-actions`, { messageId, action: { type: 'star', starred: true } })
    expect(star.json.message).toMatchObject({ starred: true })
    await browser.delete('/api/link/x')
  })

  it('says so when X slows the account down, and stops when X signs it out', async () => {
    const x = server.x
    const browser = await newUser('x-trouble@example.com')
    expect((await link(browser)).status).toBe(200)

    x.state.rateLimited = true
    try {
      await waitFor(async () => {
        const [account] = (await browser.get('/api/accounts')).json.accounts
        expect(account).toMatchObject({ status: 'error' })
        expect(account.detail).toMatch(/slow down/)
      })
    } finally {
      x.state.rateLimited = false
    }
    await waitFor(async () => expect((await browser.get('/api/accounts')).json.accounts[0].status).toBe('connected'))

    x.state.signedOut = true
    try {
      await waitFor(async () => {
        const [account] = (await browser.get('/api/accounts')).json.accounts
        expect(account).toMatchObject({ network: 'x', status: 'disconnected' })
        expect(account.detail).toMatch(/signed this session out/)
      })
      expect((await browser.post(`/api/threads/${enc(MAYA_CHAT)}/messages`, { body: 'hello?' })).status).toBe(409)
    } finally {
      x.state.signedOut = false
    }
    await browser.delete('/api/link/x')
  })

  it('keeps going over a restart, and unlinks cleanly', async () => {
    const browser = await newUser('x-restart@example.com')
    expect((await link(browser)).status).toBe(200)
    await server.restart()
    await waitFor(async () => expect((await browser.get('/api/accounts')).json.accounts[0]?.status).toBe('connected'))
    server.x.write(MAYA_DM, MAYA, 'Back online?')
    await waitFor(async () => expect((await browser.get('/api/inbox')).json.messages.map((m: { body: string }) => m.body)).toContain('Back online?'))

    expect((await browser.delete('/api/link/x')).status).toBe(200)
    expect((await browser.get('/api/inbox')).json.threads.filter((t: { id: string }) => t.id.startsWith('x:'))).toEqual([])
    expect((await browser.get('/api/accounts')).json.accounts).toEqual([])
    void ME
  })
})
