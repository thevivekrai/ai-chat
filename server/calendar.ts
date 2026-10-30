import { randomBytes } from 'node:crypto'
import { Router, type Request } from 'express'
import type { ObjectId } from 'mongodb'
import type { SessionTokens } from './auth/tokens.ts'
import type { Sealer } from './crypto.ts'
import type { Collections } from './db.ts'
import { field, HttpError, rateLimit, requireUser, userIdOf } from './http.ts'

/**
 * Tasks on the user's Google Calendar.
 *
 * Connecting is Google's own consent screen, asking for one thing: to add and change events on
 * their calendars (`calendar.events`) — never to read anything else. Google gives back a refresh
 * token, kept sealed on the account like the network links, so tasks keep syncing on any device.
 * Each task becomes an event on the primary calendar (a dated one at its time, an undated one as
 * an all-day event the day it was made), changes when the task does, and goes when it's deleted.
 * Disconnecting revokes the access; the events already made stay where they are.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
const SCOPE = 'openid email https://www.googleapis.com/auth/calendar.events'
/** A dated task is a half-hour slot at its time. */
const EVENT_MINUTES = 30
/** How long the consent screen may take before its answer is no longer accepted. */
const STATE_TTL_MS = 15 * 60_000

export interface CalendarConfig {
  clientId: string
  clientSecret: string
  /** Tests stand in for Google. */
  fetch?: typeof fetch
}

/** What the browser learns: whether it's there, whether it's on, and if not, why. */
export interface CalendarStatus {
  available: boolean
  connected: boolean
  email?: string
  problem?: string
  /** The tasks that have an event already, so the browser sends over only the others. */
  synced?: string[]
}

const GONE = "Google stopped Sytext's access to your calendar. Connect it again to keep tasks in sync."
const BUSY = "Google Calendar didn't take that just now. The task will sync the next time it changes."

export function calendarRoutes({ col, tokens, sealer, config }: { col: Collections; tokens: SessionTokens; sealer: Sealer; config: CalendarConfig | null }): Router {
  const router = Router()
  const signedIn = requireUser(tokens, col.users)
  const call = config?.fetch ?? fetch
  // Access tokens last an hour; the refresh token makes new ones.
  const access = new Map<string, { token: string; until: number }>()
  const changes = rateLimit({ name: 'calendar', windowMs: 60_000, max: 120 })

  const redirectUri = (req: Request) => `${req.protocol}://${req.get('host')}/api/calendar/callback`
  const required = () => {
    if (!config) throw new HttpError(503, "This server isn't set up for Google Calendar (GOOGLE_CLIENT_SECRET).")
    return config
  }

  async function status(userId: ObjectId): Promise<CalendarStatus> {
    const user = await col.users.findOne({ _id: userId }, { projection: { calendar: 1 } })
    const c = user?.calendar
    return {
      available: !!config,
      connected: !!c?.refresh,
      ...(c?.refresh ? { synced: Object.keys(c.events ?? {}) } : {}),
      ...(c?.email ? { email: c.email } : {}),
      ...(c?.problem ? { problem: c.problem } : {}),
    }
  }

  /** Google's answer, read; refusals become messages the user can act on. */
  async function google(url: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
    let res: Response
    try {
      res = await call(url, init)
    } catch {
      throw new HttpError(503, BUSY)
    }
    const body = res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Record<string, unknown>)
    return { status: res.status, body }
  }

  async function tokenFor(userId: ObjectId, { fresh = false } = {}): Promise<string> {
    const key = userId.toHexString()
    const cached = access.get(key)
    if (cached && !fresh && cached.until > Date.now() + 60_000) return cached.token
    const user = await col.users.findOne({ _id: userId }, { projection: { calendar: 1 } })
    if (!user?.calendar?.refresh) throw new HttpError(409, 'Google Calendar is not connected.')
    const { clientId, clientSecret } = required()
    const { status: code, body } = await google(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: sealer.open(user.calendar.refresh),
        grant_type: 'refresh_token',
      }).toString(),
    })
    if (code === 400 || code === 401) {
      // Revoked in Google, or the password changed: only connecting again helps.
      await col.users.updateOne({ _id: userId }, { $set: { 'calendar.problem': GONE } })
      throw new HttpError(409, GONE)
    }
    if (code !== 200 || typeof body.access_token !== 'string') throw new HttpError(503, BUSY)
    const token = body.access_token
    access.set(key, { token, until: Date.now() + (Number(body.expires_in) || 3600) * 1000 })
    return token
  }

  /** A calendar call as the user: a token Google has stopped taking is renewed, once. */
  async function asUser(userId: ObjectId, url: string, init: RequestInit, retry = true): Promise<{ status: number; body: Record<string, unknown> }> {
    const token = await tokenFor(userId, { fresh: !retry })
    const answer = await google(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } })
    if (answer.status === 401 && retry) return asUser(userId, url, init, false)
    if (answer.status === 401 || (answer.status === 403 && /insufficient|scope/i.test(JSON.stringify(answer.body)))) {
      await col.users.updateOne({ _id: userId }, { $set: { 'calendar.problem': GONE } })
      throw new HttpError(409, GONE)
    }
    if (answer.status === 403 || answer.status === 429 || answer.status >= 500) throw new HttpError(503, BUSY)
    return answer
  }

  /** A task as an event: a half hour at its time, or all day on the day it was made. */
  function eventOf(task: { id: string; title: string; dueAt: string | null; done: boolean; createdAt: string; note?: string }) {
    const when = task.dueAt
      ? {
          start: { dateTime: new Date(task.dueAt).toISOString() },
          end: { dateTime: new Date(Date.parse(task.dueAt) + EVENT_MINUTES * 60_000).toISOString() },
        }
      : { start: { date: task.createdAt.slice(0, 10) }, end: { date: dayAfter(task.createdAt.slice(0, 10)) } }
    return {
      summary: `${task.done ? '✓ ' : ''}${task.title}`,
      description: [task.note, 'A task from Sytext.'].filter(Boolean).join('\n\n'),
      ...when,
      // Done ones go grey, so the day's open ones stand out.
      ...(task.done ? { colorId: '8' } : {}),
      extendedProperties: { private: { sytextTaskId: task.id } },
    }
  }

  router.get('/calendar', signedIn, async (_req, res) => {
    res.json(await status(userIdOf(res)))
  })

  /** Off to Google's consent screen; it comes back to the callback below. */
  router.get('/calendar/connect', signedIn, (req, res) => {
    const { clientId } = required()
    const state = sealer.sealJson({ u: userIdOf(res).toHexString(), n: randomBytes(8).toString('hex'), x: Date.now() + STATE_TTL_MS })
    const url = new URL(AUTH_URL)
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(req),
      response_type: 'code',
      scope: SCOPE,
      // A refresh token, every time: so syncing carries on without the app open.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    }).toString()
    res.redirect(url.toString())
  })

  router.get('/calendar/callback', signedIn, async (req, res) => {
    const userId = userIdOf(res)
    const back = (outcome: string) => res.redirect(`/tasks?calendar=${outcome}`)
    if (typeof req.query.error === 'string') return back('declined')
    let state: { u?: string; x?: number } = {}
    try {
      state = sealer.openJson(String(req.query.state ?? ''))
    } catch {
      return back('error')
    }
    // The answer is for this account, and from this consent screen, not an old or forged one.
    if (state.u !== userId.toHexString() || !state.x || state.x < Date.now()) return back('error')
    const { clientId, clientSecret } = required()
    const { status: code, body } = await google(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code ?? ''),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri(req),
        grant_type: 'authorization_code',
      }).toString(),
    })
    if (code !== 200 || typeof body.refresh_token !== 'string') return back('error')
    const email = emailIn(body.id_token)
    await col.users.updateOne(
      { _id: userId },
      { $set: { calendar: { refresh: sealer.seal(body.refresh_token), connectedAt: new Date(), ...(email ? { email } : {}), events: {} } } },
    )
    if (typeof body.access_token === 'string') {
      access.set(userId.toHexString(), { token: body.access_token, until: Date.now() + (Number(body.expires_in) || 3600) * 1000 })
    }
    back('connected')
  })

  /** A task created or changed: its event made, or brought up to date. */
  router.put('/calendar/tasks/:id', signedIn, changes, async (req, res) => {
    const userId = userIdOf(res)
    const id = String(req.params.id)
    if (!/^[\w-]{1,64}$/.test(id)) throw new HttpError(400, 'Bad task id.')
    const b = (req.body ?? {}) as Record<string, unknown>
    const task = {
      id,
      title: field(b, 'title', { max: 500 }),
      dueAt: typeof b.dueAt === 'string' && !Number.isNaN(Date.parse(b.dueAt)) ? b.dueAt : null,
      done: b.done === true,
      createdAt: typeof b.createdAt === 'string' && !Number.isNaN(Date.parse(b.createdAt)) ? b.createdAt : new Date().toISOString(),
      ...(typeof b.note === 'string' && b.note.trim() ? { note: b.note.trim().slice(0, 500) } : {}),
    }
    const user = await col.users.findOne({ _id: userId }, { projection: { calendar: 1 } })
    if (!user?.calendar?.refresh) throw new HttpError(409, 'Google Calendar is not connected.')
    const eventId = user.calendar.events?.[id]
    const event = JSON.stringify(eventOf(task))
    const json = { 'content-type': 'application/json' }
    let answer = eventId ? await asUser(userId, `${EVENTS_URL}/${encodeURIComponent(eventId)}`, { method: 'PUT', headers: json, body: event }) : null
    // Never made, or deleted in Google since: made (again).
    if (!answer || answer.status === 404 || answer.status === 410) {
      answer = await asUser(userId, EVENTS_URL, { method: 'POST', headers: json, body: event })
    }
    if (answer.status >= 300 || typeof answer.body.id !== 'string') throw new HttpError(502, BUSY)
    await col.users.updateOne({ _id: userId }, { $set: { [`calendar.events.${id}`]: answer.body.id }, $unset: { 'calendar.problem': '' } })
    res.json({ ok: true, eventId: answer.body.id })
  })

  /** A task deleted: its event goes too (already gone from Google is fine). */
  router.delete('/calendar/tasks/:id', signedIn, changes, async (req, res) => {
    const userId = userIdOf(res)
    const id = String(req.params.id)
    const user = await col.users.findOne({ _id: userId }, { projection: { calendar: 1 } })
    const eventId = user?.calendar?.events?.[id]
    if (user?.calendar?.refresh && eventId) {
      await asUser(userId, `${EVENTS_URL}/${encodeURIComponent(eventId)}`, { method: 'DELETE' })
      await col.users.updateOne({ _id: userId }, { $unset: { [`calendar.events.${id}`]: '' } })
    }
    res.json({ ok: true })
  })

  /** Stops syncing at once and revokes the access. The events made stay in the calendar. */
  router.delete('/calendar', signedIn, async (_req, res) => {
    const userId = userIdOf(res)
    const user = await col.users.findOne({ _id: userId }, { projection: { calendar: 1 } })
    access.delete(userId.toHexString())
    await col.users.updateOne({ _id: userId }, { $unset: { calendar: '' } })
    if (user?.calendar?.refresh && config) {
      // Best effort: already revoked in Google is the same outcome.
      await google(`${REVOKE_URL}?${new URLSearchParams({ token: sealer.open(user.calendar.refresh) })}`, { method: 'POST' }).catch(() => undefined)
    }
    res.json(await status(userId))
  })

  return router
}

function dayAfter(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** The address in the ID token Google sent along: it came straight from Google, over TLS. */
function emailIn(idToken: unknown): string | undefined {
  if (typeof idToken !== 'string') return undefined
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: unknown }
    return typeof payload.email === 'string' ? payload.email : undefined
  } catch {
    return undefined
  }
}
