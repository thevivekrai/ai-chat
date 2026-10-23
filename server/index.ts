import { resolve } from 'node:path'
import { createApp } from './app.ts'
import { createGoogleVerifier } from './auth/google.ts'
import { createSessionTokens } from './auth/tokens.ts'
import { ConfigError, loadConfig, loadEnvFiles } from './config.ts'
import { createSealer } from './crypto.ts'
import { connectDatabase } from './db.ts'
import { createAvatars } from './inbox/avatars.ts'
import { createInboxStore } from './inbox/store.ts'
import { createMedia } from './media.ts'
import { createAccounts } from './networks/accounts.ts'
import { createTelegram } from './networks/telegram.ts'
import { createWhatsApp } from './networks/whatsapp.ts'
import { keepAwake } from './keepAwake.ts'
import { createHub } from './realtime.ts'

/** How often linked accounts that aren't connected are reconnected. */
const RESUME_EVERY_MS = 5 * 60_000
/** How often chats that got new messages are trimmed to what the server keeps. */
const TRIM_EVERY_MS = 60_000

async function main() {
  // Settings come from the environment, or a .env file (locally, or as a host's secret file).
  const files = loadEnvFiles()
  if (files.length) console.log(`Read settings from ${files.join(' and ')}`)
  const config = loadConfig()

  const database = await connectDatabase(config.mongoUri)
  const { col } = database
  const sealer = createSealer(config.dataKey)
  const hub = createHub()
  const store = createInboxStore(col, sealer)
  const avatars = createAvatars(col, sealer)
  const accounts = createAccounts(col, hub)
  const media = createMedia(config.cloudinary)
  const whatsapp = createWhatsApp({ col, sealer, store, accounts, hub, media, avatars })
  const telegram = createTelegram({ sealer, store, accounts, hub, media, avatars, api: config.telegram })

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
    secureCookies: config.production,
    staticDir: resolve('dist'),
  })

  const server = app.listen(config.port, () => {
    console.log(`Sytext is listening on port ${config.port}`)
    const on = [
      config.googleClientId && 'Google sign-in',
      config.telegram && 'Telegram',
      config.cloudinary && 'image uploads',
      config.keepAwakeUrl && 'keep-awake',
    ]
    console.log(`Switched on: WhatsApp${on.filter(Boolean).map((f) => `, ${f}`).join('')}`)
  })

  // Reconnect linked accounts in the background; the site is usable meanwhile. They're checked
  // again every few minutes, so a link that stopped for any reason picks up again by itself.
  // None of this depends on anyone being signed in: signing out of Sytext leaves links running.
  const resume = () => {
    void whatsapp.resumeAll().catch((e) => console.error('[whatsapp] resume failed', e))
    void telegram.resumeAll().catch((e) => console.error('[telegram] resume failed', e))
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

  let closing = false
  async function shutdown(signal: string) {
    if (closing) return
    closing = true
    console.log(`${signal}: shutting down`)
    for (const timer of timers) clearInterval(timer)
    stopKeepingAwake?.()
    // Open event streams would keep the server from closing.
    hub.closeAll()
    server.close()
    // Disconnect without logging out, so the links carry on after the restart.
    await Promise.allSettled([whatsapp.stopAll(), telegram.stopAll()])
    await database.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error) => {
  console.error(error instanceof ConfigError ? error.message : error)
  process.exit(1)
})
