import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createApp } from './app.ts'
import { createGoogleVerifier } from './auth/google.ts'
import { createSessionTokens } from './auth/tokens.ts'
import { ConfigError, loadConfig } from './config.ts'
import { createSealer } from './crypto.ts'
import { connectDatabase } from './db.ts'
import { createInboxStore } from './inbox/store.ts'
import { createMedia } from './media.ts'
import { createAccounts } from './networks/accounts.ts'
import { createTelegram } from './networks/telegram.ts'
import { createWhatsApp } from './networks/whatsapp.ts'
import { createHub } from './realtime.ts'

async function main() {
  // Locally, settings can live in a .env file; in production the host provides them.
  if (process.env.NODE_ENV !== 'production' && existsSync('.env')) process.loadEnvFile('.env')
  const config = loadConfig()

  const database = await connectDatabase(config.mongoUri)
  const { col } = database
  const sealer = createSealer(config.dataKey)
  const hub = createHub()
  const store = createInboxStore(col, sealer)
  const accounts = createAccounts(col, hub)
  const media = createMedia(config.cloudinary)
  const whatsapp = createWhatsApp({ col, sealer, store, accounts, hub, media })
  const telegram = createTelegram({ sealer, store, accounts, hub, media, api: config.telegram })

  const app = createApp({
    col,
    tokens: createSessionTokens(config.jwtSecret),
    google: config.googleClientId ? createGoogleVerifier(config.googleClientId) : null,
    googleClientId: config.googleClientId,
    media,
    store,
    accounts,
    hub,
    whatsapp,
    telegram,
    secureCookies: config.production,
    staticDir: resolve('dist'),
  })

  const server = app.listen(config.port, () => {
    console.log(`Tidings is listening on port ${config.port}`)
    const on = [config.googleClientId && 'Google sign-in', config.telegram && 'Telegram', config.cloudinary && 'image uploads']
    console.log(`Switched on: WhatsApp${on.filter(Boolean).map((f) => `, ${f}`).join('')}`)
  })

  // Reconnect linked accounts in the background; the site is usable meanwhile.
  void whatsapp.resumeAll().catch((e) => console.error('[whatsapp] resume failed', e))
  void telegram.resumeAll().catch((e) => console.error('[telegram] resume failed', e))

  let closing = false
  async function shutdown(signal: string) {
    if (closing) return
    closing = true
    console.log(`${signal}: shutting down`)
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
