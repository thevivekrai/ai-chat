import type { ObjectId } from 'mongodb'
import type { Collections, UserDoc } from '../db.ts'
import { HttpError } from '../http.ts'

/**
 * Guessing, slowed to a stop: after a few wrong tries in a row, the account takes none for a
 * while, whichever addresses the tries come from (the per-address limits alone can be dodged by
 * spreading guesses out). A lock that comes straight after another lasts twice as long, up to a
 * day, so guessing on can't make real progress.
 *
 * An email with no account is counted the same way, in memory, so the answers never tell an
 * attacker whether an account exists.
 */

export interface SignInGuard {
  /** Wrong tries since the last lock (or the last success). */
  failures: number
  /** Locks in a row; each one longer. */
  locks: number
  lockedUntil?: Date
  /** Wrong tries since the owner last signed in, to tell them when they next do. */
  sinceSignIn?: number
}

interface Policy {
  /** Where on the account the count is kept. */
  field: 'signIn' | 'answersGuard'
  /** Wrong tries in a row that lock the account. */
  wrongBeforeLock: number
  firstLockMs: number
  /** What the user is told while it's locked, given how long is left ("3 minutes"). */
  locked(wait: string): string
}

const LONGEST_LOCK_MS = 24 * 60 * 60_000

/** Passwords: 7 wrong in a row, and the next try waits 3 minutes (then 6, 12… after more locks). */
export const PASSWORDS: Policy = {
  field: 'signIn',
  wrongBeforeLock: 7,
  firstLockMs: 3 * 60_000,
  locked: (wait) =>
    `Too many wrong passwords. Wait ${wait} and try again. Nothing was opened. Forgot your password? ` +
    'Reset it with your recovery key, or answer your security questions if you lost the key.',
}

/**
 * Security-question answers: fewer tries and longer waits than passwords, since an answer (a
 * school's name) is far easier to guess or look up than a password.
 */
export const ANSWERS: Policy = {
  field: 'answersGuard',
  wrongBeforeLock: 3,
  firstLockMs: 60 * 60_000,
  locked: (wait) => `Too many wrong answers. Wait ${wait} and try again, or use your recovery key.`,
}

function lockedError(policy: Policy, until: Date) {
  const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000))
  const wait = minutes >= 90 ? `${Math.round(minutes / 60)} hours` : `${minutes} minute${minutes === 1 ? '' : 's'}`
  return new HttpError(429, policy.locked(wait))
}

/** After one more wrong try: locked when that makes too many. */
function afterFailure(policy: Policy, guard: SignInGuard | undefined, now: number): SignInGuard {
  const failures = (guard?.failures ?? 0) + 1
  const locks = guard?.locks ?? 0
  const sinceSignIn = (guard?.sinceSignIn ?? 0) + 1
  if (failures < policy.wrongBeforeLock) return { failures, locks, sinceSignIn }
  const length = Math.min(policy.firstLockMs * 2 ** locks, LONGEST_LOCK_MS)
  return { failures: 0, locks: locks + 1, lockedUntil: new Date(now + length), sinceSignIn }
}

export function signInGuard(col: Collections, policy: Policy = PASSWORDS) {
  /** Emails with no account, guessed at all the same. */
  const strangers = new Map<string, SignInGuard>()
  setInterval(() => {
    const now = Date.now()
    for (const [email, guard] of strangers) if (!guard.lockedUntil || guard.lockedUntil.getTime() < now - LONGEST_LOCK_MS) strangers.delete(email)
  }, 60 * 60_000).unref()

  return {
    /** Refuses at once while the account is locked: not even a right password gets in. */
    check(email: string, user: UserDoc | null) {
      const guard = user ? user[policy.field] : strangers.get(email)
      if (guard?.lockedUntil && guard.lockedUntil.getTime() > Date.now()) throw lockedError(policy, guard.lockedUntil)
    },

    /** A wrong try: counted, and the account locked when there have been too many. */
    async failed(email: string, user: UserDoc | null) {
      const now = Date.now()
      const fresh = (g: SignInGuard | undefined) => (g?.lockedUntil && g.lockedUntil.getTime() <= now ? { ...g, lockedUntil: undefined } : g)
      if (!user) {
        const next = afterFailure(policy, fresh(strangers.get(email)), now)
        strangers.set(email, next)
        if (next.lockedUntil) throw lockedError(policy, next.lockedUntil)
        return
      }
      // Read again, so tries sent at the same moment are all counted.
      const current = await col.users.findOne({ _id: user._id }, { projection: { [policy.field]: 1 } })
      const next = afterFailure(policy, fresh(current?.[policy.field]), now)
      await col.users.updateOne({ _id: user._id }, { $set: { [policy.field]: next } })
      if (next.lockedUntil) throw lockedError(policy, next.lockedUntil)
    },

    /** The right one: the count starts again. Returns how many wrong ones came before it. */
    async succeeded(userId: ObjectId, guard: SignInGuard | undefined): Promise<number> {
      if (!guard) return 0
      await col.users.updateOne({ _id: userId }, { $unset: { [policy.field]: '' } })
      return guard.sinceSignIn ?? 0
    },
  }
}

export type SignInGuardian = ReturnType<typeof signInGuard>
