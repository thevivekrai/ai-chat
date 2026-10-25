/**
 * A stand-in for instagram.com: the endpoints the bridge uses, in memory, so the real web client
 * (../networks/instagramWeb.ts) is what the tests exercise — headers, cookies and all.
 */

export const ME = '17841400000000001'
export const PRIYA = '17841400000000002'
export const DEV = '17841400000000003'
export const PRIYA_THREAD = '340282366841710301244276050000000001'
export const GROUP_THREAD = '340282366841710301244276050000000002'
const PHOTO = 'https://scontent.cdninstagram.com/v/parcel.jpg'
/** A real (if tiny) PNG, so a browser showing one of these chats has something to draw. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

interface FakeItem {
  item_id: string
  user_id: string
  timestamp: number
  item_type: string
  text?: string
  media?: { image_versions2: { candidates: { url: string; width: number }[] } }
}

export function fakeInstagram() {
  let id = 0
  const nextId = () => `i${++id}`
  const people: Record<string, { pk: string; username: string; full_name: string; profile_pic_url: string }> = {
    [ME]: { pk: ME, username: 'aarav.mehta', full_name: 'Aarav Mehta', profile_pic_url: 'https://scontent.cdninstagram.com/me.jpg' },
    [PRIYA]: { pk: PRIYA, username: 'priya.makes', full_name: 'Priya Nair', profile_pic_url: 'https://scontent.cdninstagram.com/priya.jpg' },
    [DEV]: { pk: DEV, username: 'devshah', full_name: 'Dev Shah', profile_pic_url: '' },
  }

  const threads: Record<string, { users: string[]; title?: string; group: boolean; items: FakeItem[]; seenAt: number }> = {
    [PRIYA_THREAD]: { users: [PRIYA], group: false, items: [], seenAt: 0 },
    [GROUP_THREAD]: { users: [PRIYA, DEV], title: 'Trip plans', group: true, items: [], seenAt: 0 },
  }

  const state = {
    username: 'aarav.mehta',
    password: 'correct horse battery',
    /** Instagram wants a two-factor code as well. */
    twoFactor: false,
    code: '123456',
    /** Instagram wants the sign-in confirmed in the app instead. */
    checkpoint: false,
    /** Instagram is refusing everything for a while. */
    rateLimited: false,
    /** The session was thrown out: every signed-in call is refused. */
    signedOut: false,
    /** Instagram can't be reached at all. */
    down: false,
    /** Every request made, as "METHOD /path". */
    calls: [] as string[],
    /** What the bridge sent, in order. */
    sent: [] as { threadId: string; text: string }[],
    /** Messages the bridge marked seen, in order. */
    seen: [] as string[],
  }

  /** A message arriving on Instagram. */
  function write(threadId: string, from: string, text: string, { photo = false } = {}) {
    const item: FakeItem = {
      item_id: nextId(),
      user_id: from,
      timestamp: Date.now() * 1000,
      item_type: photo ? 'media' : 'text',
      ...(photo ? { media: { image_versions2: { candidates: [{ url: PHOTO, width: 1080 }] } } } : { text }),
    }
    threads[threadId]!.items.push(item)
    return item
  }

  const json = (body: unknown, status = 200, cookies: string[] = []) =>
    new Response(JSON.stringify(body), {
      status,
      headers: [
        ['content-type', 'application/json'],
        ...cookies.map((cookie) => ['set-cookie', cookie] as [string, string]),
      ],
    })

  const cookiesOf = (init?: RequestInit) =>
    Object.fromEntries(
      String((init?.headers as Record<string, string> | undefined)?.cookie ?? '')
        .split('; ')
        .filter(Boolean)
        .map((pair) => {
          const [name, ...rest] = pair.split('=')
          return [name!, rest.join('=')]
        }),
    )

  const form = (init?: RequestInit) => Object.fromEntries(new URLSearchParams(String(init?.body ?? '')))

  const threadJson = (threadId: string) => {
    const thread = threads[threadId]!
    const unseen = thread.items.filter((i) => i.user_id !== ME && i.timestamp / 1000 > thread.seenAt)
    return {
      thread_id: threadId,
      ...(thread.title ? { thread_title: thread.title } : {}),
      is_group: thread.group,
      users: thread.users.map((u) => people[u]),
      viewer_id: ME,
      read_state: unseen.length ? 1 : 0,
      last_activity_at: (thread.items.at(-1)?.timestamp ?? Date.now() * 1000).toString(),
      last_seen_at: { [ME]: { timestamp: String(thread.seenAt * 1000) } },
      // Instagram sends the newest first.
      items: [...thread.items].reverse(),
    }
  }

  const call = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const path = url.pathname
    state.calls.push(`${method} ${path}`)
    if (state.down) throw new Error('Instagram is unreachable')

    if (url.host.includes('cdninstagram')) {
      return new Response(PIXEL, { headers: { 'content-type': 'image/png' } })
    }

    if (path === '/accounts/login/') {
      return new Response('<html>login</html>', {
        headers: { 'content-type': 'text/html', 'set-cookie': 'csrftoken=csrf-1; Path=/; Secure' },
      })
    }

    const cookies = cookiesOf(init)
    const headers = (init?.headers ?? {}) as Record<string, string>

    if (path === '/api/v1/web/accounts/login/ajax/') {
      if (headers['x-csrftoken'] !== cookies.csrftoken) return json({ message: 'csrf token missing or incorrect' }, 403)
      const body = form(init)
      if (state.rateLimited) return json({ message: 'Please wait a few minutes before you try again.' }, 429)
      if (!String(body.enc_password).startsWith('#PWD_INSTAGRAM_BROWSER:0:')) return json({ message: 'bad password format' }, 400)
      const password = String(body.enc_password).split(':').slice(3).join(':')
      if (body.username !== state.username) return json({ user: false, status: 'fail' })
      if (password !== state.password) return json({ user: true, authenticated: false, status: 'ok' })
      if (state.checkpoint) return json({ message: 'checkpoint_required', checkpoint_url: '/challenge/abc/', status: 'fail' }, 400)
      if (state.twoFactor) {
        return json({
          two_factor_required: true,
          two_factor_info: { two_factor_identifier: 'tfa-1', sms_two_factor_on: true, obfuscated_phone_number: '00' },
          status: 'fail',
        })
      }
      return json({ authenticated: true, user: true, userId: ME, status: 'ok' }, 200, [`sessionid=sess-1; Path=/`, `ds_user_id=${ME}; Path=/`])
    }

    if (path === '/api/v1/web/accounts/login/two_factor/') {
      const body = form(init)
      if (body.identifier !== 'tfa-1') return json({ message: 'Invalid identifier', status: 'fail' }, 400)
      if (body.verificationCode !== state.code) {
        return json({ message: 'Please check the security code and try again.', status: 'fail' }, 400)
      }
      return json({ authenticated: true, user: true, userId: ME, status: 'ok' }, 200, [`sessionid=sess-1; Path=/`, `ds_user_id=${ME}; Path=/`])
    }

    // Everything else needs the session cookie.
    if (!cookies.sessionid || state.signedOut) return json({ message: 'login_required', status: 'fail' }, 403)
    if (state.rateLimited) return json({ message: 'feedback_required', status: 'fail' }, 429)

    if (path === '/api/v1/direct_v2/inbox/') {
      return json({
        viewer: people[ME],
        // Instagram lists a chat once there's something in it.
        inbox: { threads: Object.keys(threads).filter((id) => threads[id]!.items.length).map(threadJson), has_older: false },
        status: 'ok',
      })
    }

    if (path === '/api/v1/direct_v2/threads/broadcast/text/') {
      const body = form(init)
      const threadId = String(body.thread_ids).replace(/[[\]]/g, '')
      if (!threads[threadId]) return json({ message: 'Thread not found', status: 'fail' }, 404)
      state.sent.push({ threadId, text: String(body.text) })
      const item = write(threadId, ME, String(body.text))
      return json({ action: 'item_ack', payload: { item_id: item.item_id, timestamp: String(item.timestamp), thread_id: threadId }, status: 'ok' })
    }

    const seen = /^\/api\/v1\/direct_v2\/threads\/(\d+)\/items\/([^/]+)\/seen\/$/.exec(path)
    if (seen) {
      const [, threadId, itemId] = seen
      state.seen.push(itemId!)
      threads[threadId!]!.seenAt = Date.now()
      return json({ status: 'ok' })
    }

    return json({ message: 'Not found', status: 'fail' }, 404)
  }) as typeof fetch

  return {
    fetch: call,
    state,
    write,
    /** The conversations the site holds. */
    threads: () => threads,
    photoUrl: PHOTO,
  }
}
