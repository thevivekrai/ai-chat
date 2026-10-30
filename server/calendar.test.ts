import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GOOD_CODE } from './testing/fakeCalendar.ts'
import { Browser, startTestServer, TEST_MONGODB_URI, type TestServer } from './testing/helpers.ts'

describe.skipIf(!TEST_MONGODB_URI)('tasks in Google Calendar', () => {
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

  /** Through Google's consent screen and back, as a browser would go. */
  const connect = async (browser: Browser) => {
    const start = await browser.visit('/api/calendar/connect')
    expect(start.status).toBe(302)
    const consent = new URL(start.headers.get('location')!)
    const back = await browser.visit(`/api/calendar/callback?code=${GOOD_CODE}&state=${encodeURIComponent(consent.searchParams.get('state')!)}`)
    return { consent, back }
  }

  const task = (id: string, extra: Record<string, unknown> = {}) => ({ title: 'Send the invoice', dueAt: null, done: false, createdAt: '2026-10-30T09:00:00.000Z', ...extra, id })

  it('asks Google for calendar events only, and comes back connected', async () => {
    const browser = await newUser('cal-connect@example.com')
    expect((await browser.get('/api/config')).json.calendar).toBe(true)
    expect((await browser.get('/api/calendar')).json).toEqual({ available: true, connected: false })

    const { consent, back } = await connect(browser)
    expect(consent.origin + consent.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(consent.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/calendar.events')
    expect(consent.searchParams.get('access_type')).toBe('offline')
    expect(consent.searchParams.get('redirect_uri')).toMatch(/\/api\/calendar\/callback$/)
    expect(back.headers.get('location')).toBe('/tasks?calendar=connected')
    expect((await browser.get('/api/calendar')).json).toEqual({ available: true, connected: true, email: 'aarav@gmail.com', synced: [] })

    // The refresh token is kept sealed, never as it is.
    const user = await server.database.col.users.findOne({ email: 'cal-connect@example.com' })
    expect(user?.calendar?.refresh).toBeTruthy()
    expect(user?.calendar?.refresh).not.toContain('rt-1')
  })

  it('turns away an answer that isn’t this account’s, or a refusal', async () => {
    const alice = await newUser('cal-alice@example.com')
    const mallory = await newUser('cal-mallory@example.com')
    const { consent } = await connect(alice).then(async (r) => r)
    // Mallory replays Alice's consent answer in her own session: refused.
    const replay = await mallory.visit(`/api/calendar/callback?code=${GOOD_CODE}&state=${encodeURIComponent(consent.searchParams.get('state')!)}`)
    expect(replay.headers.get('location')).toBe('/tasks?calendar=error')
    expect((await mallory.get('/api/calendar')).json.connected).toBe(false)
    // Saying no on Google's screen comes back as just that.
    expect((await mallory.visit('/api/calendar/callback?error=access_denied')).headers.get('location')).toBe('/tasks?calendar=declined')
    // Not signed in: nothing.
    expect((await new Browser(server.url).visit('/api/calendar/connect')).status).toBe(401)
  })

  it('keeps each task as an event, up to date, and deletes it with the task', async () => {
    const browser = await newUser('cal-sync@example.com')
    await connect(browser)
    const events = server.calendar.state.events

    // A dated task: a half hour at its time.
    const made = await browser.put('/api/calendar/tasks/t1', task('t1', { dueAt: '2026-11-02T10:00:00.000Z', note: 'From the chat with Ravi' }))
    expect(made.status).toBe(200)
    const eventId = made.json.eventId as string
    expect(events.get(eventId)).toMatchObject({
      summary: 'Send the invoice',
      start: { dateTime: '2026-11-02T10:00:00.000Z' },
      end: { dateTime: '2026-11-02T10:30:00.000Z' },
      extendedProperties: { private: { sytextTaskId: 't1' } },
    })
    expect(events.get(eventId)!.description).toContain('From the chat with Ravi')
    expect((await browser.get('/api/calendar')).json.synced).toEqual(['t1'])

    // Done: the same event, ticked and greyed — not a second one.
    await browser.put('/api/calendar/tasks/t1', task('t1', { dueAt: '2026-11-02T10:00:00.000Z', done: true }))
    expect(events.size).toBe(1)
    expect(events.get(eventId)).toMatchObject({ summary: '✓ Send the invoice', colorId: '8' })

    // An undated task: all day, the day it was made.
    const allDay = await browser.put('/api/calendar/tasks/t2', task('t2', { title: 'Call the bank' }))
    expect(events.get(allDay.json.eventId)).toMatchObject({ start: { date: '2026-10-30' }, end: { date: '2026-10-31' } })

    // Deleted in Google meanwhile: the next change makes it again.
    events.delete(eventId)
    const again = await browser.put('/api/calendar/tasks/t1', task('t1', { title: 'Send the invoice again' }))
    expect(events.get(again.json.eventId)).toMatchObject({ summary: 'Send the invoice again' })

    // The task deleted: so is its event.
    expect((await browser.delete('/api/calendar/tasks/t2')).status).toBe(200)
    expect(events.has(allDay.json.eventId)).toBe(false)
  })

  it('says so when Google stops the access, or is busy', async () => {
    const browser = await newUser('cal-errors@example.com')
    await connect(browser)
    const state = server.calendar.state

    state.busy = true
    try {
      const busy = await browser.put('/api/calendar/tasks/t1', task('t1'))
      expect(busy.status).toBe(503)
      expect(busy.json.error).toMatch(/next time it changes/)
    } finally {
      state.busy = false
    }

    state.refreshValid = false
    try {
      // Revoked in Google: a fresh token can't be had, and the account says why.
      await server.restart()
      const refused = await browser.put('/api/calendar/tasks/t1', task('t1'))
      expect(refused.status).toBe(409)
      expect((await browser.get('/api/calendar')).json.problem).toMatch(/Connect it again/)
    } finally {
      state.refreshValid = true
    }
  })

  it('stops at once on disconnect, revokes the access, and leaves the events', async () => {
    const browser = await newUser('cal-off@example.com')
    await connect(browser)
    const made = await browser.put('/api/calendar/tasks/t9', task('t9'))
    expect((await browser.delete('/api/calendar')).json).toEqual({ available: true, connected: false })
    expect(server.calendar.state.revoked).toContain('rt-1')
    expect(server.calendar.state.events.has(made.json.eventId)).toBe(true)
    // Nothing more is synced.
    expect((await browser.put('/api/calendar/tasks/t9', task('t9', { done: true }))).status).toBe(409)
  })
})
