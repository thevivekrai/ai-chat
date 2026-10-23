import { Router, type Request, type Response } from 'express'
import type { MessageHint } from '../../src/data/server/types.ts'
import type { SessionTokens } from '../auth/tokens.ts'
import type { Collections } from '../db.ts'
import { field, HttpError, requireUser, userIdOf } from '../http.ts'
import type { Accounts } from '../networks/accounts.ts'
import type { Telegram } from '../networks/telegram.ts'
import type { WhatsApp } from '../networks/whatsapp.ts'
import type { Hub } from '../realtime.ts'
import type { Avatars } from './avatars.ts'
import type { InboxStore } from './store.ts'

interface InboxDeps {
  col: Collections
  tokens: SessionTokens
  store: InboxStore
  avatars: Avatars
  accounts: Accounts
  hub: Hub
  whatsapp: WhatsApp
  telegram: Telegram
}

/** A reaction is one emoji (some are several code points); anything longer isn't one. */
const MAX_EMOJI_LENGTH = 16

/**
 * What the device says about a message (the server may no longer keep it). Optional: anything
 * malformed is ignored, and the stored copy is used when there is one.
 */
export function hintOf(value: unknown, id: string | undefined): MessageHint | undefined {
  if (!value || typeof value !== 'object' || !id) return undefined
  const { id: hintId, senderId, sentAt, body } = value as Record<string, unknown>
  if (hintId !== id || typeof senderId !== 'string' || senderId.length > 300) return undefined
  if (typeof sentAt !== 'string' || Number.isNaN(Date.parse(sentAt))) return undefined
  return { id, senderId, sentAt, ...(typeof body === 'string' ? { body: body.slice(0, 4096) } : {}) }
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

/** The linked chats: a snapshot on load, then live changes as server-sent events. */
export function inboxRoutes({ col, tokens, store, avatars, accounts, hub, whatsapp, telegram }: InboxDeps): Router {
  const router = Router()
  const signedIn = requireUser(tokens, col.users)

  /** Which linked network a chat belongs to, by its id. */
  function networkOf(threadId: string) {
    if (threadId.startsWith('wa:')) return whatsapp
    if (threadId.startsWith('tga:')) return telegram
    throw new HttpError(404, 'No such chat.')
  }

  /** The user's chat named in the URL, and its network. */
  async function chatOf(req: Request, res: Response) {
    const userId = userIdOf(res)
    const threadId = String(req.params.id)
    const network = networkOf(threadId)
    if (!(await store.thread(userId, threadId))) throw new HttpError(404, 'No such chat.')
    return { userId, threadId, network }
  }

  router.get('/inbox', signedIn, async (_req, res) => {
    const userId = userIdOf(res)
    const [snapshot, linked] = await Promise.all([store.snapshot(userId), accounts.list(userId)])
    res.setHeader('Cache-Control', 'no-store')
    res.json({ ...snapshot, accounts: linked })
  })

  router.get('/events', signedIn, (_req, res) => {
    hub.attach(userIdOf(res).toHexString(), res)
  })

  router.post('/threads/:id/messages', signedIn, async (req, res) => {
    const { userId, threadId, network } = await chatOf(req, res)
    const body = field(req.body, 'body', { max: 4096 })
    const replyToId = text(req.body?.replyToId)
    res.json({ message: await network.send(userId, threadId, body, replyToId, hintOf(req.body?.replyTo, replyToId)) })
  })

  /**
   * Older messages than `before`, oldest first. `senderId` and `sentAt` describe it, in case the
   * server no longer keeps it.
   */
  router.get('/threads/:id/messages', signedIn, async (req, res) => {
    const { userId, threadId, network } = await chatOf(req, res)
    const before = text(req.query.before)
    if (!before) throw new HttpError(400, 'Missing before.')
    const hint = hintOf({ id: before, senderId: text(req.query.senderId), sentAt: text(req.query.sentAt) }, before)
    res.json(await network.loadOlder(userId, threadId, hint ?? { id: before }))
  })

  router.post('/threads/:id/reactions', signedIn, async (req, res) => {
    const { userId, threadId, network } = await chatOf(req, res)
    const messageId = field(req.body, 'messageId', { max: 300 })
    const emoji = req.body?.emoji
    if (emoji !== null && (typeof emoji !== 'string' || !emoji.trim() || emoji.length > MAX_EMOJI_LENGTH)) {
      throw new HttpError(400, 'Send one emoji, or null to remove the reaction.')
    }
    res.json({ message: await network.react(userId, threadId, messageId, emoji, hintOf(req.body?.message, messageId)) })
  })

  router.post('/threads/:id/typing', signedIn, async (req, res) => {
    const { userId, threadId, network } = await chatOf(req, res)
    await network.setTyping(userId, threadId, req.body?.typing === true)
    res.json({ ok: true })
  })

  router.post('/threads/:id/read', signedIn, async (req, res) => {
    const { userId, threadId, network } = await chatOf(req, res)
    await network.markRead(userId, threadId)
    res.json({ ok: true })
  })

  /**
   * Profile and group pictures. The URL carries a version, so they can be cached for good. The
   * server holds recent ones in memory; others are fetched from the network again.
   */
  router.get('/avatars/:id', signedIn, async (req, res) => {
    const userId = userIdOf(res)
    const id = String(req.params.id)
    let image = await avatars.get(userId, id)
    if (!image && (await avatars.known(userId, id))) image = await networkOf(id).picture(userId, id)
    if (!image) throw new HttpError(404, 'No picture.')
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.type(image.contentType).send(image.data)
  })

  return router
}
