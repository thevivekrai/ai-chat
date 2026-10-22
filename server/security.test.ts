import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './auth/passwords.ts'
import { createSessionTokens } from './auth/tokens.ts'
import { loadConfig } from './config.ts'
import { createSealer } from './crypto.ts'
import { databaseName } from './db.ts'
import { parseCookies } from './http.ts'
import { fakeGoogle, GOOGLE_CLIENT_ID } from './testing/helpers.ts'

describe('sealing data at rest', () => {
  const sealer = createSealer(Buffer.alloc(32, 1))

  it('round-trips text and JSON without storing the plaintext', () => {
    const sealed = sealer.seal('Bata de jaldi')
    expect(sealed.startsWith('v1:')).toBe(true)
    expect(sealed).not.toContain('jaldi')
    expect(sealer.open(sealed)).toBe('Bata de jaldi')
    expect(sealer.openJson(sealer.sealJson({ body: 'hi', n: 2 }))).toEqual({ body: 'hi', n: 2 })
  })

  it('uses a fresh IV each time', () => {
    expect(sealer.seal('same')).not.toBe(sealer.seal('same'))
  })

  it('refuses tampered data and other keys', () => {
    const sealed = sealer.seal('secret')
    const raw = Buffer.from(sealed.slice(3), 'base64')
    raw[raw.length - 1] ^= 1
    expect(() => sealer.open(`v1:${raw.toString('base64')}`)).toThrow()
    expect(() => createSealer(Buffer.alloc(32, 2)).open(sealed)).toThrow()
  })
})

describe('passwords', () => {
  it('verifies the right password only', async () => {
    const hash = await hashPassword('correct horse')
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('correct horse', hash)).toBe(true)
    expect(await verifyPassword('correct hors', hash)).toBe(false)
    expect(await verifyPassword('anything', 'garbage')).toBe(false)
  })
})

describe('session tokens', () => {
  const tokens = createSessionTokens('s'.repeat(40))

  it('verifies its own tokens and rejects others', async () => {
    const token = await tokens.sign('6650c0ffee0000000000abcd')
    expect(await tokens.verify(token)).toMatchObject({ userId: '6650c0ffee0000000000abcd' })
    expect(await createSessionTokens('t'.repeat(40)).verify(token)).toBeNull()
    expect(await tokens.verify(`${token}x`)).toBeNull()
    expect(await tokens.verify(undefined)).toBeNull()
  })
})

describe('Google ID tokens', () => {
  it('accepts a token signed by Google for this app', async () => {
    const google = await fakeGoogle()
    const profile = await google.verifier(await google.idToken({ sub: 'g-1', email: 'Divya@Example.com', name: 'Divya' }))
    expect(profile).toMatchObject({ sub: 'g-1', email: 'divya@example.com', emailVerified: true, name: 'Divya' })
  })

  it('rejects a token for another app or signed by someone else', async () => {
    const google = await fakeGoogle()
    await expect(google.verifier(await google.idToken({ sub: 'g-1', email: 'a@b.co', aud: 'other-app' }))).rejects.toThrow()
    const impostor = await fakeGoogle()
    await expect(google.verifier(await impostor.idToken({ sub: 'g-1', email: 'a@b.co' }))).rejects.toThrow()
    expect(GOOGLE_CLIENT_ID).toContain('apps.googleusercontent.com')
  })
})

describe('config', () => {
  it('needs a database and a long secret', () => {
    expect(() => loadConfig({})).toThrow(/MONGODB_URI and JWT_SECRET/)
    expect(() => loadConfig({ MONGODB_URI: 'mongodb://x', JWT_SECRET: 'short' })).toThrow(/32 characters/)
  })

  it('switches features on from their variables', () => {
    const config = loadConfig({
      MONGODB_URI: 'mongodb://x',
      JWT_SECRET: 'j'.repeat(32),
      TELEGRAM_API_ID: '123',
      TELEGRAM_API_HASH: 'abc',
      CLOUDINARY_CLOUD_NAME: 'c',
      CLOUDINARY_API_KEY: 'k',
    })
    expect(config.port).toBe(5001)
    expect(config.telegram).toEqual({ apiId: 123, apiHash: 'abc' })
    expect(config.cloudinary).toBeUndefined() // The secret is missing.
    expect(config.googleClientId).toBeUndefined()
    expect(config.dataKey).toHaveLength(32)
  })
})

describe('database name', () => {
  it('comes from the connection string, or defaults', () => {
    expect(databaseName('mongodb+srv://u:p@cluster0.abc.mongodb.net/?retryWrites=true&w=majority')).toBe('tidings')
    expect(databaseName('mongodb+srv://u:p@cluster0.abc.mongodb.net/inbox?retryWrites=true')).toBe('inbox')
    expect(databaseName('mongodb://h1:27017,h2:27017/prod')).toBe('prod')
    expect(databaseName('mongodb://localhost:27017')).toBe('tidings')
  })
})

describe('cookies', () => {
  it('parses a Cookie header', () => {
    expect(parseCookies('a=1; tidings_session=abc%3D; bad=%E0')).toEqual({ a: '1', tidings_session: 'abc=' })
  })
})
