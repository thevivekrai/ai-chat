import { Router } from 'express'
import type { Collections } from '../db.ts'
import { field, HttpError, rateLimit, requireUser, userIdOf } from '../http.ts'
import { requireCurrentPassword } from '../auth/routes.ts'
import { SESSION_COOKIE, type SessionTokens } from '../auth/tokens.ts'
import type { Accounts } from './accounts.ts'
import type { Guffshuff } from './guffshuff.ts'
import type { Instagram } from './instagram.ts'
import type { X } from './x.ts'
import type { Telegram } from './telegram.ts'
import type { WhatsApp } from './whatsapp.ts'

interface LinkDeps {
  col: Collections
  tokens: SessionTokens
  accounts: Accounts
  whatsapp: WhatsApp
  telegram: Telegram
  guffshuff: Guffshuff
  instagram: Instagram
  x: X
}

/** Linking and unlinking WhatsApp, Telegram, Guffshuff and Instagram. */
export function linkRoutes({ col, tokens, accounts, whatsapp, telegram, guffshuff, instagram, x }: LinkDeps): Router {
  const router = Router()
  const signedIn = requireUser(tokens, col.users)
  /**
   * Each attempt can make WhatsApp or Telegram send a code to someone's phone, so keep it slow —
   * and per network, so that failing to link one doesn't lock the others out. Guffshuff takes a
   * password rather than a code, so it gets less room to guess in.
   */
  const limited = (network: string, max = 20) => rateLimit({ name: `link:${network}`, windowMs: 15 * 60_000, max })
  const whatsappLimit = limited('whatsapp')
  const telegramLimit = limited('telegram')
  const guffshuffLimit = limited('guffshuff', 10)
  // Instagram locks an account out after a few failed sign-ins, so this is the slowest of all.
  const instagramLimit = limited('instagram', 8)
  // Typing the code it sent is not guessing at a password, and a security check can take a few
  // goes, so that has room of its own rather than eating the sign-in's.
  const instagramCodeLimit = limited('instagram:code', 20)

  router.get('/accounts', signedIn, async (_req, res) => {
    res.json({ accounts: await accounts.list(userIdOf(res)) })
  })

  router.post('/link/whatsapp', signedIn, whatsappLimit, async (req, res) => {
    const result =
      req.body?.method === 'qr'
        ? await whatsapp.link(userIdOf(res), { method: 'qr' })
        : await whatsapp.link(userIdOf(res), { method: 'code', phone: field(req.body, 'phone', { max: 32 }) })
    res.json(result)
  })

  router.delete('/link/whatsapp', signedIn, async (_req, res) => {
    await whatsapp.unlink(userIdOf(res))
    res.json({ ok: true })
  })

  router.post('/link/telegram/code', signedIn, telegramLimit, async (req, res) => {
    res.json(await telegram.requestCode(userIdOf(res), field(req.body, 'phone', { max: 32 })))
  })

  router.post('/link/telegram/qr', signedIn, telegramLimit, async (_req, res) => {
    res.json(await telegram.startQr(userIdOf(res)))
  })

  router.post('/link/telegram/verify', signedIn, telegramLimit, async (req, res) => {
    res.json(await telegram.verifyCode(userIdOf(res), field(req.body, 'code', { max: 16 })))
  })

  router.post('/link/telegram/password', signedIn, telegramLimit, async (req, res) => {
    res.json(await telegram.verifyPassword(userIdOf(res), field(req.body, 'password', { max: 256, trim: false })))
  })

  /** Guffshuff signs in as its own website does: a username and password, kept sealed. */
  router.post('/link/guffshuff', signedIn, guffshuffLimit, async (req, res) => {
    const username = field(req.body, 'username', { max: 64 })
    const password = field(req.body, 'password', { max: 256, trim: false })
    res.json(await guffshuff.link(userIdOf(res), { username, password }))
  })

  router.delete('/link/guffshuff', signedIn, async (_req, res) => {
    await guffshuff.unlink(userIdOf(res))
    res.json({ ok: true })
  })

  /** Instagram signs in as its own website does; it often wants a code as well. */
  router.post('/link/instagram', signedIn, instagramLimit, async (req, res) => {
    const username = field(req.body, 'username', { max: 64 })
    const password = field(req.body, 'password', { max: 256, trim: false })
    res.json(await instagram.link(userIdOf(res), { username, password }))
  })

  /** A session signed in to on instagram.com in the user's own browser, as its cookies. */
  router.post('/link/instagram/session', signedIn, instagramLimit, async (req, res) => {
    res.json(await instagram.linkWithSession(userIdOf(res), field(req.body, 'cookies', { max: 4000 })))
  })

  /** X DMs, with the session of the user's own browser (its auth_token and ct0 cookies). */
  router.post('/link/x', signedIn, limited('x', 10), async (req, res) => {
    res.json(await x.link(userIdOf(res), field(req.body, 'cookies', { max: 4000 })))
  })

  router.delete('/link/x', signedIn, async (_req, res) => {
    await x.unlink(userIdOf(res))
    res.json({ ok: true })
  })

  router.post('/link/instagram/verify', signedIn, instagramCodeLimit, async (req, res) => {
    res.json(await instagram.verifyCode(userIdOf(res), field(req.body, 'code', { max: 16 })))
  })

  router.delete('/link/instagram', signedIn, async (_req, res) => {
    await instagram.unlink(userIdOf(res))
    res.json({ ok: true })
  })

  router.delete('/link/telegram', signedIn, async (_req, res) => {
    await telegram.unlink(userIdOf(res))
    res.json({ ok: true })
  })

  /**
   * Deletes the account and everything kept for it: linked sessions (signed out of WhatsApp,
   * Telegram, Instagram and Guffshuff first), chats, messages, contacts, pictures and tasks. Takes
   * the password, or for a Google-only account the email typed out, so it can't happen by accident
   * or from a session left open.
   */
  router.delete('/me', signedIn, limited('delete-account', 10), async (req, res) => {
    const userId = userIdOf(res)
    const user = await col.users.findOne({ _id: userId })
    if (!user) throw new HttpError(404, 'No such account.')
    if (user.passwordHash) await requireCurrentPassword(col, req.body, { ...user, passwordHash: user.passwordHash })
    else if (String(req.body?.confirm ?? '').trim().toLowerCase() !== user.email) {
      throw new HttpError(400, 'Type your email address to confirm.')
    }
    // Signed out of each network, so nothing is left connected in the user's name. One that
    // fails to answer doesn't stop the rest: its session is deleted below either way.
    await Promise.allSettled([whatsapp.unlink(userId), telegram.unlink(userId), guffshuff.unlink(userId), instagram.unlink(userId), x.unlink(userId)])
    await Promise.all([
      col.accounts.deleteMany({ userId }),
      col.waAuth.deleteMany({ userId }),
      col.threads.deleteMany({ userId }),
      col.contacts.deleteMany({ userId }),
      col.messages.deleteMany({ userId }),
      col.avatars.deleteMany({ userId }),
      col.tasks.deleteMany({ userId }),
      col.push.deleteMany({ userId }),
    ])
    await col.users.deleteOne({ _id: userId })
    res.clearCookie(SESSION_COOKIE, { path: '/' })
    res.json({ ok: true })
  })

  return router
}
