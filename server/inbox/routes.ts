import express, { Router, type Request, type Response } from 'express'
import type { ObjectId } from 'mongodb'
import { MAX_CAPTION, type MessageHint } from '../../src/data/server/types.ts'
import type { Attachment, MessageAction, MessageStatus, QuotedMessage, Reaction } from '../../src/data/types.ts'
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
  const { id: hintId, senderId, sentAt, body, attachments, replyTo, reactions, editedAt, status } = value as Record<string, unknown>
  if (hintId !== id || typeof senderId !== 'string' || senderId.length > 300) return undefined
  if (!isDate(sentAt)) return undefined
  const files = attachmentsOf(attachments)
  const quote = quoteOf(replyTo)
  const reacted = reactionsOf(reactions)
  return {
    id,
    senderId,
    sentAt,
    ...(typeof body === 'string' ? { body: body.slice(0, 4096) } : {}),
    ...(files ? { attachments: files } : {}),
    ...(quote ? { replyTo: quote } : {}),
    ...(reacted ? { reactions: reacted } : {}),
    ...(isDate(editedAt) ? { editedAt } : {}),
    ...(senderId === 'me' && STATUSES.has(status as MessageStatus) ? { status: status as MessageStatus } : {}),
  }
}

const isDate = (value: unknown): value is string => typeof value === 'string' && value.length < 40 && !Number.isNaN(Date.parse(value))

/** Delivery states a message kept again can have (not one still on its way, or failed). */
const STATUSES = new Set<MessageStatus>(['sent', 'delivered', 'read'])

/** The message a reply quotes, as the device shows it. */
function quoteOf(value: unknown): QuotedMessage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { id, senderId, body } = value as Record<string, unknown>
  if (typeof id !== 'string' || typeof senderId !== 'string' || typeof body !== 'string' || id.length > 300 || senderId.length > 300) return undefined
  return { id, senderId, body: body.slice(0, 300) }
}

/** Everyone's reactions, as the device shows them. */
function reactionsOf(value: unknown): Reaction[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.slice(0, 20).flatMap((item): Reaction[] => {
    if (!item || typeof item !== 'object') return []
    const { emoji, count, mine } = item as Record<string, unknown>
    if (typeof emoji !== 'string' || !emoji || emoji.length > MAX_EMOJI_LENGTH) return []
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 1_000_000) return []
    return [{ emoji, count, mine: mine === true }]
  })
  return list.length ? list : undefined
}

const ATTACHMENT_KINDS = new Set<Attachment['kind']>(['file', 'image', 'sticker', 'audio'])

/** A message's attachments as the device describes them: only what's well formed, and only links to this server's files. */
function attachmentsOf(value: unknown): Attachment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.slice(0, 10).flatMap((item): Attachment[] => {
    if (!item || typeof item !== 'object') return []
    const { kind, name, size, mime, url, voice, duration, waveform } = item as Record<string, unknown>
    if (!ATTACHMENT_KINDS.has(kind as Attachment['kind']) || typeof name !== 'string') return []
    const levels = Array.isArray(waveform) ? waveform.slice(0, 100).filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) : []
    return [
      {
        kind: kind as Attachment['kind'],
        name: name.slice(0, 200),
        ...(typeof size === 'string' ? { size: size.slice(0, 20) } : {}),
        ...(typeof mime === 'string' ? { mime: mime.slice(0, 100) } : {}),
        ...(typeof url === 'string' && url.startsWith('/api/files/') && url.length < 4000 ? { url } : {}),
        ...(voice === true ? { voice: true } : {}),
        ...(typeof duration === 'number' && duration > 0 && duration < 86_400 ? { duration } : {}),
        ...(levels.length ? { waveform: levels.map((n) => Math.max(0, Math.min(100, Math.round(n)))) } : {}),
      },
    ]
  })
  return list.length ? list : undefined
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

/** The user's chats named in URLs, and the linked network each belongs to. */
function chatLookup({ store, whatsapp, telegram }: Pick<InboxDeps, 'store' | 'whatsapp' | 'telegram'>) {
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

  return { networkOf, chatOf }
}

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

  const { networkOf, chatOf } = chatLookup({ store, whatsapp, telegram })

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

  /** Archives or unarchives a chat, on WhatsApp or Telegram too. */
  router.post('/threads/:id/archive', signedIn, async (req, res) => {
    const { userId, threadId, network } = await chatOf(req, res)
    if (typeof req.body?.archived !== 'boolean') throw new HttpError(400, 'Say whether to archive it.')
    res.json({ thread: await network.archive(userId, threadId, req.body.archived) })
  })

  /** Incognito mode: nothing tells people that the user read their messages, or is typing. */
  const incognito = async (userId: ObjectId) => !!(await col.users.findOne({ _id: userId }, { projection: { incognito: 1 } }))?.incognito

  router.post('/threads/:id/typing', signedIn, async (req, res) => {
    const { userId, threadId, network } = await chatOf(req, res)
    const typing = req.body?.typing === true
    // Stopping always goes through: typing may have started before Incognito mode was turned on.
    if (!typing || !(await incognito(userId))) await network.setTyping(userId, threadId, typing)
    res.json({ ok: true })
  })

  /**
   * Marks a chat read. A read receipt goes to the network too, unless Incognito mode is on or the
   * browser says not to; `receipt: true` sends one anyway (the user asked to).
   */
  router.post('/threads/:id/read', signedIn, async (req, res) => {
    const { userId, threadId, network } = await chatOf(req, res)
    const asked = req.body?.receipt === true
    const receipt = asked || (req.body?.receipt !== false && !(await incognito(userId)))
    // Asked for, a read receipt that can't go out is an error, not a quiet success.
    await network.markRead(userId, threadId, { receipt, strict: asked })
    res.json({ ok: true, receipt })
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
  const { networkOf, chatOf } = chatLookup({ store, whatsapp, telegram })

  router.post(
    '/threads/:id/files',
    signedIn,
    async (req, res, next) => {
      if (!req.headers['x-file-name']) return next(new HttpError(400, 'Missing the file name.'))
      // Before reading up to 50 MB: is there such a chat, and can its network take the file now?
      // (Node reads off and drops what's still being sent, so the browser gets this answer.)
      const { network } = await chatOf(req, res)
      if (!network.isConnected(userIdOf(res))) {
        const name = network === whatsapp ? 'WhatsApp' : 'Telegram'
        return next(new HttpError(409, `${name} isn't connected right now, so the file can't be sent. Try again in a minute.`))
      }
      readFile(req, res, (error?: { type?: string }) =>
        next(error?.type === 'entity.too.large' ? new HttpError(413, `Files up to ${limitText} can be sent through Sytext.`) : error),
      )
    },
    async (req, res) => {
      const userId = userIdOf(res)
      const threadId = String(req.params.id)
      const network = networkOf(threadId)
      const upload = uploadOf(req.headers, req.body)
      const caption = decodedHeader(req.headers, 'x-caption', MAX_CAPTION)?.trim() ?? ''
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
