import type { GuffshuffApi, GuffshuffStream } from '../networks/guffshuff.ts'

/**
 * A stand-in for the user's Guffshuff site: its REST API in memory, and a live stream the test
 * pushes messages through. Only what the bridge uses is implemented.
 */

interface FakeMessage {
  _id: string
  senderId: string
  receiverId: string
  text?: string
  image?: string
  seen: boolean
  createdAt: string
}

const ME = 'u-me'
export const ASHA = 'u-asha'
export const KABIR = 'u-kabir'
export const GUFFSHUFF_URL = 'https://guffshuff.test'
const PHOTO = `${GUFFSHUFF_URL}/photos/parcel.jpg`

export function fakeGuffshuff() {
  let id = 0
  const nextId = () => `m${++id}`
  const messages: FakeMessage[] = []
  const streams = new Set<{ cookie: string; listeners: Map<string, ((...args: never[]) => void)[]> }>()

  const state = {
    username: 'aarav',
    password: 'correct horse battery',
    /** The site is down, or signs nobody in. */
    down: false,
    /** Paths the site answers with a 500, as a half-broken deployment would. */
    broken: [] as string[],
    /** The cookie the site last handed out; an older one is treated as expired. */
    cookie: 'jwt=token-1',
    /** Whose session that cookie is: another username is another person, with their own chats. */
    signedInAs: ME,
    /** Every request the bridge made, as "METHOD /path". */
    calls: [] as string[],
    /** What the bridge sent, in order. */
    sent: [] as { to: string; text?: string; image?: string }[],
    /** Chats the bridge marked read, in order. */
    reads: [] as string[],
  }

  const people = [
    { _id: ASHA, fullName: 'Asha Rao', username: 'asha', profilePic: `${GUFFSHUFF_URL}/pics/asha.png` },
    { _id: KABIR, fullName: 'Kabir Shah', username: 'kabir', profilePic: '' },
    // Someone on the site who has never written: not a chat.
    { _id: 'u-stranger', fullName: 'Stranger', username: 'stranger', profilePic: '' },
  ]

  /** When `userId` and whoever is signed in last wrote to each other. */
  const lastAt = (userId: string) => {
    const me = state.signedInAs
    return messages.filter((m) => (m.senderId === userId && m.receiverId === me) || (m.senderId === me && m.receiverId === userId)).at(-1)?.createdAt ?? null
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  /** A message arriving on the site, pushed to the bridge's stream as the real one does. */
  function write(from: string, text: string, { image, toStream = true }: { image?: string; toStream?: boolean } = {}) {
    const message: FakeMessage = {
      _id: nextId(),
      senderId: from,
      receiverId: ME,
      text,
      ...(image ? { image } : {}),
      seen: false,
      createdAt: new Date().toISOString(),
    }
    messages.push(message)
    if (toStream) for (const s of streams) for (const listener of s.listeners.get('newMessage') ?? []) (listener as (m: FakeMessage) => void)(message)
    return message
  }

  const api: GuffshuffApi = {
    baseUrl: GUFFSHUFF_URL,

    async fetch(input, init) {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const path = url.pathname
      state.calls.push(`${method} ${path}`)
      if (state.down) throw new Error('Site is down')

      // A photo or profile picture, fetched straight from the site.
      if (path.startsWith('/photos/') || path.startsWith('/pics/')) {
        return new Response(Buffer.from('fake-image-bytes'), { headers: { 'content-type': 'image/png' } })
      }

      if (path === '/api/auth/login') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { username?: string; password?: string }
        if (body.username !== state.username || body.password !== state.password) {
          return json({ message: 'Password is incorrect' }, 400)
        }
        state.signedInAs = state.username === 'aarav' ? ME : `u-${state.username}`
        const me = { _id: state.signedInAs, fullName: 'Aarav Mehta', username: state.username, profilePic: '' }
        return new Response(JSON.stringify(me), {
          status: 200,
          headers: { 'content-type': 'application/json', 'set-cookie': `${state.cookie}; Path=/; HttpOnly; SameSite=Strict` },
        })
      }

      // Everything else needs the session cookie the site last handed out.
      const cookie = (init?.headers as Record<string, string> | undefined)?.cookie
      if (cookie !== state.cookie) return json({ message: 'Unauthorized - No Token Provided' }, 401)

      if (state.broken.some((broken) => path.startsWith(broken))) return json({ error: 'Internal server error' }, 500)

      if (path === '/api/messages/users') {
        return json(people.map((p) => ({ ...p, lastMessageTime: lastAt(p._id) })))
      }
      if (path === '/api/messages/unread') {
        const counts: Record<string, number> = {}
        for (const m of messages) if (m.receiverId === ME && !m.seen) counts[m.senderId] = (counts[m.senderId] ?? 0) + 1
        return json(counts)
      }
      if (path.startsWith('/api/messages/read/')) {
        const from = path.slice('/api/messages/read/'.length)
        state.reads.push(from)
        for (const m of messages) if (m.senderId === from && m.receiverId === ME) m.seen = true
        return json({ ok: true })
      }
      if (path.startsWith('/api/messages/send/')) {
        const to = path.slice('/api/messages/send/'.length)
        const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string; image?: string }
        state.sent.push({ to, ...body })
        const message: FakeMessage = {
          _id: nextId(),
          senderId: ME,
          receiverId: to,
          ...(body.text ? { text: body.text } : {}),
          // The real site puts the photo on Cloudinary and keeps the address.
          ...(body.image ? { image: PHOTO } : {}),
          seen: false,
          createdAt: new Date().toISOString(),
        }
        messages.push(message)
        return json(message, 201)
      }
      if (path.startsWith('/api/messages/')) {
        const other = path.slice('/api/messages/'.length)
        // Reading a conversation marks it read, exactly as the real site does.
        for (const m of messages) if (m.senderId === other && m.receiverId === ME) m.seen = true
        return json(messages.filter((m) => m.senderId === other || m.receiverId === other))
      }
      return json({ message: 'Not found' }, 404)
    },

    connect(_url: string, cookie: string): GuffshuffStream {
      const stream = { cookie, listeners: new Map<string, ((...args: never[]) => void)[]>() }
      streams.add(stream)
      return {
        on(event: string, listener: (...args: never[]) => void) {
          stream.listeners.set(event, [...(stream.listeners.get(event) ?? []), listener])
          if (event === 'connect') setTimeout(() => listener(...([] as never[])), 0)
        },
        close() {
          streams.delete(stream)
        },
      } as GuffshuffStream
    },
  }

  return {
    api,
    state,
    write,
    /** Pretends the week-old session ran out: the next request is refused until a new sign-in. */
    expireSession() {
      state.cookie = `jwt=token-${Math.random().toString(36).slice(2, 8)}`
    },
    /** Messages the site holds, oldest first. */
    messages: () => messages,
    /** Whether the bridge is listening. */
    listening: () => streams.size > 0,
    /** A message the site has but never pushed (the stream was down). */
    writeQuietly: (from: string, text: string) => write(from, text, { toStream: false }),
    photoUrl: PHOTO,
  }
}
