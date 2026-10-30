import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import express, { Router, type Express, type Request } from 'express'
import type { DatabaseProblem, ServerFeatures } from '../src/data/server/types.ts'
import { aiRoutes, SHARED_AI_BY, type SharedAi } from './ai.ts'
import { authRoutes } from './auth/routes.ts'
import type { GoogleVerifier } from './auth/google.ts'
import type { SessionTokens } from './auth/tokens.ts'
import type { Collections } from './db.ts'
import { errorHandler, HttpError, jsonOnly, rateLimit, SITE_PAGE_CSP, securityHeaders } from './http.ts'
import type { Avatars } from './inbox/avatars.ts'
import type { FileLinks } from './inbox/files.ts'
import { inboxRoutes, uploadRoutes } from './inbox/routes.ts'
import type { InboxStore } from './inbox/store.ts'
import type { Media } from './media.ts'
import type { Accounts } from './networks/accounts.ts'
import { linkRoutes } from './networks/routes.ts'
import { calendarRoutes, type CalendarConfig } from './calendar.ts'
import type { Sealer } from './crypto.ts'
import type { Guffshuff } from './networks/guffshuff.ts'
import type { Instagram } from './networks/instagram.ts'
import type { X } from './networks/x.ts'
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
  guffshuff: Guffshuff
  instagram: Instagram
  x: X
  /** Links to photos and files in chats. */
  files: FileLinks
  /** Largest photo or file that can be sent (tests use a small one). */
  maxFileBytes?: number
  /** Send the session cookie over HTTPS only (on in production). */
  secureCookies: boolean
  /** The built web app, served alongside the API. */
  staticDir?: string
  /**
   * Set while accounts are kept in temporary storage, because the database in MONGODB_URI can't
   * be reached; `problem` says why, as it stands now.
   */
  temporaryStorage?: { problem(): DatabaseProblem | undefined }
  /** The shared AI (AI_API), when set. */
  ai?: SharedAi | null
  /** Seals what's kept for the user (the Google Calendar token). */
  sealer: Sealer
  /** Google Calendar, when the server has a client id and secret for it. */
  calendar?: CalendarConfig | null
}

export function createApp(deps: AppDeps): Express {
  const app = express()
  app.disable('x-powered-by')
  // Behind the host's proxy (Render, Fly…): trust it for the client's IP and HTTPS.
  app.set('trust proxy', 1)
  app.use(securityHeaders)
  // The site's own pages, written by hand: their own looser policy for their inline scripts and fonts.
  for (const page of ['info', 'terms', 'privacy', 'help']) {
    app.get(`/${page}`, (_req, res) => {
      res.setHeader('Content-Security-Policy', SITE_PAGE_CSP)
      res.sendFile(join(process.cwd(), 'public', page, `${page}.html`))
    })
  }

  const api = Router()
  // A ceiling for any one visitor, far above what the app sends, so a flood of requests can't
  // tie the server up. Sign-in, linking and the AI have tighter limits of their own.
  api.use(rateLimit({ name: 'api', windowMs: 60_000, max: 900 }))
  // Photos and files are sent as they are, not as JSON: before the JSON rules.
  api.use(uploadRoutes(deps))
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
      guffshuff: deps.guffshuff.enabled,
      calendar: !!deps.calendar,
      instagram: deps.instagram.enabled,
      x: deps.x.enabled,
      uploads: !!deps.media,
      database: true,
      storage: deps.temporaryStorage ? 'temporary' : 'database',
      ai: !!deps.ai,
      ...(deps.ai ? { aiBy: SHARED_AI_BY[deps.ai.provider] } : {}),
    }
    const problem = deps.temporaryStorage?.problem()
    res.json(problem ? { ...features, databaseProblem: problem } : features)
  })
  api.use(
    authRoutes({
      col: deps.col,
      hub: deps.hub,
      tokens: deps.tokens,
      google: deps.google,
      media: deps.media,
      secureCookies: deps.secureCookies,
      sealer: deps.sealer,
    }),
  )
  api.use(linkRoutes(deps))
  api.use(aiRoutes({ col: deps.col, tokens: deps.tokens, ai: deps.ai ?? null }))
  api.use(calendarRoutes({ col: deps.col, tokens: deps.tokens, sealer: deps.sealer, config: deps.calendar ?? null }))
  api.use(inboxRoutes(deps))
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found.')))
  api.use(errorHandler)
  app.use('/api', api)

  serveApp(app, deps.staticDir)
  return app
}

/** The app's own pages; anything else is a 404 (the app still shows its "not found" page). */
const APP_PAGES = /^\/(?:login|demo|search|shortcuts|chat|settings|tags|waiting|scheduled|tasks|starred|archive)?(?:\/.*)?$/

/** The pages search engines should know, with the site's own address in front. */
const PUBLIC_PATHS = ['/', '/info', '/help', '/demo', '/privacy', '/terms']

/**
 * This site's address as the browser reached it. The host is checked before it goes into a page,
 * so a forged Host header can't put anything else there.
 */
function originOf(req: Request): string {
  const host = req.get('host') ?? ''
  return /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) ? `${req.protocol}://${host}` : ''
}

/** For answer engines: what Sytext is, in plain text (llmstxt.org). */
const LLMS_TXT = (origin: string) => `# Sytext

> Sytext is a unified inbox: WhatsApp, Telegram, Instagram, Matrix bridges and more in one place, with AI that sorts chats by who needs a reply first, tags them, drafts replies and turns requests into tasks.

## What it does
- One inbox for WhatsApp and Telegram accounts, Instagram and X (Twitter) direct messages, Guffshuff, Telegram bots and Matrix (with WhatsApp, Instagram, Slack and SMS through Matrix bridges).
- "Needs reply" queue: AI decides who is waiting on you and how urgent it is.
- Drafted replies in three tones; summaries of long threads; answers to questions across your chats.
- Automatic tags (question, deadline, payment, order, meeting, work, personal, finance, travel, health and more), which you can change.
- Tasks pulled from chats, synced to Google Calendar; send later and snooze at any date and time.
- Linked chats are encrypted at rest; AI reads only the chats you allow.

## Pages
- [What Sytext does](${origin}/info)
- [Help and guide](${origin}/help)
- [Try the demo](${origin}/demo)
- [Privacy Policy](${origin}/privacy)
- [Terms & Conditions](${origin}/terms)
`

/** Serves the built web app, if it was built. */
export function serveApp(app: Express, dir: string | undefined) {
  if (!dir || !existsSync(join(dir, 'index.html'))) return
  const page = readFileSync(join(dir, 'index.html'), 'utf8')

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /settings\nDisallow: /chat/\n\nSitemap: ${originOf(req)}/sitemap.xml\n`)
  })
  app.get('/sitemap.xml', (req, res) => {
    const origin = originOf(req)
    const urls = PUBLIC_PATHS.map((path) => `  <url><loc>${origin}${path}</loc></url>`).join('\n')
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`)
  })
  app.get('/llms.txt', (req, res) => {
    res.type('text/plain').send(LLMS_TXT(originOf(req)))
  })

  // File names under /assets carry a content hash, so they can be cached for good.
  app.use('/assets', express.static(join(dir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }))
  app.use(express.static(dir, { index: false }))
  // Everything else is a page of the app; an address it doesn't have answers 404, for search engines.
  app.get('/{*path}', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache')
    res.status(APP_PAGES.test(req.path) ? 200 : 404).type('html').send(page.replaceAll('__SITE_ORIGIN__', originOf(req)))
  })
}
