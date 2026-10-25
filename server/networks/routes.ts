import { Router } from 'express'
import type { Collections } from '../db.ts'
import { field, rateLimit, requireUser, userIdOf } from '../http.ts'
import type { SessionTokens } from '../auth/tokens.ts'
import type { Accounts } from './accounts.ts'
import type { Guffshuff } from './guffshuff.ts'
import type { Telegram } from './telegram.ts'
import type { WhatsApp } from './whatsapp.ts'

interface LinkDeps {
  col: Collections
  tokens: SessionTokens
  accounts: Accounts
  whatsapp: WhatsApp
  telegram: Telegram
  guffshuff: Guffshuff
}

/** Linking and unlinking WhatsApp, Telegram and Guffshuff. */
export function linkRoutes({ col, tokens, accounts, whatsapp, telegram, guffshuff }: LinkDeps): Router {
  const router = Router()
  const signedIn = requireUser(tokens, col.users)
  // Each attempt can make WhatsApp or Telegram send a code to someone's phone: keep it slow.
  const limited = rateLimit({ name: 'link', windowMs: 15 * 60_000, max: 20 })

  router.get('/accounts', signedIn, async (_req, res) => {
    res.json({ accounts: await accounts.list(userIdOf(res)) })
  })

  router.post('/link/whatsapp', signedIn, limited, async (req, res) => {
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

  router.post('/link/telegram/code', signedIn, limited, async (req, res) => {
    res.json(await telegram.requestCode(userIdOf(res), field(req.body, 'phone', { max: 32 })))
  })

  router.post('/link/telegram/qr', signedIn, limited, async (_req, res) => {
    res.json(await telegram.startQr(userIdOf(res)))
  })

  router.post('/link/telegram/verify', signedIn, limited, async (req, res) => {
    res.json(await telegram.verifyCode(userIdOf(res), field(req.body, 'code', { max: 16 })))
  })

  router.post('/link/telegram/password', signedIn, limited, async (req, res) => {
    res.json(await telegram.verifyPassword(userIdOf(res), field(req.body, 'password', { max: 256, trim: false })))
  })

  /** Guffshuff signs in as its own website does: a username and password, kept sealed. */
  router.post('/link/guffshuff', signedIn, limited, async (req, res) => {
    const username = field(req.body, 'username', { max: 64 })
    const password = field(req.body, 'password', { max: 256, trim: false })
    res.json(await guffshuff.link(userIdOf(res), { username, password }))
  })

  router.delete('/link/guffshuff', signedIn, async (_req, res) => {
    await guffshuff.unlink(userIdOf(res))
    res.json({ ok: true })
  })

  router.delete('/link/telegram', signedIn, async (_req, res) => {
    await telegram.unlink(userIdOf(res))
    res.json({ ok: true })
  })

  return router
}
