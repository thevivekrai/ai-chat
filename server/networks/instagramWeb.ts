import { randomUUID } from 'node:crypto'
import { HttpError } from '../http.ts'

/**
 * Instagram's own web API — the one instagram.com talks to — as the bridge needs it.
 *
 * There is no official way in: Meta's Messaging API covers business accounts' incoming DMs only,
 * never a person's own inbox. So this signs in the way the website does and reads the endpoints
 * its Direct page reads. Meta doesn't support that, a sign-in from a server is often challenged,
 * and the endpoints change without notice — so every answer here is turned into something the
 * user can act on rather than a stack trace.
 */

const BASE = 'https://www.instagram.com'
/** When a security check can't be answered from here, this is the only way through it. */
const BY_HAND =
  "Instagram is asking for a security check Sytext can't answer. Open instagram.com (or the app), sign in as yourself and clear whatever it asks there, then link again."
/** The web app's own id. These endpoints answer only with it. */
const APP_ID = '936619743392459'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
/** How many chats, and how much of each, one look at the inbox brings back. */
const THREADS = 20
const PER_THREAD = 20

export interface Credentials {
  username: string
  password: string
}

export interface IgUser {
  id: string
  username: string
  fullName?: string
  pictureUrl?: string
}

export interface IgMessage {
  id: string
  threadId: string
  /** Who sent it, as an Instagram user id. */
  userId: string
  text?: string
  photoUrl?: string
  /** Milliseconds. */
  sentAt: number
}

export interface IgThread {
  id: string
  title?: string
  group: boolean
  people: IgUser[]
  unread: number
  /** Milliseconds. */
  lastAt: number
  /** Oldest first. */
  messages: IgMessage[]
}

/** A sign-in Instagram wants a code for, carried back to the user and in again with the code. */
export interface PendingSignIn {
  username: string
  /** The account's own two-factor code, or one sent to get this sign-in past a security check. */
  kind: 'two-factor' | 'challenge'
  /** The two-factor identifier, or the path of the security check being answered. */
  identifier: string
  /** Where Instagram sent the code. */
  via: 'app' | 'sms' | 'email'
  state: string
}

export type SignInResult = { done: true; session: InstagramSession } | { done: false; pending: PendingSignIn }

/** One signed-in account. `save()` is sealed and kept, so a restart needs no password. */
export interface InstagramSession {
  save(): string
  /** The chats, newest first, with the latest messages of each — and who this is. */
  inbox(): Promise<{ me: IgUser; threads: IgThread[] }>
  sendText(threadId: string, text: string): Promise<IgMessage>
  markSeen(threadId: string, messageId: string): Promise<void>
  /** A photo or profile picture from Instagram's image hosts. */
  fetchImage(url: string): Promise<{ data: Buffer; contentType: string } | null>
}

/** Instagram, as the bridge talks to it. Tests stand in for this. */
export interface InstagramSite {
  signIn(credentials: Credentials): Promise<SignInResult>
  /** The code Instagram asked for: two-factor, or one it sent to confirm the sign-in. */
  submitCode(pending: PendingSignIn, code: string): Promise<SignInResult>
  /** A session from what `save()` gave, ready to use. */
  restore(saved: string): InstagramSession
  /**
   * A session the user signed in to themselves, on instagram.com in their own browser, handed
   * over as its cookies. Checked before it's taken.
   */
  fromBrowser(cookies: string): Promise<InstagramSession>
}

interface Jar {
  [name: string]: string
}

interface Saved {
  jar: Jar
  /** The same browser each time: changing it mid-session is what gets a session thrown out. */
  userAgent: string
}

export function createInstagramWeb({ fetch: call = fetch, baseUrl = BASE }: { fetch?: typeof fetch; baseUrl?: string } = {}): InstagramSite {
  /* ── Requests ────────────────────────────────────────────────────────────── */

  const cookieHeader = (jar: Jar) =>
    Object.entries(jar)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')

  /** Keeps whatever Instagram sets, so the session (and its csrf token) stays current. */
  function keepCookies(jar: Jar, res: Response) {
    const headers = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
    const all = headers.length ? headers : [res.headers.get('set-cookie') ?? '']
    for (const header of all) {
      for (const part of header.split(/,(?=[^;]+=)/)) {
        const [name, ...rest] = (part.split(';')[0] ?? '').trim().split('=')
        const value = rest.join('=')
        if (name && value && value !== '""') jar[name] = value
      }
    }
  }

  async function send(
    state: Saved,
    path: string,
    { form, headers, follow }: { form?: Record<string, string>; headers?: Record<string, string>; follow?: boolean } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    let res: Response
    try {
      res = await call(`${baseUrl}${path}`, {
        method: form ? 'POST' : 'GET',
        headers: {
          'user-agent': state.userAgent,
          accept: '*/*',
          'accept-language': 'en-US,en;q=0.9',
          'x-ig-app-id': APP_ID,
          'x-requested-with': 'XMLHttpRequest',
          'x-csrftoken': state.jar.csrftoken ?? '',
          referer: `${baseUrl}/`,
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded', origin: baseUrl } : {}),
          ...headers,
          ...(Object.keys(state.jar).length ? { cookie: cookieHeader(state.jar) } : {}),
        },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
        // Pages send you round the houses (a language or consent hop) before setting cookies; the
        // XHR endpoints answer where they stand, and a redirect from one is worth seeing.
        redirect: follow ? 'follow' : 'manual',
      })
    } catch {
      throw new HttpError(503, "Couldn't reach Instagram.")
    }
    keepCookies(state.jar, res)
    const text = await res.text().catch(() => '')
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(text) as Record<string, unknown>
    } catch {
      // A login page or a block page rather than JSON: the caller says what that means.
    }
    return { status: res.status, body }
  }

  /** The signed-in calls. A session Instagram has thrown out says so plainly. */
  async function asUser(state: Saved, path: string, form?: Record<string, string>) {
    const { status, body } = await send(state, path, {
      ...(form ? { form } : {}),
      headers: { referer: `${baseUrl}/direct/inbox/` },
    })
    if (status === 401 || status === 403 || body.message === 'login_required') {
      throw new HttpError(401, 'Instagram signed this session out. Link Instagram again.')
    }
    if (status === 429 || body.message === 'feedback_required') {
      throw new HttpError(429, 'Instagram is asking this account to slow down. It will try again in a while.')
    }
    if (status >= 400 || (body.status && body.status !== 'ok')) {
      throw new HttpError(502, `Instagram answered with an error (${status}) for ${path.split('?')[0]}.`)
    }
    return body
  }

  /* ── Signing in ──────────────────────────────────────────────────────────── */

/**
   * A fresh visit, for the csrf token and device cookies the login needs. Instagram gives the token
   * out in different ways depending on what it makes of the caller — as a cookie on a page, or
   * inside a page's own bootstrap data — so this tries each in turn and takes the first that comes.
   */
  async function visit(): Promise<Saved> {
    const state: Saved = { jar: {}, userAgent: USER_AGENT }
    const tried: { path: string; status: number }[] = []
    for (const path of ['/accounts/login/', '/', '/data/shared_data/', '/api/v1/public/landing_info/']) {
      const page = !path.startsWith('/api/') && path !== '/data/shared_data/'
      const { status, body } = await send(state, path, {
        follow: true,
        ...(page ? { headers: { accept: 'text/html,application/xhtml+xml' } } : {}),
      })
      tried.push({ path, status })
      const token = state.jar.csrftoken ?? csrfIn(body)
      if (token) state.jar.csrftoken = token
      if (state.jar.csrftoken) return state
    }
    const where = tried.map(({ path, status }) => `${path} ${status}`).join(', ')
    console.warn('[instagram] no csrf token:', where)
    // Hosts' addresses are blocked wholesale, which is worth saying: it isn't the password, and
    // waiting won't help either.
    if (tried.every(({ status }) => status === 403 || status === 429)) {
      throw new HttpError(
        502,
        `Instagram turned this server away (${tried[0]!.status}). It blocks addresses belonging to hosting providers like Render, so signing in from the server may not be possible at all — nothing to do with your password.`,
      )
    }
    throw new HttpError(502, `Instagram didn't start a session (${where}). Try again in a few minutes.`)
  }

  /**
   * The password as the website sends it: Instagram's own browser form sends it in the clear
   * inside HTTPS, tagged with the time, when no public key is in play.
   */
  const encode = (password: string) => `#PWD_INSTAGRAM_BROWSER:0:${Math.floor(Date.now() / 1000)}:${password}`

  function signedIn(state: Saved): InstagramSession | null {
    return state.jar.sessionid ? session(state) : null
  }

  /** What Instagram said about a sign-in attempt, in words the user can do something with. */
  function refuse(status: number, body: Record<string, unknown>): never {
    const message = typeof body.message === 'string' ? body.message : ''
    if (message === 'checkpoint_required' || body.checkpoint_url) throw new HttpError(409, BY_HAND)
    if (body.user === false) throw new HttpError(401, "Instagram doesn't know that username.")
    if (body.authenticated === false) throw new HttpError(401, 'That password is wrong.')
    if (status === 429 || /wait a few minutes/i.test(message)) {
      throw new HttpError(429, 'Instagram asked to wait a few minutes before trying again.')
    }
    throw new HttpError(502, message ? `Instagram refused the sign-in: ${message}` : `Instagram refused the sign-in (${status}).`)
  }

  const twoFactorVia = (info: Record<string, unknown>): PendingSignIn['via'] =>
    info.totp_two_factor_on ? 'app' : info.sms_two_factor_on ? 'sms' : 'email'

  /* ── Security checks ─────────────────────────────────────────────────────── */

  /**
   * One step of a security check. Instagram answers these as JSON for its own web app, at the path
   * it gave or the same path under /api/v1 depending on which check it is.
   */
  async function challengeStep(state: Saved, path: string, form?: Record<string, string>) {
    const candidates = path.startsWith('/api/') ? [path] : [path, `/api/v1${path}`]
    let last = { status: 0, body: {} as Record<string, unknown>, path }
    for (const candidate of candidates) {
      const { status, body } = await send(state, candidate, {
        ...(form ? { form } : {}),
        headers: { referer: `${baseUrl}${path}` },
        follow: true,
      })
      last = { status, body, path: candidate }
      if (body.step_name || body.status === 'ok' || body.logged_in_user || state.jar.sessionid) return last
    }
    return last
  }

  const stepData = (body: Record<string, unknown>) => (body.step_data ?? {}) as Record<string, unknown>

  const waitingForCode = (state: Saved, username: string, path: string, via: PendingSignIn['via']): SignInResult => ({
    done: false,
    pending: { username, kind: 'challenge', identifier: path, via, state: JSON.stringify(state) },
  })

  /**
   * Instagram asking to check this sign-in. It is not a prompt in the app: Instagram expects
   * whoever is signing in to answer the check itself, either by saying the login was theirs or by
   * typing a code it sends. Both are done here; the code is asked of the user like a two-factor one.
   */
  async function clearCheck(state: Saved, username: string, url: string): Promise<SignInResult> {
    const path = url.startsWith('http') ? new URL(url).pathname : url
    const start = await challengeStep(state, path)
    let step = str(start.body.step_name)
    let data = stepData(start.body)
    let at = start.path
    if (!step && !state.jar.sessionid) throw new HttpError(409, BY_HAND)

    // "Was this you?": it was — this sign-in is what it's asking about.
    if (step === 'delta_login_review') {
      const answered = await challengeStep(state, at, { choice: '0' })
      const session = signedIn(state)
      if (session) return { done: true, session }
      step = str(answered.body.step_name)
      data = stepData(answered.body)
      at = answered.path
    }

    // Instagram will send a code: to the email address if it offers one, otherwise by text.
    if (step === 'select_verify_method') {
      const byEmail = !!str(data.email)
      const chosen = await challengeStep(state, at, { choice: byEmail ? '1' : '0' })
      step = str(chosen.body.step_name) ?? step
      at = chosen.path
      if (!step || !/verify/i.test(step)) throw new HttpError(409, BY_HAND)
      return waitingForCode(state, username, at, byEmail ? 'email' : 'sms')
    }

    if (step && /verify_(code|email)/i.test(step)) {
      const where = `${step} ${str(data.form_type) ?? ''} ${str(data.contact_point) ?? ''}`
      return waitingForCode(state, username, at, /email|@/i.test(where) ? 'email' : 'sms')
    }

    const session = signedIn(state)
    if (session) return { done: true, session }
    throw new HttpError(409, step ? `${BY_HAND} (Instagram calls this step “${step}”.)` : BY_HAND)
  }

  return {
    async signIn({ username, password }: Credentials): Promise<SignInResult> {
      const state = await visit()
      const { status, body } = await send(state, '/api/v1/web/accounts/login/ajax/', {
        form: {
          username,
          enc_password: encode(password),
          optIntoOneTap: 'false',
          queryParams: '{}',
          trustedDeviceRecords: '{}',
        },
      })
      const session = signedIn(state)
      if (session) return { done: true, session }

      const info = (body.two_factor_info ?? {}) as Record<string, unknown>
      if (body.two_factor_required && typeof info.two_factor_identifier === 'string') {
        return {
          done: false,
          pending: {
            username,
            kind: 'two-factor',
            identifier: info.two_factor_identifier,
            via: twoFactorVia(info),
            state: JSON.stringify(state),
          },
        }
      }

      // A security check: answered here, rather than waiting for a prompt that never comes.
      const checkpoint = str(body.checkpoint_url) ?? str((body.challenge as Record<string, unknown> | undefined)?.api_path)
      if (checkpoint || body.message === 'checkpoint_required') return clearCheck(state, username, checkpoint ?? '/challenge/')
      refuse(status, body)
    },

    async submitCode(pending: PendingSignIn, code: string): Promise<SignInResult> {
      const state = JSON.parse(pending.state) as Saved
      if (pending.kind === 'challenge') {
        const { status, body } = await challengeStep(state, pending.identifier, { security_code: code })
        const session = signedIn(state)
        if (session) return { done: true, session }
        if (/code|invalid/i.test(str(body.message) ?? '')) {
          throw new HttpError(401, 'That code was not accepted. Instagram can send another one.')
        }
        if (body.status === 'ok') {
          throw new HttpError(409, 'Instagram took the code but gave no session. Sign in again — it should go straight through now.')
        }
        refuse(status, body)
      }
      const { status, body } = await send(state, '/api/v1/web/accounts/login/two_factor/', {
        form: {
          username: pending.username,
          verificationCode: code,
          identifier: pending.identifier,
          verification_method: pending.via === 'app' ? '3' : pending.via === 'sms' ? '1' : '6',
          trust_signal: 'true',
          queryParams: '{}',
        },
      })
      const session = signedIn(state)
      if (session) return { done: true, session }
      if (typeof body.message === 'string' && /code|invalid/i.test(body.message)) {
        throw new HttpError(401, 'That code was not accepted. Instagram can send another one.')
      }
      refuse(status, body)
    },

    restore(saved: string) {
      return session(JSON.parse(saved) as Saved)
    },

    async fromBrowser(cookies: string) {
      const given = browserCookies(cookies)
      if (!given.sessionid) {
        throw new HttpError(400, 'Paste the value of the "sessionid" cookie from instagram.com (or the whole cookie line).')
      }
      // A csrf token and device cookies of its own if Instagram hands them out here; if this
      // server is turned away, the browser's own (when pasted) are enough.
      let state: Saved = { jar: {}, userAgent: USER_AGENT }
      try {
        state = await visit()
      } catch {
        // Carried on with what was pasted.
      }
      state.jar = { ...state.jar, ...given }
      if (!state.jar.csrftoken) state.jar.csrftoken = randomUUID().replace(/-/g, '')
      const signedIn = session(state)
      try {
        await signedIn.inbox()
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) {
          throw new HttpError(401, "Instagram didn't accept that session. Sign in on instagram.com again, then copy the sessionid cookie afresh.")
        }
        throw error
      }
      return signedIn
    },
  }

  /* ── A signed-in account ─────────────────────────────────────────────────── */

  function session(state: Saved): InstagramSession {
    return {
      save: () => JSON.stringify(state),

      async inbox() {
        const query = new URLSearchParams({
          visual_message_return_type: 'unseen',
          persistentBadging: 'true',
          folder: '0',
          limit: String(THREADS),
          thread_message_limit: String(PER_THREAD),
        })
        const body = await asUser(state, `/api/v1/direct_v2/inbox/?${query.toString()}`)
        const viewer = (body.viewer ?? {}) as Record<string, unknown>
        const me = personOf(viewer)
        if (!me) throw new HttpError(502, "Instagram didn't say whose inbox that is.")
        const inbox = (body.inbox ?? {}) as Record<string, unknown>
        const threads = Array.isArray(inbox.threads) ? inbox.threads : []
        return { me, threads: threads.map((t) => threadOf(t as Record<string, unknown>, me.id)).filter((t): t is IgThread => !!t) }
      },

      async sendText(threadId, text) {
        const context = randomUUID()
        const body = await asUser(state, '/api/v1/direct_v2/threads/broadcast/text/', {
          action: 'send_item',
          thread_ids: `[${threadId}]`,
          text,
          client_context: context,
          mutation_token: context,
          offline_threading_id: context,
        })
        const payload = (body.payload ?? {}) as Record<string, unknown>
        const id = str(payload.item_id)
        if (!id) throw new HttpError(502, "Instagram didn't accept the message.")
        return { id, threadId, userId: '', text, sentAt: millis(payload.timestamp) ?? Date.now() }
      },

      async markSeen(threadId, messageId) {
        await asUser(state, `/api/v1/direct_v2/threads/${threadId}/items/${messageId}/seen/`, { use_unified_inbox: 'true' })
      },

      async fetchImage(url) {
        try {
          const res = await call(url, { headers: { 'user-agent': state.userAgent, referer: `${baseUrl}/` } })
          const contentType = res.headers.get('content-type') ?? ''
          if (!res.ok || !contentType.startsWith('image/')) return null
          return { data: Buffer.from(await res.arrayBuffer()), contentType }
        } catch {
          return null
        }
      },
    }
  }
}

/* ── Reading what Instagram sends ────────────────────────────────────────────── */

/**
 * The cookies pasted from a browser: a bare sessionid value, or a "name=value; name=value" line
 * (as the browser's tools copy it). Only Instagram's own session cookies are taken.
 */
export function browserCookies(text: string): Record<string, string> {
  const trimmed = text.trim().replace(/^cookie:\s*/i, '')
  if (!trimmed) return {}
  if (!trimmed.includes('=')) return { sessionid: decodeURIComponent(trimmed) }
  const wanted = new Set(['sessionid', 'csrftoken', 'ds_user_id', 'mid', 'ig_did', 'rur', 'datr'])
  const jar: Record<string, string> = {}
  for (const pair of trimmed.split(/;\s*/)) {
    const at = pair.indexOf('=')
    if (at < 1) continue
    const name = pair.slice(0, at).trim()
    const value = pair.slice(at + 1).trim()
    // Only what a cookie can carry: no line breaks or separators sneak into the header.
    if (wanted.has(name) && value && /^[\w%.:\-]+$/.test(value)) jar[name] = value
  }
  return jar
}

/** The csrf token as a page's bootstrap data carries it, when no cookie came with it. */
function csrfIn(body: Record<string, unknown>): string | undefined {
  const config = (body.config ?? {}) as Record<string, unknown>
  const token = config.csrf_token ?? body.csrf_token
  return typeof token === 'string' && token.length > 8 ? token : undefined
}

const str = (value: unknown) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined)

/** Instagram counts in microseconds. */
function millis(value: unknown): number | undefined {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.round(n / 1000)
}

function personOf(user: Record<string, unknown>): IgUser | null {
  const id = str(user.pk ?? user.pk_id ?? user.id)
  const username = str(user.username)
  if (!id || !username) return null
  return {
    id,
    username,
    ...(str(user.full_name) ? { fullName: str(user.full_name)! } : {}),
    ...(str(user.profile_pic_url) ? { pictureUrl: str(user.profile_pic_url)! } : {}),
  }
}

/** The photo in a message, at the largest size Instagram offers. */
function photoOf(item: Record<string, unknown>): string | undefined {
  const media = (item.media ?? item.visual_media ?? {}) as Record<string, unknown>
  const inner = ((media.media as Record<string, unknown> | undefined) ?? media) as Record<string, unknown>
  const versions = (inner.image_versions2 ?? {}) as Record<string, unknown>
  const candidates = Array.isArray(versions.candidates) ? (versions.candidates as Record<string, unknown>[]) : []
  const best = candidates.reduce<Record<string, unknown> | null>((a, b) => (Number(b.width ?? 0) > Number(a?.width ?? 0) ? b : a), null)
  return str(best?.url)
}

function messageOf(item: Record<string, unknown>, threadId: string): IgMessage | null {
  const id = str(item.item_id)
  const userId = str(item.user_id)
  const sentAt = millis(item.timestamp)
  if (!id || !userId || !sentAt) return null
  const photoUrl = photoOf(item)
  const text =
    str(item.text) ??
    (item.item_type === 'like' ? '❤️' : undefined) ??
    str((item.link as Record<string, unknown> | undefined)?.text) ??
    (photoUrl ? undefined : describe(item))
  return { id, threadId, userId, sentAt, ...(text ? { text } : {}), ...(photoUrl ? { photoUrl } : {}) }
}

/** Something Instagram sent that this app can't show: said in words rather than left blank. */
function describe(item: Record<string, unknown>): string {
  switch (str(item.item_type)) {
    case 'voice_media':
      return '🎤 Voice message — open Instagram to listen'
    case 'video_call_event':
      return '📞 Video call'
    case 'clip':
    case 'media_share':
      return '📎 A post, shared — open Instagram to see it'
    case 'story_share':
      return '📸 A story, shared — open Instagram to see it'
    case 'animated_media':
      return '🎞️ A GIF'
    default:
      return '📎 Something Instagram sent that Sytext can’t show yet'
  }
}

function threadOf(thread: Record<string, unknown>, meId: string): IgThread | null {
  const id = str(thread.thread_id)
  if (!id) return null
  const users = Array.isArray(thread.users) ? (thread.users as Record<string, unknown>[]) : []
  const people = users.map(personOf).filter((p): p is IgUser => !!p)
  const items = Array.isArray(thread.items) ? (thread.items as Record<string, unknown>[]) : []
  // Instagram sends the newest first; chats read better the other way round.
  const messages = items
    .map((item) => messageOf(item, id))
    .filter((m): m is IgMessage => !!m)
    .sort((a, b) => a.sentAt - b.sentAt)
  const group = !!thread.is_group || people.length > 1
  const mine = ((thread.last_seen_at ?? {}) as Record<string, { timestamp?: unknown }>)[meId]
  const seenAt = millis(mine?.timestamp) ?? 0
  const unread = thread.read_state === 1 ? Math.max(1, messages.filter((m) => m.userId !== meId && m.sentAt > seenAt).length) : 0
  return {
    id,
    ...(str(thread.thread_title) ? { title: str(thread.thread_title)! } : {}),
    group,
    people,
    unread,
    lastAt: millis(thread.last_activity_at) ?? messages.at(-1)?.sentAt ?? Date.now(),
    messages,
  }
}
