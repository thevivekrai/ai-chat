import { existsSync } from 'node:fs'
import { join } from 'node:path'
import express, { Router, type Express } from 'express'
import type { ServerFeatures } from '../src/data/server/types.ts'
import { authRoutes } from './auth/routes.ts'
import type { GoogleVerifier } from './auth/google.ts'
import type { SessionTokens } from './auth/tokens.ts'
import type { Collections } from './db.ts'
import { errorHandler, HttpError, jsonOnly, securityHeaders } from './http.ts'
import type { Avatars } from './inbox/avatars.ts'
import { inboxRoutes } from './inbox/routes.ts'
import type { InboxStore } from './inbox/store.ts'
import type { Media } from './media.ts'
import type { Accounts } from './networks/accounts.ts'
import { linkRoutes } from './networks/routes.ts'
import type { Telegram } from './networks/telegram.ts'
import type { WhatsApp } from './networks/whatsapp.ts'
import type { Hub } from './realtime.ts'

export interface AppDeps {
  col: Collections
  tokens: SessionTokens
  google: GoogleVerifier | null
  googleClientId: string | undefined
  media: Media | null
  store: InboxStore
  avatars: Avatars
  accounts: Accounts
  hub: Hub
  whatsapp: WhatsApp
  telegram: Telegram
  /** Send the session cookie over HTTPS only (on in production). */
  secureCookies: boolean
  /** The built web app, served alongside the API. */
  staticDir?: string
}

export function createApp(deps: AppDeps): Express {
  const app = express()
  app.disable('x-powered-by')
  // Behind the host's proxy (Render, Fly…): trust it for the client's IP and HTTPS.
  app.set('trust proxy', 1)
  app.use(securityHeaders)

  const api = Router()
  api.use(express.json({ limit: '8mb' }))
  api.use(jsonOnly)
  api.get('/health', (_req, res) => {
    res.json({ ok: true })
  })
  api.get('/config', (_req, res) => {
    const features: ServerFeatures = {
      googleClientId: deps.googleClientId ?? null,
      whatsapp: true,
      telegram: deps.telegram.enabled,
      uploads: !!deps.media,
    }
    res.json(features)
  })
  api.use(authRoutes({ col: deps.col, tokens: deps.tokens, google: deps.google, media: deps.media, secureCookies: deps.secureCookies }))
  api.use(linkRoutes(deps))
  api.use(inboxRoutes(deps))
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found.')))
  api.use(errorHandler)
  app.use('/api', api)

  const dir = deps.staticDir
  if (dir && existsSync(join(dir, 'index.html'))) {
    // File names under /assets carry a content hash, so they can be cached for good.
    app.use('/assets', express.static(join(dir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }))
    app.use(express.static(dir, { index: false }))
    // Everything else is a page of the app.
    app.get('/{*path}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache')
      res.sendFile(join(dir, 'index.html'))
    })
  }
  return app
}
