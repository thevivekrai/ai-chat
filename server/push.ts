import { Router } from 'express'
import { ObjectId } from 'mongodb'
import webpush from 'web-push'
import type { Message, NetworkId, Thread } from '../src/data/types.ts'
import type { SessionTokens } from './auth/tokens.ts'
import type { Sealer } from './crypto.ts'
import type { Collections } from './db.ts'
import { HttpError, rateLimit, requireUser, userIdOf } from './http.ts'
import type { InboxStore } from './inbox/store.ts'
import type { Hub, ServerEvent } from './realtime.ts'

/**
 * Notifications of new messages, on the user's phone or computer, with Sytext closed.
 *
 * The networks are linked on the server and stay connected around the clock (see index.ts), so the
 * server is the one that sees a message arrive. It tells each device the user turned notifications
 * on for through Web Push: the browser's own push service (Google's for Chrome and the Android
 * app, Mozilla's, Apple's) wakes the device, and Sytext's service worker (public/sw.js) shows the
 * notification. What's sent is encrypted for that device alone; the push service sees only noise.
 *
 * The server signs its pushes with a VAPID key pair: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or
 * one it makes itself the first time and keeps in the database (the private half sealed).
 */

/** A device's push subscription, as the browser gives it. */
export interface PushSubscriptionInput {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** What a notification says; the service worker shows it. */
export interface PushPayload {
  title: string
  body: string
  /** One notification per chat: a newer message replaces the older one. */
  tag: string
  /** Opened on a tap. */
  url: string
  /** When the message was sent (ms). */
  at?: number
}

export interface Push {
  /** The public half of the signing key, for the browser to subscribe with. */
  publicKey(): Promise<string>
  subscribe(userId: ObjectId, subscription: PushSubscriptionInput, options: { preview: boolean }): Promise<void>
  unsubscribe(userId: ObjectId, endpoint: string): Promise<void>
  /** Sends to every device of the user; returns how many took it. */
  send(userId: ObjectId, payload: PushPayload | ((preview: boolean) => PushPayload)): Promise<number>
}

/** Sends one push; tests stand in for the push services. */
export type SendPush = (
  subscription: PushSubscriptionInput,
  payload: string,
  options: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL: number; urgency: 'high' },
) => Promise<unknown>

/** The push services browsers use. Subscriptions anywhere else are refused, so no one can make the server post to an address of their choosing. */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^push\.services\.mozilla\.com$/,
  /^(?:[a-z0-9-]+\.)*push\.apple\.com$/,
  /^(?:[a-z0-9-]+\.)*notify\.windows\.com$/,
]

/** Devices one account can have notifications on; the oldest goes past that. */
const DEVICES_PER_USER = 20
/** How long a push service keeps trying a device that's off: a day. */
const TTL_SECONDS = 24 * 60 * 60

export function createPush({
  col,
  sealer,
  subject,
  keys,
  sendPush = webpush.sendNotification as unknown as SendPush,
}: {
  col: Collections
  sealer: Sealer
  /** Who sends: an https: address or mailto:, so a push service can reach the sender. */
  subject: string
  /** From VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY; otherwise made once and kept in the database. */
  keys?: { publicKey: string; privateKey: string }
  sendPush?: SendPush
}): Push {
  let vapid: Promise<{ publicKey: string; privateKey: string }> | null = keys ? Promise.resolve(keys) : null

  function signingKeys() {
    vapid ??= (async () => {
      const made = webpush.generateVAPIDKeys()
      // Two servers starting at once keep the same pair: whichever was written first.
      await col.settings.updateOne(
        { _id: 'vapid' },
        { $setOnInsert: { publicKey: made.publicKey, privateKey: sealer.seal(made.privateKey), createdAt: new Date() } },
        { upsert: true },
      )
      const kept = await col.settings.findOne({ _id: 'vapid' })
      if (!kept?.publicKey || !kept.privateKey) throw new Error('No push signing key was kept')
      return { publicKey: kept.publicKey, privateKey: sealer.open(kept.privateKey) }
    })().catch((error: unknown) => {
      vapid = null
      throw error
    })
    return vapid
  }

  return {
    publicKey: async () => (await signingKeys()).publicKey,

    async subscribe(userId, subscription, { preview }) {
      const now = new Date()
      // A device belongs to whoever signed in on it last.
      await col.push.updateOne(
        { endpoint: subscription.endpoint },
        {
          $set: { userId, keys: sealer.sealJson(subscription.keys), preview, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      )
      const extra = await col.push
        .find({ userId }, { projection: { _id: 1 } })
        .sort({ updatedAt: -1 })
        .skip(DEVICES_PER_USER)
        .toArray()
      if (extra.length) await col.push.deleteMany({ _id: { $in: extra.map((d) => d._id) } })
    },

    async unsubscribe(userId, endpoint) {
      await col.push.deleteOne({ userId, endpoint })
    },

    async send(userId, payload) {
      let devices = await col.push.find({ userId }).toArray()
      if (!devices.length) return 0
      // Signed out everywhere (a new password, say): devices that haven't checked in since are
      // signed out too, and get no more of the account's messages. Open apps check in again.
      const user = await col.users.findOne({ _id: userId }, { projection: { sessionsValidAfter: 1 } })
      const cutoff = user ? user.sessionsValidAfter : new Date(8.64e15)
      const stale = cutoff ? devices.filter((d) => d.updatedAt < cutoff) : []
      if (stale.length) {
        await col.push.deleteMany({ _id: { $in: stale.map((d) => d._id) } })
        devices = devices.filter((d) => !stale.includes(d))
        if (!devices.length) return 0
      }
      const vapidDetails = { subject, ...(await signingKeys()) }
      const results = await Promise.all(
        devices.map(async (device) => {
          const body = typeof payload === 'function' ? payload(device.preview) : payload
          try {
            const keys = sealer.openJson<PushSubscriptionInput['keys']>(device.keys)
            await sendPush({ endpoint: device.endpoint, keys }, JSON.stringify(body), { vapidDetails, TTL: TTL_SECONDS, urgency: 'high' })
            return true
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode
            // Gone: the user turned notifications off in the browser, or uninstalled the app.
            if (status === 404 || status === 410) await col.push.deleteOne({ _id: device._id })
            else console.error(`[push] couldn't notify a device (${status ?? (error instanceof Error ? error.message : 'error')})`)
            return false
          }
        }),
      )
      return results.filter(Boolean).length
    },
  }
}

/** A subscription from a request, checked: a known push service, and keys of the right shape. */
export function subscriptionOf(body: unknown): PushSubscriptionInput {
  const raw = (body as { subscription?: unknown } | undefined)?.subscription as Partial<PushSubscriptionInput> | undefined
  const endpoint = typeof raw?.endpoint === 'string' ? raw.endpoint : ''
  let url: URL | null = null
  try {
    url = endpoint.length <= 1024 ? new URL(endpoint) : null
  } catch {
    url = null
  }
  if (!url || url.protocol !== 'https:' || url.port || !PUSH_HOSTS.some((host) => host.test(url.hostname))) {
    throw new HttpError(400, "This browser's notification service isn't one Sytext can send to.")
  }
  const key = (value: unknown, max: number) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9_-]+=*$/.test(value)
  if (!key(raw?.keys?.p256dh, 200) || !key(raw?.keys?.auth, 64)) throw new HttpError(400, 'The notification keys are missing.')
  return { endpoint, keys: { p256dh: raw!.keys!.p256dh, auth: raw!.keys!.auth } }
}

export function pushRoutes({ col, tokens, push }: { col: Collections; tokens: SessionTokens; push: Push }): Router {
  const router = Router()
  const signedIn = requireUser(tokens, col.users)
  const limit = rateLimit({ name: 'push', windowMs: 60_000, max: 30 })

  router.get('/push/key', signedIn, async (_req, res) => {
    res.json({ key: await push.publicKey() })
  })

  router.post('/push/subscribe', limit, signedIn, async (req, res) => {
    const subscription = subscriptionOf(req.body)
    const userId = userIdOf(res)
    const body = req.body as { preview?: unknown; replaces?: unknown }
    // The browser renewed a device's subscription (from the service worker): same settings as before.
    const replaced =
      typeof body.replaces === 'string' && body.replaces !== subscription.endpoint
        ? await col.push.findOneAndDelete({ userId, endpoint: body.replaces })
        : null
    const preview = typeof body.preview === 'boolean' ? body.preview : (replaced?.preview ?? true)
    await push.subscribe(userId, subscription, { preview })
    res.json({ ok: true })
  })

  router.post('/push/unsubscribe', limit, signedIn, async (req, res) => {
    const endpoint = (req.body as { endpoint?: unknown }).endpoint
    if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 1024) throw new HttpError(400, 'Missing endpoint.')
    await push.unsubscribe(userIdOf(res), endpoint)
    res.json({ ok: true })
  })

  router.post('/push/test', limit, signedIn, async (_req, res) => {
    const sent = await push.send(userIdOf(res), {
      title: 'Sytext',
      body: 'Notifications are on. New messages will show up like this.',
      tag: 'sytext-test',
      url: '/',
    })
    res.json({ sent })
  })

  return router
}

const NETWORK_NAMES: Record<NetworkId, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  instagram: 'Instagram',
  x: 'X',
  slack: 'Slack',
  sms: 'SMS',
  matrix: 'Matrix',
  guffshuff: 'Guffshuff',
}

/** Messages older than this when they arrive are catching up (a history sync, the server waking), not news. */
const FRESH_MS = 30 * 60_000
/** At most this many notifications a minute for one account: a flood shows as the latest of each chat anyway. */
const PER_MINUTE = 12
/** The longest text a notification shows. */
const BODY_MAX = 180

/** What a message says, in a line: its text, or what it carries. */
export function messageLine(message: Pick<Message, 'body' | 'attachments' | 'deleted'>): string {
  const text = message.body.replace(/\s+/g, ' ').trim()
  if (text) return text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 1)}…` : text
  const kind = message.attachments?.[0]
  if (!kind) return 'New message'
  if (kind.kind === 'sticker') return 'Sticker'
  if (kind.kind === 'audio') return 'Voice message'
  if (kind.kind === 'image') return kind.mime?.startsWith('video/') ? 'Video' : 'Photo'
  return kind.name ? `File: ${kind.name}` : 'File'
}

/** The notification for a new message in a chat; `sender` is the name of whoever wrote it, where known. */
export function notificationFor(thread: Thread, message: Message, sender: string | null, preview: boolean): PushPayload {
  const network = NETWORK_NAMES[thread.network] ?? 'Sytext'
  const line = messageLine(message)
  // A direct chat is named after the person (its own title can be a placeholder until then).
  const chat = (thread.kind === 'direct' && sender) || thread.title || 'Chat'
  return {
    title: preview ? `${chat} · ${network}` : 'Sytext',
    body: preview ? (thread.kind === 'group' && sender ? `${sender}: ${line}` : line) : `New message on ${network}`,
    tag: `chat:${thread.id}`,
    url: `/chat/${encodeURIComponent(thread.id)}`,
    at: Date.parse(message.sentAt) || Date.now(),
  }
}

/**
 * The event hub, also notifying the user's devices of new messages from other people: every
 * network announces a message through the hub, so this one place covers them all.
 */
export function notifyingHub(
  hub: Hub,
  { push, store, now = Date.now, nameWaitMs = 2500 }: { push: Push; store: InboxStore; now?: () => number; nameWaitMs?: number },
): Hub {
  const recent = new Map<string, number[]>()

  async function notify(userId: string, message: Message) {
    if (!ObjectId.isValid(userId)) return
    const id = new ObjectId(userId)
    const look = async () => {
      const thread = await store.thread(id, message.threadId)
      const sender = (await store.contact(id, message.senderId))?.name?.trim() || null
      return { thread, sender }
    }
    let { thread, sender } = await look()
    // The first message of a new chat can come before the network says who it's with: a moment
    // later, it has.
    if (thread && !sender && thread.title === 'Chat') {
      await new Promise((wait) => setTimeout(wait, nameWaitMs))
      ;({ thread, sender } = await look())
    }
    if (!thread || thread.archived) return
    await push.send(id, (preview) => notificationFor(thread, message, sender, preview))
  }

  return {
    ...hub,
    publish(userId: string, event: ServerEvent) {
      hub.publish(userId, event)
      if (event.type !== 'message.created') return
      const { message } = event
      if (message.senderId === 'me' || message.deleted) return
      const at = now()
      const sentAt = Date.parse(message.sentAt)
      if (!Number.isFinite(sentAt) || at - sentAt > FRESH_MS) return
      const times = (recent.get(userId) ?? []).filter((t) => at - t < 60_000)
      if (times.length >= PER_MINUTE) return
      times.push(at)
      recent.set(userId, times)
      void notify(userId, message).catch((error: unknown) => console.error('[push] failed', error instanceof Error ? error.message : error))
    },
  }
}
