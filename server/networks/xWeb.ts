import { randomUUID } from 'node:crypto'
import { HttpError } from '../http.ts'

/**
 * X (Twitter) direct messages, through the web API x.com's own Messages page uses.
 *
 * X's official API sells DM access by the month, and only to developer apps acting for their own
 * users, so a person's inbox can't be reached that way. Like other open bridges (mautrix-twitter),
 * this uses the session of the user's own browser: they sign in on x.com, where X's security
 * checks reach them, and hand over its cookies. Nothing here signs in with a password.
 *
 * X doesn't support this, and its endpoints change without notice: every answer is turned into
 * something the user can act on.
 */

const BASE = 'https://x.com'
/**
 * The web app's own public token, the one every visitor's browser sends with these calls (it's in
 * x.com's scripts). It identifies the app, not a person: the cookies are what sign in.
 */
const WEB_APP_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

export interface XUser {
  id: string
  name: string
  handle: string
  pictureUrl?: string
}

export interface XMessage {
  id: string
  senderId: string
  text: string
  sentAt: number
  photoUrl?: string
}

export interface XConversation {
  id: string
  group: boolean
  title?: string
  people: XUser[]
  /** Oldest first. */
  messages: XMessage[]
  lastAt: number
  unread: number
}

/** One signed-in account. `save()` is sealed and kept, so a restart needs nothing from the user. */
export interface XSession {
  save(): string
  /** The conversations with their latest messages, and who this is. */
  inbox(): Promise<{ me: XUser; conversations: XConversation[] }>
  sendText(conversationId: string, text: string): Promise<XMessage>
  markRead(conversationId: string, messageId: string): Promise<void>
  /** A profile picture or a photo in a DM (those need the session to be fetched). */
  fetchImage(url: string): Promise<{ data: Buffer; contentType: string } | null>
}

/** X, as the bridge talks to it. Tests stand in for this. */
export interface XSite {
  /** A session from the cookies of the user's own browser, checked before it's taken. */
  fromBrowser(cookies: string): Promise<XSession>
  /** A session from what `save()` gave. */
  restore(saved: string): XSession
}

interface Saved {
  jar: Record<string, string>
}

/**
 * The cookies pasted from a browser: "auth_token=…; ct0=…" (as the browser's tools copy a cookie
 * line), or the two values on their own lines. Only X's own session cookies are taken, and only
 * cookie characters, so nothing pasted can reach a request's headers.
 */
export function xCookies(text: string): Record<string, string> {
  const wanted = new Set(['auth_token', 'ct0', 'twid', 'kdt', 'att'])
  const jar: Record<string, string> = {}
  for (const pair of text.trim().replace(/^cookie:\s*/i, '').split(/[;\n]\s*/)) {
    const at = pair.indexOf('=')
    if (at < 1) continue
    const name = pair.slice(0, at).trim()
    const value = pair.slice(at + 1).trim()
    if (wanted.has(name) && value && /^[\w%.:-]+$/.test(value)) jar[name] = value
  }
  return jar
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
/** Message ids are ordered numbers, too big for a JavaScript number. */
const later = (a: string, b: string | undefined) => !b || (a.length !== b.length ? a.length > b.length : a > b)

export function createXWeb({ fetch: call = fetch, baseUrl = BASE }: { fetch?: typeof fetch; baseUrl?: string } = {}): XSite {
  const cookieHeader = (jar: Saved['jar']) =>
    Object.entries(jar)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')

  async function request(state: Saved, path: string, init: { method?: string; json?: unknown; form?: Record<string, string> } = {}) {
    let res: Response
    try {
      res = await call(`${baseUrl}${path}`, {
        method: init.method ?? (init.json || init.form ? 'POST' : 'GET'),
        headers: {
          'user-agent': USER_AGENT,
          accept: '*/*',
          authorization: `Bearer ${WEB_APP_TOKEN}`,
          'x-csrf-token': state.jar.ct0 ?? '',
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-active-user': 'yes',
          'x-twitter-client-language': 'en',
          referer: `${baseUrl}/messages`,
          cookie: cookieHeader(state.jar),
          ...(init.json ? { 'content-type': 'application/json' } : {}),
          ...(init.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(init.json ? { body: JSON.stringify(init.json) } : {}),
        ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
      })
    } catch {
      throw new HttpError(503, "Couldn't reach X.")
    }
    // X turns the csrf token over now and then; the new one goes with the next call.
    for (const header of res.headers.getSetCookie?.() ?? []) {
      const m = /^ct0=([^;]+)/.exec(header)
      if (m) state.jar.ct0 = m[1]!
    }
    let body: Record<string, unknown> = {}
    try {
      body = (await res.json()) as Record<string, unknown>
    } catch {
      // Not JSON: a block or login page. The status says enough.
    }
    const codes = Array.isArray(body.errors) ? body.errors.map((e) => (e as { code?: number }).code) : []
    if (res.status === 401 || codes.includes(32) || codes.includes(89)) {
      throw new HttpError(401, 'X signed this session out. Link X again with fresh cookies from your browser.')
    }
    if (res.status === 403 && codes.includes(353)) {
      throw new HttpError(401, "X didn't accept the session's ct0 token. Copy both auth_token and ct0 again from your browser.")
    }
    if (res.status === 429 || codes.includes(88)) throw new HttpError(429, 'X is asking this account to slow down. It will try again in a while.')
    if (res.status === 403 && codes.includes(326)) {
      throw new HttpError(409, 'X locked this account for a security check. Open x.com, clear it there, then link again.')
    }
    if (!res.ok) throw new HttpError(502, `X answered with an error (${res.status}) for ${path.split('?')[0]}.`)
    return body
  }

  function personOf(raw: unknown): XUser | null {
    const u = (raw ?? {}) as Record<string, unknown>
    const id = str(u.id_str) ?? (typeof u.id === 'number' ? String(u.id) : undefined)
    const handle = str(u.screen_name)
    if (!id || !handle) return null
    const picture = str(u.profile_image_url_https)
    return { id, name: str(u.name) ?? handle, handle, ...(picture ? { pictureUrl: picture.replace('_normal.', '_200x200.') } : {}) }
  }

  function session(state: Saved): XSession {
    /** Who this is: from the twid cookie when the browser gave it, otherwise from the account's settings. */
    async function whoAmI(users: Map<string, XUser>): Promise<XUser> {
      const fromCookie = /u%3D(\d+)|u=(\d+)/.exec(state.jar.twid ?? '')
      const id = fromCookie?.[1] ?? fromCookie?.[2]
      if (id && users.has(id)) return users.get(id)!
      const settings = await request(state, '/i/api/1.1/account/settings.json')
      const handle = str(settings.screen_name)
      const me = [...users.values()].find((u) => u.handle.toLowerCase() === handle?.toLowerCase())
      if (me) return me
      if (handle) return { id: id ?? handle, name: handle, handle }
      throw new HttpError(502, "X didn't say whose inbox that is.")
    }

    return {
      save: () => JSON.stringify(state),

      async inbox() {
        const query = new URLSearchParams({
          nsfw_filtering_enabled: 'false',
          filter_low_quality: 'false',
          include_quality: 'all',
          dm_users: 'true',
          include_groups: 'true',
          include_inbox_timelines: 'true',
          supports_reactions: 'true',
          count: '50',
        })
        const body = await request(state, `/i/api/1.1/dm/inbox_initial_state.json?${query.toString()}`)
        const inbox = (body.inbox_initial_state ?? {}) as Record<string, unknown>
        const users = new Map<string, XUser>()
        for (const raw of Object.values((inbox.users ?? {}) as Record<string, unknown>)) {
          const person = personOf(raw)
          if (person) users.set(person.id, person)
        }
        const me = await whoAmI(users)

        const byConversation = new Map<string, XMessage[]>()
        for (const entry of Array.isArray(inbox.entries) ? inbox.entries : []) {
          const message = (entry as { message?: Record<string, unknown> }).message
          const data = (message?.message_data ?? {}) as Record<string, unknown>
          const conversationId = str(message?.conversation_id)
          const id = str(data.id) ?? str(message?.id)
          const senderId = str(data.sender_id)
          if (!conversationId || !id || !senderId) continue
          const photo = ((data.attachment as Record<string, unknown> | undefined)?.photo ?? {}) as Record<string, unknown>
          const photoUrl = str(photo.media_url_https)
          // A photo's link is part of its text on X; the photo itself stands for it.
          const text = (str(data.text) ?? '').replace(photoUrl ? /\s*https:\/\/t\.co\/\w+\s*$/ : /$^/, '')
          const list = byConversation.get(conversationId) ?? []
          list.push({ id, senderId, text, sentAt: Number(str(data.time) ?? str(message?.time) ?? 0) || Date.now(), ...(photoUrl ? { photoUrl } : {}) })
          byConversation.set(conversationId, list)
        }

        const conversations: XConversation[] = []
        for (const raw of Object.values((inbox.conversations ?? {}) as Record<string, unknown>)) {
          const c = raw as Record<string, unknown>
          const id = str(c.conversation_id)
          if (!id) continue
          const people = (Array.isArray(c.participants) ? c.participants : [])
            .map((p) => users.get(String((p as { user_id?: unknown }).user_id)))
            .filter((p): p is XUser => !!p)
          const messages = (byConversation.get(id) ?? []).sort((a, b) => a.sentAt - b.sentAt)
          const lastRead = str(c.last_read_event_id)
          const unread = messages.filter((m) => m.senderId !== me.id && later(m.id, lastRead)).length
          conversations.push({
            id,
            group: c.type === 'GROUP_DM',
            ...(str(c.name) ? { title: str(c.name) } : {}),
            people,
            messages,
            lastAt: Number(str(c.sort_timestamp) ?? 0) || messages.at(-1)?.sentAt || 0,
            unread,
          })
        }
        conversations.sort((a, b) => b.lastAt - a.lastAt)
        return { me, conversations }
      },

      async sendText(conversationId, text) {
        const body = await request(state, '/i/api/1.1/dm/new2.json?include_cards=1&dm_users=false', {
          json: { conversation_id: conversationId, recipient_ids: false, request_id: randomUUID(), text, cards_platform: 'Web-12', include_cards: 1 },
        })
        const entry = (Array.isArray(body.entries) ? body.entries[0] : undefined) as { message?: Record<string, unknown> } | undefined
        const data = (entry?.message?.message_data ?? {}) as Record<string, unknown>
        const id = str(data.id) ?? str(entry?.message?.id)
        if (!id) throw new HttpError(502, "X didn't accept the message.")
        return { id, senderId: str(data.sender_id) ?? '', text, sentAt: Number(str(data.time)) || Date.now() }
      },

      async markRead(conversationId, messageId) {
        await request(state, `/i/api/1.1/dm/conversation/${encodeURIComponent(conversationId)}/mark_read.json`, {
          form: { conversationId, last_read_event_id: messageId },
        })
      },

      async fetchImage(url) {
        // Only X's own image hosts, and the session's cookies only to the one that needs them.
        let host: string
        try {
          host = new URL(url).hostname
        } catch {
          return null
        }
        if (!/(^|\.)twimg\.com$|^ton\.(x|twitter)\.com$/.test(host)) return null
        try {
          const res = await call(url, {
            headers: { 'user-agent': USER_AGENT, ...(host.startsWith('ton.') ? { cookie: cookieHeader(state.jar), referer: `${baseUrl}/` } : {}) },
          })
          const contentType = res.headers.get('content-type') ?? ''
          if (!res.ok || !contentType.startsWith('image/')) return null
          return { data: Buffer.from(await res.arrayBuffer()), contentType }
        } catch {
          return null
        }
      },
    }
  }

  return {
    async fromBrowser(cookies) {
      const jar = xCookies(cookies)
      if (!jar.auth_token || !jar.ct0) {
        throw new HttpError(400, 'Paste both the "auth_token" and "ct0" cookies from x.com, like auth_token=…; ct0=…')
      }
      const signedIn = session({ jar })
      try {
        await signedIn.inbox()
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) {
          throw new HttpError(401, "X didn't accept those cookies. Sign in on x.com again, then copy auth_token and ct0 afresh.")
        }
        throw error
      }
      return signedIn
    },

    restore(saved) {
      return session(JSON.parse(saved) as Saved)
    },
  }
}
