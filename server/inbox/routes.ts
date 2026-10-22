import { Router, type Request, type Response } from 'express'
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
    const replyToId = typeof req.body?.replyToId === 'string' ? req.body.replyToId : undefined
    res.json({ message: await network.send(userId, threadId, body, replyToId) })
  })

  /** Older messages than `before`, oldest first. */
  router.get('/threads/:id/messages', signedIn, async (req, res) => {
    const { userId, threadId, network } = await chatOf(req, res)
    const before = typeof req.query.before === 'string' ? req.query.before : ''
    if (!before) throw new HttpError(400, 'Missing before.')
    res.json(await network.loadOlder(userId, threadId, before))
  })

  router.post('/threads/:id/reactions', signedIn, async (req, res) => {
    const { userId, threadId, network } = await chatOf(req, res)
    const messageId = field(req.body, 'messageId', { max: 300 })
    const emoji = req.body?.emoji
    if (emoji !== null && (typeof emoji !== 'string' || !emoji.trim() || emoji.length > MAX_EMOJI_LENGTH)) {
      throw new HttpError(400, 'Send one emoji, or null to remove the reaction.')
    }
    res.json({ message: await network.react(userId, threadId, messageId, emoji) })
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

  /** Profile and group pictures. The URL carries a version, so they can be cached for good. */
  router.get('/avatars/:id', signedIn, async (req, res) => {
    const image = await avatars.get(userIdOf(res), String(req.params.id))
    if (!image) throw new HttpError(404, 'No picture.')
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.type(image.contentType).send(image.data)
  })

  return router
}
