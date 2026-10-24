import express, { Router, type Request, type Response } from 'express'
import type { MessageHint } from '../../src/data/server/types.ts'
import type { MessageAction } from '../../src/data/types.ts'
import type { SessionTokens } from '../auth/tokens.ts'
import type { Collections } from '../db.ts'
import { field, HttpError, requireUser, userIdOf } from '../http.ts'
import type { Accounts } from '../networks/accounts.ts'
import type { Telegram } from '../networks/telegram.ts'
import type { WhatsApp } from '../networks/whatsapp.ts'
import type { Hub } from '../realtime.ts'
import type { Avatars } from './avatars.ts'
import { decodedHeader, MAX_FILE_BYTES, serveFile, uploadOf, type FileLinks } from './files.ts'
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
  files: FileLinks
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

/** An edit, deletion, pin or star, as the browser sent it; anything else is refused. */
export function actionOf(value: unknown): MessageAction {
  const action = (value ?? {}) as Record<string, unknown>
  switch (action.type) {
    case 'edit': {
      const body = typeof action.body === 'string' ? action.body.trim() : ''
      if (!body) throw new HttpError(400, 'Write something, or delete the message instead.')
      if (body.length > 4096) throw new HttpError(400, 'That message is too long.')
      return { type: 'edit', body }
    }
    case 'delete':
      if (typeof action.forEveryone !== 'boolean') break
      return { type: 'delete', forEveryone: action.forEveryone }
    case 'pin':
      if (typeof action.pinned !== 'boolean') break
      return { type: 'pin', pinned: action.pinned }
    case 'star':
      if (typeof action.starred !== 'boolean') break
      return { type: 'star', starred: action.starred }
  }
  throw new HttpError(400, 'Unknown action.')
}

/** The linked chats: a snapshot on load, then live changes as server-sent events. */
export function inboxRoutes({ col, tokens, store, avatars, accounts, hub, whatsapp, telegram, files }: InboxDeps): Router {
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

  /**
   * Edits, deletes, pins or stars a message. `message` describes it, in case the server no longer
   * keeps it. Answers with the message as kept now (null if the server doesn't keep it), and
   * `removed` when it's gone from the chat.
   */
  router.post('/threads/:id/message-actions', signedIn, async (req, res) => {
    const { userId, threadId, network } = await chatOf(req, res)
    const messageId = field(req.body, 'messageId', { max: 300 })
    const action = actionOf(req.body?.action)
    res.json(await network.act(userId, threadId, messageId, action, hintOf(req.body?.message, messageId)))
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

  /** A photo or file in a chat, fetched from WhatsApp or Telegram as it's opened (see files.ts). */
  router.get('/files/:token', signedIn, async (req, res) => {
    const userId = userIdOf(res)
    const ref = files.open(userId, String(req.params.token))
    if (!ref) throw new HttpError(404, 'No such file.')
    const file = await (ref.n === 'wa' ? whatsapp : telegram).openFile(userId, ref)
    await serveFile(res, file, { download: req.query.download === '1' })
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

/**
 * Sending a photo or file. The request body is the file itself (as application/octet-stream), and
 * headers describe it, encoded with encodeURIComponent: X-File-Name, X-File-Type, and optionally
 * X-Caption, X-Reply-To and X-Reply-Hint (what the device knows of the message replied to, as JSON).
 *
 * X-File-Name is required before the body is read. It's also what keeps other sites from posting
 * here: a cross-site request can't set it without a CORS preflight, which this server never
 * approves (the JSON-only rule does the same for every other change).
 */
export function uploadRoutes({
  col,
  tokens,
  store,
  whatsapp,
  telegram,
  maxFileBytes = MAX_FILE_BYTES,
}: Pick<InboxDeps, 'col' | 'tokens' | 'store' | 'whatsapp' | 'telegram'> & { maxFileBytes?: number }): Router {
  const router = Router()
  const signedIn = requireUser(tokens, col.users)
  const readFile = express.raw({ type: () => true, limit: maxFileBytes })
  const limitText = `${Math.round(maxFileBytes / 1024 / 1024)} MB`

  router.post(
    '/threads/:id/files',
    signedIn,
    (req, res, next) => {
      if (!req.headers['x-file-name']) return next(new HttpError(400, 'Missing the file name.'))
      readFile(req, res, (error?: { type?: string }) =>
        next(error?.type === 'entity.too.large' ? new HttpError(413, `Files up to ${limitText} can be sent through Sytext.`) : error),
      )
    },
    async (req, res) => {
      const userId = userIdOf(res)
      const threadId = String(req.params.id)
      const network = threadId.startsWith('wa:') ? whatsapp : threadId.startsWith('tga:') ? telegram : null
      if (!network || !(await store.thread(userId, threadId))) throw new HttpError(404, 'No such chat.')
      const upload = uploadOf(req.headers, req.body)
      const caption = decodedHeader(req.headers, 'x-caption', 1024)?.trim() ?? ''
      const replyToId = decodedHeader(req.headers, 'x-reply-to', 300)
      let hint
      try {
        const json = decodedHeader(req.headers, 'x-reply-hint', 6000)
        hint = json ? hintOf(JSON.parse(json), replyToId) : undefined
      } catch {
        hint = undefined // Only a hint: a malformed one is ignored.
      }
      res.json({ message: await network.sendFile(userId, threadId, upload, caption, replyToId, hint) })
    },
  )

  return router
}
