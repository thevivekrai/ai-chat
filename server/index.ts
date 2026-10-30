import { createServer, type RequestListener } from 'node:http'
import { resolve } from 'node:path'
import type { DatabaseProblem } from '../src/data/server/types.ts'
import { createApp } from './app.ts'
import { createGoogleVerifier } from './auth/google.ts'
import { createSessionTokens } from './auth/tokens.ts'
import { ConfigError, loadConfig, loadEnvFiles, type Config } from './config.ts'
import { createSealer } from './crypto.ts'
import { connectDatabase, copyDatabase, problemOf, withoutCredentials, type Database } from './db.ts'
import { createHoldingApp } from './holding.ts'
import { createAvatars } from './inbox/avatars.ts'
import { createFileLinks } from './inbox/files.ts'
import { createInboxStore } from './inbox/store.ts'
import { createMedia } from './media.ts'
import { createAccounts } from './networks/accounts.ts'
import { createGuffshuff } from './networks/guffshuff.ts'
import { createInstagram } from './networks/instagram.ts'
import { createTelegram } from './networks/telegram.ts'
import { createWhatsApp } from './networks/whatsapp.ts'
import { keepAwake } from './keepAwake.ts'
import { createHub } from './realtime.ts'
import { startTemporaryDatabase, type TemporaryDatabase } from './temporaryDatabase.ts'

/** How often linked accounts that aren't connected are reconnected. */
const RESUME_EVERY_MS = 5 * 60_000
/** How often chats that got new messages are trimmed to what the server keeps. */
const TRIM_EVERY_MS = 60_000
/** How often to try the database again while it can't be reached. */
const DATABASE_RETRY_MS = 30_000

/** The app running on one database, and how to stop it (the database itself stays open). */
interface Instance {
  app: RequestListener
  stop(): Promise<void>
}

async function main() {
  // Settings come from the environment, or a .env file (locally, or as a host's secret file).
  const files = loadEnvFiles()
  if (files.length) console.log(`Read settings from ${files.join(' and ')}`)
  const config = loadConfig()
  const staticDir = resolve('dist')

  /** Why the database in MONGODB_URI can't be used, as of the latest try. */
  let problem: DatabaseProblem | undefined
  // The site is served by whichever app is current: until there's a database, one that says so.
  const holding = createHoldingApp({
    staticDir,
    reason: "Sytext can't reach its database, so accounts are unavailable. It's trying again.",
    problem: () => problem,
  })
  let handler: RequestListener = holding
  const server = createServer((req, res) => handler(req, res))

  let current: { instance: Instance; database: Database; temporary?: TemporaryDatabase } | null = null
  let closing = false
  async function shutdown(signal: string) {
    if (closing) return
    closing = true
    console.log(`${signal}: shutting down`)
    server.close()
    if (current) {
      await current.instance.stop().catch(() => undefined)
      await current.database.close().catch(() => undefined)
      await current.temporary?.stop().catch(() => undefined)
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  await new Promise<void>((ready) => server.listen(config.port, ready))
  console.log(`Sytext is listening on port ${config.port}`)

  console.log(`Connecting to ${withoutCredentials(config.mongoUri)}`)
  const first = await connectDatabase(config.mongoUri).catch((error: unknown) => error)
  if (!isDatabase(first)) {
    problem = problemOf(first)
    console.error(first instanceof ConfigError ? first.message : first)
    if (config.temporaryStorage) current = await runOnTemporaryStorage(config, staticDir, () => problem)
    if (current) handler = current.instance.app
    else console.log('The site is being served meanwhile; signing in and linked accounts need the database.')
  }

  // The real database: now, or whenever it answers. Anything made in temporary storage meanwhile
  // moves over to it.
  for (let database = isDatabase(first) ? first : null; !closing; database = null) {
    database ??= await connectWhenPossible(config, () => closing, (error) => {
      const now = problemOf(error)
      if (now !== problem) console.error(error instanceof ConfigError ? error.message : error)
      problem = now
    })
    if (!database) return
    try {
      if (current?.temporary) {
        handler = holding // Briefly, while everything moves.
        await current.instance.stop()
        // WhatsApp saves its keys in the background: let the last saves land before copying.
        await new Promise((wait) => setTimeout(wait, 1000))
        const moved = await copyDatabase(current.database, database)
        await current.database.close()
        await current.temporary.stop()
        console.log(`The database answers: moved ${moved} ${moved === 1 ? 'record' : 'records'} over from temporary storage.`)
      }
      console.log(`Using the database "${database.db.databaseName}"`)
      problem = undefined
      current = { instance: start(config, database, staticDir), database }
      handler = current.instance.app
      return
    } catch (error) {
      console.error("Couldn't move to the database; staying on temporary storage for now:", error)
      await database.close().catch(() => undefined)
      if (current?.temporary) {
        current.instance = start(config, current.database, staticDir, () => problem)
        handler = current.instance.app
      }
    }
  }
}

const isDatabase = (value: unknown): value is Database => !!value && typeof value === 'object' && 'col' in value

/**
 * A private database run by this server, so signing in and linking work while the real one can't
 * be reached. Null if it can't be started (say, MongoDB can't be downloaded): the site then waits.
 */
async function runOnTemporaryStorage(
  config: Config,
  staticDir: string,
  problem: () => DatabaseProblem | undefined,
): Promise<{ instance: Instance; database: Database; temporary: TemporaryDatabase } | null> {
  console.log('Starting temporary storage: a private database inside this server, so accounts work meanwhile…')
  let temporary: TemporaryDatabase | undefined
  try {
    temporary = await startTemporaryDatabase()
    const database = await connectDatabase(temporary.uri, 'sytext')
    console.log(
      'Temporary storage is ready: signing in and linking work, but only until the server restarts. ' +
        'Everything moves to the database as soon as it answers.',
    )
    return { instance: start(config, database, staticDir, problem), database, temporary }
  } catch (error) {
    console.error("Temporary storage couldn't start, so accounts wait for the database:", error instanceof Error ? error.message : error)
    await temporary?.stop().catch(() => undefined)
    return null
  }
}

/**
 * The real app on a database: linked accounts reconnect and old messages are trimmed. With
 * `temporaryProblem`, the database is temporary storage, and the app says so (and why).
 */
function start(config: Config, database: Database, staticDir: string, temporaryProblem?: () => DatabaseProblem | undefined): Instance {
  const { col } = database
  const sealer = createSealer(config.dataKey)
  const hub = createHub()
  const store = createInboxStore(col, sealer)
  const avatars = createAvatars(col, sealer)
  const accounts = createAccounts(col, hub)
  const media = createMedia(config.cloudinary)
  const files = createFileLinks(sealer)
  const whatsapp = createWhatsApp({ col, sealer, store, accounts, hub, avatars, files })
  const telegram = createTelegram({ sealer, store, accounts, hub, avatars, files, api: config.telegram })
  const guffshuff = createGuffshuff({ sealer, store, accounts, hub, avatars, files, ...(config.guffshuffUrl ? { api: { baseUrl: config.guffshuffUrl } } : {}) })
  const instagram = createInstagram({ sealer, store, accounts, hub, avatars, files, enabled: config.instagram })

  const app = createApp({
    col,
    tokens: createSessionTokens(config.jwtSecret),
    google: config.googleClientId ? createGoogleVerifier(config.googleClientId) : null,
    googleClientId: config.googleClientId,
    media,
    store,
    avatars,
    accounts,
    hub,
    whatsapp,
    telegram,
    guffshuff,
    instagram,
    files,
    sealer,
    calendar: config.googleClientId && config.googleClientSecret ? { clientId: config.googleClientId, clientSecret: config.googleClientSecret } : null,
    secureCookies: config.production,
    staticDir,
    ai: config.ai ?? null,
    ...(temporaryProblem ? { temporaryStorage: { problem: temporaryProblem } } : {}),
  })

  const on = [
    config.googleClientId && 'Google sign-in',
    config.telegram && 'Telegram',
    config.guffshuffUrl && 'Guffshuff',
    config.instagram && 'Instagram',
    config.cloudinary && 'profile photo uploads',
    config.keepAwakeUrl && 'keep-awake',
    config.ai && `shared AI (${config.ai.provider})`,
  ]
  console.log(`Switched on: WhatsApp${on.filter(Boolean).map((f) => `, ${f}`).join('')}`)

  // Reconnect linked accounts in the background; the site is usable meanwhile. They're checked
  // again every few minutes, so a link that stopped for any reason picks up again by itself.
  // None of this depends on anyone being signed in: signing out of Sytext leaves links running.
  const resume = () => {
    void whatsapp.resumeAll().catch((e) => console.error('[whatsapp] resume failed', e))
    void telegram.resumeAll().catch((e) => console.error('[telegram] resume failed', e))
    void guffshuff.resumeAll().catch((e: unknown) => console.error('[guffshuff] resume failed', e))
    void instagram.resumeAll().catch((e: unknown) => console.error('[instagram] resume failed', e))
  }
  resume()
  const timers = [setInterval(resume, RESUME_EVERY_MS)]

  // The server keeps only the latest messages of each chat (devices keep the rest), and no
  // picture files. Data stored before that is trimmed once on start.
  void (async () => {
    const [messages, pictures] = await Promise.all([store.trimAll(), avatars.compact()])
    if (messages || pictures) console.log(`Freed space: ${messages} old messages, ${pictures} stored pictures`)
  })().catch((e) => console.error('[storage] trimming failed', e))
  timers.push(setInterval(() => void store.trim().catch((e) => console.error('[storage] trimming failed', e)), TRIM_EVERY_MS))

  const stopKeepingAwake = config.keepAwakeUrl ? keepAwake({ url: config.keepAwakeUrl, wanted: () => accounts.anyLinked() }) : null

  return {
    app,
    async stop() {
      for (const timer of timers) clearInterval(timer)
      stopKeepingAwake?.()
      // Open event streams would keep the server from closing; browsers reconnect by themselves.
      hub.closeAll()
      // Disconnect without logging out, so the links carry on after a restart or a move.
      await Promise.allSettled([whatsapp.stopAll(), telegram.stopAll(), guffshuff.stopAll(), instagram.stopAll()])
    },
  }
}

/**
 * Connects, waiting as long as it takes: the database can be unreachable for a while (its access
 * list, a paused cluster) and that is something the user fixes elsewhere, without redeploying.
 * Null when the server is shutting down.
 */
async function connectWhenPossible(config: Config, stopped: () => boolean, failed: (error: unknown) => void): Promise<Database | null> {
  for (let attempt = 2; !stopped(); attempt++) {
    await new Promise((wait) => setTimeout(wait, DATABASE_RETRY_MS))
    if (stopped()) break
    try {
      return await connectDatabase(config.mongoUri)
    } catch (error) {
      failed(error)
      if (attempt % 10 === 0) console.error(`Still no database after ${attempt} tries.`)
    }
  }
  return null
}

main().catch((error) => {
  console.error(error instanceof ConfigError ? error.message : error)
  process.exit(1)
})
