import { hkdfSync } from 'node:crypto'

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
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ['MONGODB_URI', 'JWT_SECRET'].filter((k) => !env[k]?.trim())
  if (missing.length) throw new ConfigError(`Set ${missing.join(' and ')} in the environment.`)

  const jwtSecret = env.JWT_SECRET!.trim()
  if (jwtSecret.length < 32) throw new ConfigError('JWT_SECRET must be at least 32 characters of random text.')

  const apiId = Number(env.TELEGRAM_API_ID)
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
    keepAwakeUrl: /^(off|false|no|0)$/i.test(env.KEEP_AWAKE?.trim() ?? '')
      ? undefined
      : env.KEEP_AWAKE_URL?.trim() || env.RENDER_EXTERNAL_URL?.trim() || undefined,
  }
}

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
