import { hkdfSync } from 'node:crypto'
import { existsSync } from 'node:fs'

/**
 * Server settings, all from environment variables (set them in the host's dashboard, never in the
 * repository). Required: MONGODB_URI and JWT_SECRET. Everything else turns a feature on.
 */
export interface Config {
  port: number
  production: boolean
  mongoUri: string
  jwtSecret: string
  /** Encrypts linked-account sessions and stored messages. */
  dataKey: Buffer
  /** Turns on "Sign in with Google". */
  googleClientId?: string
  /** Turns on Telegram sign-in with a phone number. From https://my.telegram.org. */
  telegram?: { apiId: number; apiHash: string }
  /** Turns on profile photos and images in chats. */
  cloudinary?: { cloudName: string; apiKey: string; apiSecret: string }
  /**
   * The server's public address, visited every few minutes while accounts are linked, so hosts
   * that put idle services to sleep don't (see keepAwake.ts). KEEP_AWAKE_URL, or the address
   * Render provides; KEEP_AWAKE=off turns it off.
   */
  keepAwakeUrl?: string
  /**
   * While MONGODB_URI can't be reached, keep accounts in a private database run by the server
   * itself, so signing in and linking work anyway (until a restart). TEMPORARY_STORAGE=off waits
   * for the database instead.
   */
  temporaryStorage: boolean
  /**
   * The user's own chat site, bridged as another network: where it lives, e.g.
   * https://guffshuff.onrender.com. Without it, Guffshuff isn't offered.
   */
  guffshuffUrl?: string
  /**
   * Offer Instagram DMs, signed in to as its website does. INSTAGRAM=off takes it off the
   * Settings page (Meta doesn't allow this way in, so a server can turn it off for everyone).
   */
  instagram: boolean
  /**
   * Turns on the shared AI for everyone signed in: an OpenRouter key (sk-or-…) or a Google Gemini
   * key in AI_API (or GEMINI_API_KEY); AI_PROVIDER=openrouter|gemini says which, if the key's
   * shape doesn't. AI_MODEL and AI_TRIAGE_MODEL choose the models.
   */
  ai?: { provider: SharedAiProvider; apiKey: string; model: string; triageModel: string }
}

export class ConfigError extends Error {}

/**
 * Settings can also come from a `.env` file: in the app's folder (development, or a host that puts
 * it there), or in Render's secret files folder (a Secret File named `.env`). Variables set in the
 * environment itself win over the files, and the first file wins over the second.
 */
export const ENV_FILES = ['.env', '/etc/secrets/.env']

/** Reads whichever of the files exist; returns their names (never their contents). */
export function loadEnvFiles(files: string[] = ENV_FILES): string[] {
  return files.filter((file) => {
    if (!existsSync(file)) return false
    process.loadEnvFile(file)
    return true
  })
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ['MONGODB_URI', 'JWT_SECRET'].filter((k) => !env[k]?.trim())
  if (missing.length) {
    throw new ConfigError(
      `Set ${missing.join(' and ')} in the environment (on Render: the service's Environment tab, or a Secret File named .env).`,
    )
  }

  const jwtSecret = env.JWT_SECRET!.trim()
  if (jwtSecret.length < 32) throw new ConfigError('JWT_SECRET must be at least 32 characters of random text.')

  const apiId = Number(env.TELEGRAM_API_ID)
  const aiKey = (env.AI_API ?? env.GEMINI_API_KEY)?.trim()
  const cloud = [env.CLOUDINARY_CLOUD_NAME, env.CLOUDINARY_API_KEY, env.CLOUDINARY_API_SECRET].map((v) => v?.trim())

  return {
    port: Number(env.PORT) || 5001,
    production: env.NODE_ENV === 'production',
    mongoUri: env.MONGODB_URI!.trim(),
    jwtSecret,
    dataKey: dataKey(env.DATA_ENCRYPTION_KEY, jwtSecret),
    googleClientId: env.GOOGLE_CLIENT_ID?.trim() || undefined,
    telegram: apiId && env.TELEGRAM_API_HASH?.trim() ? { apiId, apiHash: env.TELEGRAM_API_HASH.trim() } : undefined,
    cloudinary: cloud.every(Boolean) ? { cloudName: cloud[0]!, apiKey: cloud[1]!, apiSecret: cloud[2]! } : undefined,
    keepAwakeUrl: isOff(env.KEEP_AWAKE) ? undefined : env.KEEP_AWAKE_URL?.trim() || env.RENDER_EXTERNAL_URL?.trim() || undefined,
    temporaryStorage: !isOff(env.TEMPORARY_STORAGE),
    guffshuffUrl: isOff(env.GUFFSHUFF_URL) ? undefined : env.GUFFSHUFF_URL?.trim() || undefined,
    instagram: !isOff(env.INSTAGRAM),
    ai: aiKey ? sharedAi(aiKey, env) : undefined,
  }
}

export type SharedAiProvider = 'openrouter' | 'gemini'

/** Free models by default: OpenRouter's router of free models, or Gemini's Flash models. */
const SHARED_DEFAULTS: Record<SharedAiProvider, { model: string; triageModel: string }> = {
  openrouter: { model: 'openrouter/free', triageModel: 'openrouter/free' },
  gemini: { model: 'gemini-flash-latest', triageModel: 'gemini-flash-lite-latest' },
}

function sharedAi(apiKey: string, env: NodeJS.ProcessEnv): NonNullable<Config['ai']> {
  const named = env.AI_PROVIDER?.trim().toLowerCase()
  if (named && named !== 'openrouter' && named !== 'gemini') throw new ConfigError('AI_PROVIDER must be openrouter or gemini.')
  const provider: SharedAiProvider = (named as SharedAiProvider | undefined) ?? (apiKey.startsWith('sk-or-') ? 'openrouter' : 'gemini')
  const model = env.AI_MODEL?.trim() || SHARED_DEFAULTS[provider].model
  return { provider, apiKey, model, triageModel: env.AI_TRIAGE_MODEL?.trim() || (env.AI_MODEL?.trim() ? model : SHARED_DEFAULTS[provider].triageModel) }
}

const isOff = (value: string | undefined) => /^(off|false|no|0)$/i.test(value?.trim() ?? '')

/**
 * DATA_ENCRYPTION_KEY (32 random bytes, base64) if set; otherwise derived from JWT_SECRET. Either
 * way, changing it makes stored sessions and messages unreadable, so linked accounts must be
 * linked again.
 */
function dataKey(explicit: string | undefined, jwtSecret: string): Buffer {
  if (explicit?.trim()) {
    const key = Buffer.from(explicit.trim(), 'base64')
    if (key.length !== 32) throw new ConfigError('DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded.')
    return key
  }
  return Buffer.from(hkdfSync('sha256', jwtSecret, 'tidings', 'data-encryption', 32))
}
