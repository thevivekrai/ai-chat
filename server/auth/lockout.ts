import type { ObjectId } from 'mongodb'
import type { Collections, UserDoc } from '../db.ts'
import { HttpError } from '../http.ts'

/**
 * Guessing a password, slowed to a stop: after a few wrong passwords in a row, the account takes
 * none for a while, whichever addresses the guesses come from (the per-address limits alone can be
 * dodged by spreading guesses out). Each lock in a row is longer than the last, up to a day.
 *
 * An email with no account is counted the same way, in memory, so the answers never tell an
 * attacker whether an account exists.
 */

/** Wrong passwords in a row before the account locks. */
export const WRONG_BEFORE_LOCK = 5
const FIRST_LOCK_MS = 15 * 60_000
const LONGEST_LOCK_MS = 24 * 60 * 60_000

export interface SignInGuard {
  /** Wrong passwords since the last lock (or the last success). */
  failures: number
  /** Locks in a row; each one longer. */
  locks: number
  lockedUntil?: Date
  /** Wrong passwords since the owner last signed in, to tell them when they next do. */
  sinceSignIn?: number
}

const lockLength = (locks: number) => Math.min(FIRST_LOCK_MS * 2 ** locks, LONGEST_LOCK_MS)

function lockedError(until: Date) {
  const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000))
  const wait = minutes >= 90 ? `${Math.round(minutes / 60)} hours` : `${minutes} minute${minutes === 1 ? '' : 's'}`
  return new HttpError(
    429,
    `Too many wrong passwords for this account, so it's locked for ${wait}. Nothing was opened. ` +
      'If you forgot your password, reset it with your recovery key or use "Continue with Google".',
  )
}

/** After one more wrong password: locked when that makes too many. */
function afterFailure(guard: SignInGuard | undefined, now: number): SignInGuard {
  const failures = (guard?.failures ?? 0) + 1
  const locks = guard?.locks ?? 0
  const sinceSignIn = (guard?.sinceSignIn ?? 0) + 1
  if (failures < WRONG_BEFORE_LOCK) return { failures, locks, sinceSignIn }
  return { failures: 0, locks: locks + 1, lockedUntil: new Date(now + lockLength(locks)), sinceSignIn }
}

export function signInGuard(col: Collections) {
  /** Emails with no account, guessed at all the same. */
  const strangers = new Map<string, SignInGuard>()
  setInterval(() => {
    const now = Date.now()
    for (const [email, guard] of strangers) if (!guard.lockedUntil || guard.lockedUntil.getTime() < now - LONGEST_LOCK_MS) strangers.delete(email)
  }, 60 * 60_000).unref()

  return {
    /** Refuses at once while the account is locked: not even a right password gets in. */
    check(email: string, user: UserDoc | null) {
      const guard = user ? user.signIn : strangers.get(email)
      if (guard?.lockedUntil && guard.lockedUntil.getTime() > Date.now()) throw lockedError(guard.lockedUntil)
    },

    /** A wrong password: counted, and the account locked when there have been too many. */
    async failed(email: string, user: UserDoc | null) {
      const now = Date.now()
      const fresh = (g: SignInGuard | undefined) => (g?.lockedUntil && g.lockedUntil.getTime() <= now ? { ...g, lockedUntil: undefined } : g)
      if (!user) {
        const next = afterFailure(fresh(strangers.get(email)), now)
        strangers.set(email, next)
        if (next.lockedUntil) throw lockedError(next.lockedUntil)
        return
      }
      // Read again, so guesses sent at the same moment are all counted.
      const current = await col.users.findOne({ _id: user._id }, { projection: { signIn: 1 } })
      const next = afterFailure(fresh(current?.signIn), now)
      await col.users.updateOne({ _id: user._id }, { $set: { signIn: next } })
      if (next.lockedUntil) throw lockedError(next.lockedUntil)
    },

    /** The right password: the count starts again. Returns how many wrong ones came before it. */
    async succeeded(userId: ObjectId, guard: SignInGuard | undefined): Promise<number> {
      if (!guard) return 0
      await col.users.updateOne({ _id: userId }, { $unset: { signIn: '' } })
      return guard.sinceSignIn ?? 0
    },
  }
}

export type SignInGuardian = ReturnType<typeof signInGuard>
