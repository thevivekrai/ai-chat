import { Router, type Response } from 'express'
import { ObjectId, type MongoServerError } from 'mongodb'
import type { PublicUser } from '../../src/data/server/types.ts'
import type { Collections, UserDoc } from '../db.ts'
import { field, HttpError, rateLimit, requireUser, userIdOf } from '../http.ts'
import type { Media } from '../media.ts'
import type { Hub } from '../realtime.ts'
import type { GoogleVerifier } from './google.ts'
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './passwords.ts'
import { hashRecoveryKey, matchesRecoveryKey, newRecoveryKey } from './recoveryKeys.ts'
import { SESSION_COOKIE, SESSION_DAYS, type SessionTokens } from './tokens.ts'

export const toPublicUser = (u: UserDoc): PublicUser => ({
  id: u._id.toHexString(),
  email: u.email,
  name: u.name,
  ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
  hasPassword: !!u.passwordHash,
  google: !!u.googleSub,
  ...(u.recoveryKeyHash && u.recoveryKeyCreatedAt ? { recoveryKeyCreatedAt: u.recoveryKeyCreatedAt.toISOString() } : {}),
  ...(u.incognito ? { incognito: true } : {}),
})

/** The new password a request sets, if it's long enough. */
function newPassword(body: unknown): string {
  const password = field(body, 'password', { max: 200, trim: false })
  if (password.length < MIN_PASSWORD_LENGTH) throw new HttpError(400, `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`)
  return password
}

/** Changing what protects the account takes the current password. */
async function requireCurrentPassword(body: unknown, passwordHash: string) {
  const current = typeof (body as { current?: unknown })?.current === 'string' ? (body as { current: string }).current : ''
  if (!(await verifyPassword(current, passwordHash))) throw new HttpError(400, "Your current password isn't right.")
}

/** A new recovery key, and what to store for it. */
function recoveryKeyFields(now: Date) {
  const recoveryKey = newRecoveryKey()
  return { recoveryKey, fields: { recoveryKeyHash: hashRecoveryKey(recoveryKey), recoveryKeyCreatedAt: now } }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Verifying against a throwaway hash keeps "no such user" as slow as "wrong password".
const DUMMY_HASH = hashPassword('not-a-real-password')

interface AuthDeps {
  col: Collections
  /** Tells the user's other devices when the account changes. */
  hub?: Hub
  tokens: SessionTokens
  google: GoogleVerifier | null
  media: Media | null
  secureCookies: boolean
}

export function authRoutes({ col, hub, tokens, google, media, secureCookies }: AuthDeps): Router {
  const router = Router()
  const limited = rateLimit({ name: 'auth', windowMs: 15 * 60_000, max: 30 })
  // Resetting a password is rarer still, and a guess at a recovery key is worth slowing down.
  const recovering = rateLimit({ name: 'recover', windowMs: 15 * 60_000, max: 10 })

  async function startSession(res: Response, user: UserDoc, extra: Record<string, unknown> = {}) {
    res.cookie(SESSION_COOKIE, await tokens.sign(user._id.toHexString()), {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    })
    res.json({ user: toPublicUser(user), ...extra })
  }

  router.post('/auth/register', limited, async (req, res) => {
    const name = field(req.body, 'name', { max: 80 })
    const email = field(req.body, 'email', { max: 254 }).toLowerCase()
    if (!EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email address.')
    const password = newPassword(req.body)
    const existing = await col.users.findOne({ email })
    if (existing) {
      throw new HttpError(
        409,
        existing.passwordHash
          ? 'An account with this email already exists. Sign in instead.'
          : 'This email signs in with Google. Use "Continue with Google".',
      )
    }
    const now = new Date()
    // Sytext sends no email, so a forgotten password is reset with this key instead: shown once, now.
    const { recoveryKey, fields } = recoveryKeyFields(now)
    const user: UserDoc = {
      _id: new ObjectId(),
      email,
      name,
      passwordHash: await hashPassword(password),
      ...fields,
      createdAt: now,
      updatedAt: now,
    }
    try {
      await col.users.insertOne(user)
    } catch (error) {
      if ((error as MongoServerError).code === 11000) throw new HttpError(409, 'An account with this email already exists.')
      throw error
    }
    await startSession(res, user, { recoveryKey })
  })

  /**
   * A forgotten password: the email address and the recovery key set a new one. The key is used up
   * (a new one is given instead), and the account's other sessions end.
   */
  router.post('/auth/recover', recovering, async (req, res) => {
    const email = field(req.body, 'email', { max: 254 }).toLowerCase()
    const key = field(req.body, 'recoveryKey', { max: 100 })
    const password = newPassword(req.body)
    const mismatch = new HttpError(401, "That email and recovery key don't match. Use the key you saved when you made your account.")
    const user = await col.users.findOne({ email })
    if (!matchesRecoveryKey(key, user?.recoveryKeyHash) || !user) throw mismatch
    const now = new Date()
    const { recoveryKey, fields } = recoveryKeyFields(now)
    // Only while the key is still the one just checked, so it can't be used twice at once.
    const updated = await col.users.findOneAndUpdate(
      { _id: user._id, recoveryKeyHash: user.recoveryKeyHash },
      { $set: { passwordHash: await hashPassword(password), ...fields, sessionsValidAfter: now, updatedAt: now } },
      { returnDocument: 'after' },
    )
    if (!updated) throw mismatch
    await startSession(res, updated, { recoveryKey })
  })

  router.post('/auth/login', limited, async (req, res) => {
    const email = field(req.body, 'email', { max: 254 }).toLowerCase()
    const password = field(req.body, 'password', { max: 200, trim: false })
    const user = await col.users.findOne({ email })
    const ok = await verifyPassword(password, user?.passwordHash ?? (await DUMMY_HASH))
    if (user && !user.passwordHash) throw new HttpError(400, 'This account signs in with Google. Use "Continue with Google".')
    if (!user || !ok) throw new HttpError(401, 'Wrong email or password.')
    await startSession(res, user)
  })

  router.post('/auth/google', limited, async (req, res) => {
    if (!google) throw new HttpError(404, 'Google sign-in is not set up on this server.')
    let profile
    try {
      profile = await google(field(req.body, 'credential', { max: 4096 }))
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(401, 'Google sign-in failed. Try again.')
    }
    if (!profile.emailVerified) throw new HttpError(401, 'Your Google email address is not verified.')

    const now = new Date()
    let user = await col.users.findOne({ googleSub: profile.sub })
    let passwordRemoved = false
    if (!user) {
      // Same verified email: link Google to the existing account. Its password is turned off and
      // its sessions ended: email addresses aren't verified on sign-up, so whoever set that
      // password may not own the address (and would otherwise keep a way in).
      const existing = await col.users.findOne({ email: profile.email })
      if (existing) {
        passwordRemoved = !!existing.passwordHash
        user = await col.users.findOneAndUpdate(
          { _id: existing._id },
          {
            $set: { googleSub: profile.sub, updatedAt: now, ...(passwordRemoved ? { sessionsValidAfter: now } : {}) },
            // The recovery key goes too, for the same reason: it would set a new password.
            $unset: { recoveryKeyHash: '', recoveryKeyCreatedAt: '', ...(passwordRemoved ? { passwordHash: '' } : {}) },
          },
          { returnDocument: 'after' },
        )
      }
    }
    if (!user) {
      user = {
        _id: new ObjectId(),
        email: profile.email,
        name: profile.name ?? profile.email.split('@')[0],
        googleSub: profile.sub,
        ...(profile.picture ? { avatarUrl: profile.picture } : {}),
        createdAt: now,
        updatedAt: now,
      }
      await col.users.insertOne(user)
    }
    await startSession(res, user, passwordRemoved ? { passwordRemoved } : {})
  })

  router.post('/auth/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: secureCookies, sameSite: 'lax' })
    res.json({ ok: true })
  })

  const signedIn = requireUser(tokens, col.users)

  router.get('/auth/me', signedIn, async (_req, res) => {
    const user = await col.users.findOne({ _id: userIdOf(res) })
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    res.json({ user: toPublicUser(user) })
  })

  /** Changes the name, or turns Incognito mode on or off. */
  router.patch('/me', signedIn, async (req, res) => {
    const set: Partial<UserDoc> = {}
    if (req.body?.name !== undefined) set.name = field(req.body, 'name', { max: 80 })
    if (req.body?.incognito !== undefined) {
      if (typeof req.body.incognito !== 'boolean') throw new HttpError(400, 'Say whether to turn Incognito mode on.')
      set.incognito = req.body.incognito
    }
    if (!Object.keys(set).length) throw new HttpError(400, 'Nothing to change.')
    const user = await col.users.findOneAndUpdate(
      { _id: userIdOf(res) },
      { $set: { ...set, updatedAt: new Date() } },
      { returnDocument: 'after' },
    )
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    // Every device follows at once: Incognito mode most of all.
    hub?.publish(user._id.toHexString(), { type: 'user.updated', user: toPublicUser(user) })
    res.json({ user: toPublicUser(user) })
  })

  /** Sets a password (Google-only accounts) or changes it (with the current one). */
  router.post('/me/password', signedIn, limited, async (req, res) => {
    const password = newPassword(req.body)
    const user = await col.users.findOne({ _id: userIdOf(res) })
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    if (user.passwordHash) await requireCurrentPassword(req.body, user.passwordHash)
    const now = new Date()
    // A new recovery key too: the old one could have been made by anyone who knew the old password,
    // and would let them take the account back.
    const { recoveryKey, fields } = recoveryKeyFields(now)
    // Other sessions end; this one carries on with a fresh token.
    const updated = await col.users.findOneAndUpdate(
      { _id: user._id },
      { $set: { passwordHash: await hashPassword(password), ...fields, sessionsValidAfter: now, updatedAt: now } },
      { returnDocument: 'after' },
    )
    await startSession(res, updated!, { recoveryKey })
  })

  /** A new recovery key, replacing the old one (which stops working). Needs the current password. */
  router.post('/me/recovery-key', signedIn, limited, async (req, res) => {
    const user = await col.users.findOne({ _id: userIdOf(res) })
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    if (!user.passwordHash) throw new HttpError(400, 'Set a password first: a recovery key is for resetting it.')
    await requireCurrentPassword(req.body, user.passwordHash)
    const now = new Date()
    const { recoveryKey, fields } = recoveryKeyFields(now)
    const updated = await col.users.findOneAndUpdate(
      { _id: user._id },
      { $set: { ...fields, updatedAt: now } },
      { returnDocument: 'after' },
    )
    if (!updated) throw new HttpError(401, 'Sign in to continue.')
    res.json({ user: toPublicUser(updated), recoveryKey })
  })

  router.post('/me/avatar', signedIn, async (req, res) => {
    if (!media) throw new HttpError(404, 'Photo uploads are not set up on this server.')
    const dataUrl = field(req.body, 'image', { max: 7_000_000 })
    if (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(dataUrl)) throw new HttpError(400, 'Upload a PNG, JPEG, WebP or GIF image.')
    const avatarUrl = await media.uploadDataUrl(dataUrl, 'avatars')
    const user = await col.users.findOneAndUpdate(
      { _id: userIdOf(res) },
      { $set: { avatarUrl, updatedAt: new Date() } },
      { returnDocument: 'after' },
    )
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    res.json({ user: toPublicUser(user) })
  })

  return router
}
