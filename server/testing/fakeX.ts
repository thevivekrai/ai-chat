/**
 * A stand-in for x.com's DM endpoints, as the X bridge uses them: the inbox, sending, marking read,
 * the account's settings, and images. It checks what X checks: the session cookie, and that the
 * csrf header matches the ct0 cookie.
 */

import { PIXEL } from './helpers.ts'

export const ME = '1001'
export const MAYA = '2002'
export const ARJUN = '3003'
/** The one-to-one conversation with Maya, and a group, as X numbers them. */
export const MAYA_DM = `${MAYA}-${ME}`
export const GROUP_DM = '1700000000000000001'
/** The cookies a browser signed in to this account has. */
export const AUTH_TOKEN = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
export const CT0 = 'f00dfacef00dfacef00dfacef00dface'

interface FakeEntry {
  id: string
  conversation: string
  sender: string
  text: string
  time: number
  photo?: string
}

export function fakeX() {
  let next = 1_800_000_000_000_000_000n
  const nextId = () => String(++next)
  const users: Record<string, Record<string, unknown>> = {
    [ME]: { id_str: ME, name: 'Aarav Mehta', screen_name: 'aarav', profile_image_url_https: 'https://pbs.twimg.com/profile_images/1/me_normal.jpg' },
    [MAYA]: { id_str: MAYA, name: 'Maya Iyer', screen_name: 'mayaiyer', profile_image_url_https: 'https://pbs.twimg.com/profile_images/2/maya_normal.jpg' },
    [ARJUN]: { id_str: ARJUN, name: 'Arjun Rao', screen_name: 'arjunrao' },
  }
  const conversations: Record<string, { type: 'ONE_TO_ONE' | 'GROUP_DM'; participants: string[]; name?: string; lastRead: string }> = {
    [MAYA_DM]: { type: 'ONE_TO_ONE', participants: [ME, MAYA], lastRead: '0' },
    [GROUP_DM]: { type: 'GROUP_DM', participants: [ME, MAYA, ARJUN], name: 'Launch crew', lastRead: '0' },
  }
  const entries: FakeEntry[] = []

  const state = {
    /** X threw the session out. */
    signedOut: false,
    /** X wants the account to slow down. */
    rateLimited: false,
    /** X locked the account for a security check. */
    locked: false,
    /** x.com can't be reached. */
    down: false,
    sent: [] as { conversation: string; text: string }[],
    read: [] as { conversation: string; message: string }[],
  }

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const cookiesOf = (header: string) => Object.fromEntries(header.split(/;\s*/).filter(Boolean).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]))

  /** A new DM, as if someone wrote it on X. */
  function write(conversation: string, sender: string, text: string, { photo = false } = {}) {
    const entry: FakeEntry = { id: nextId(), conversation, sender, text, time: Date.now(), ...(photo ? { photo: `https://ton.x.com/i/ton/data/dm/${next}/photo.jpg` } : {}) }
    entries.push(entry)
    return entry
  }

  const entryJson = (e: FakeEntry) => ({
    message: {
      id: e.id,
      time: String(e.time),
      conversation_id: e.conversation,
      message_data: {
        id: e.id,
        time: String(e.time),
        sender_id: e.sender,
        text: e.photo ? `${e.text} https://t.co/abc123` : e.text,
        ...(e.photo ? { attachment: { photo: { media_url_https: e.photo } } } : {}),
      },
    },
  })

  const call = (async (input: string | URL | Request, init?: RequestInit) => {
    if (state.down) throw new Error('x.com is unreachable')
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    const cookies = cookiesOf(headers.cookie ?? '')

    if (url.hostname === 'pbs.twimg.com') return new Response(PIXEL, { headers: { 'content-type': 'image/png' } })
    if (url.hostname === 'ton.x.com') {
      // DM photos need the session.
      if (cookies.auth_token !== AUTH_TOKEN) return new Response('no', { status: 403 })
      return new Response(PIXEL, { headers: { 'content-type': 'image/jpeg' } })
    }

    if (!headers.authorization?.startsWith('Bearer ')) return json({ errors: [{ code: 215, message: 'Bad Authentication data.' }] }, 400)
    if (cookies.auth_token !== AUTH_TOKEN || state.signedOut) return json({ errors: [{ code: 32, message: 'Could not authenticate you.' }] }, 401)
    if (!cookies.ct0 || headers['x-csrf-token'] !== cookies.ct0) return json({ errors: [{ code: 353, message: 'This request requires a matching csrf cookie and header.' }] }, 403)
    if (state.locked) return json({ errors: [{ code: 326, message: 'To protect our users from spam…' }] }, 403)
    if (state.rateLimited) return json({ errors: [{ code: 88, message: 'Rate limit exceeded' }] }, 429)

    const path = url.pathname
    if (path === '/i/api/1.1/account/settings.json') return json({ screen_name: 'aarav' })

    if (path === '/i/api/1.1/dm/inbox_initial_state.json') {
      const latest = (id: string) => entries.filter((e) => e.conversation === id).at(-1)?.time ?? 0
      return json({
        inbox_initial_state: {
          entries: entries.map(entryJson),
          users,
          conversations: Object.fromEntries(
            Object.entries(conversations).map(([id, c]) => [
              id,
              {
                conversation_id: id,
                type: c.type,
                ...(c.name ? { name: c.name } : {}),
                sort_timestamp: String(latest(id)),
                participants: c.participants.map((user_id) => ({ user_id })),
                last_read_event_id: c.lastRead,
              },
            ]),
          ),
        },
      })
    }

    if (path === '/i/api/1.1/dm/new2.json') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { conversation_id?: string; text?: string }
      if (!body.conversation_id || !conversations[body.conversation_id]) return json({ errors: [{ code: 349, message: 'You cannot send messages to this user.' }] }, 403)
      const entry = write(body.conversation_id, ME, body.text ?? '')
      state.sent.push({ conversation: body.conversation_id, text: body.text ?? '' })
      return json({ entries: [entryJson(entry)] })
    }

    const read = /^\/i\/api\/1\.1\/dm\/conversation\/([^/]+)\/mark_read\.json$/.exec(path)
    if (read) {
      const conversation = decodeURIComponent(read[1]!)
      const message = new URLSearchParams(String(init?.body ?? '')).get('last_read_event_id') ?? ''
      if (conversations[conversation]) conversations[conversation].lastRead = message
      state.read.push({ conversation, message })
      return new Response(null, { status: 204 })
    }

    return json({ errors: [{ code: 34, message: 'Sorry, that page does not exist.' }] }, 404)
  }) as typeof fetch

  return { fetch: call, state, write, cookies: `auth_token=${AUTH_TOKEN}; ct0=${CT0}; twid=u%3D${ME}` }
}
