import express, { Router, type Express } from 'express'
import type { ServerFeatures } from '../src/data/server/types.ts'
import { serveApp } from './app.ts'
import { jsonOnly, securityHeaders } from './http.ts'

/**
 * What the server answers while it has no database.
 *
 * The site itself still works — the demo, and the connections that run in the browser — and the
 * app is told that accounts are unavailable, so it says why instead of offering a sign-in that
 * can't work. Meanwhile the server keeps trying to connect; once it does, the real app takes over
 * without a restart.
 */
export function createHoldingApp({ staticDir, reason }: { staticDir?: string; reason: string }): Express {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)
  app.use(securityHeaders)

  const api = Router()
  api.use(express.json({ limit: '1mb' }))
  api.use(jsonOnly)
  // The host's health check: the site is being served, so this is not a failure.
  api.get('/health', (_req, res) => {
    res.json({ ok: true, database: false })
  })
  api.get('/config', (_req, res) => {
    const features: ServerFeatures = { googleClientId: null, whatsapp: false, telegram: false, uploads: false, database: false }
    res.json(features)
  })
  api.use((_req, res) => {
    res.status(503).json({ error: reason })
  })
  app.use('/api', api)

  serveApp(app, staticDir)
  return app
}
