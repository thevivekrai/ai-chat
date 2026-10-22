import { Router } from 'express'
import type { SessionTokens } from '../auth/tokens.ts'
import type { Collections } from '../db.ts'
import { field, HttpError, requireUser, userIdOf } from '../http.ts'
import type { Accounts } from '../networks/accounts.ts'
import type { Telegram } from '../networks/telegram.ts'
import type { WhatsApp } from '../networks/whatsapp.ts'
import type { Hub } from '../realtime.ts'
import type { InboxStore } from './store.ts'

interface InboxDeps {
  col: Collections
  tokens: SessionTokens
  store: InboxStore
  accounts: Accounts
  hub: Hub
  whatsapp: WhatsApp
  telegram: Telegram
}

/** The linked chats: a snapshot on load, then live changes as server-sent events. */
export function inboxRoutes({ col, tokens, store, accounts, hub, whatsapp, telegram }: InboxDeps): Router {
  const router = Router()
  const signedIn = requireUser(tokens, col.users)

  /** Which linked network a chat belongs to, by its id. */
  function networkOf(threadId: string) {
    if (threadId.startsWith('wa:')) return whatsapp
    if (threadId.startsWith('tga:')) return telegram
    throw new HttpError(404, 'No such chat.')
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
    const userId = userIdOf(res)
    const threadId = String(req.params.id)
    const body = field(req.body, 'body', { max: 4096 })
    const network = networkOf(threadId)
    if (!(await store.thread(userId, threadId))) throw new HttpError(404, 'No such chat.')
    res.json({ message: await network.send(userId, threadId, body) })
  })

  router.post('/threads/:id/read', signedIn, async (req, res) => {
    const userId = userIdOf(res)
    const threadId = String(req.params.id)
    const network = networkOf(threadId)
    if (!(await store.thread(userId, threadId))) throw new HttpError(404, 'No such chat.')
    await network.markRead(userId, threadId)
    res.json({ ok: true })
  })

  return router
}
