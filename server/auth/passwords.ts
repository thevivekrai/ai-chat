import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto'

/** scrypt, built into Node, so there's no native module to compile on deploy. */
const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(password, salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key))),
  )

const PARAMS = { N: 2 ** 15, r: 8, p: 1 }
const KEY_LENGTH = 64
// Room for N = 2^15: 128 · N · r bytes, plus headroom.
const MAX_MEMORY = 64 * 1024 * 1024

export const MIN_PASSWORD_LENGTH = 8

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, KEY_LENGTH, { ...PARAMS, maxmem: MAX_MEMORY })
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAX_MEMORY,
  })
  return timingSafeEqual(actual, expected)
}

/**
 * Passwords guessers try first: the most used ones, keyboard runs and plain words with numbers.
 * Any of these, however long, falls in minutes to someone trying a list.
 */
const COMMON = new Set(
  (
    'password password1 password12 password123 password1234 passw0rd p@ssw0rd p@ssword 12345678 123456789 1234567890 ' +
    '0123456789 87654321 11111111 00000000 12341234 11223344 abcd1234 1234abcd abc12345 qwertyui qwerty123 qwerty12 ' +
    '1q2w3e4r 1q2w3e4r5t qwertyuiop asdfghjk asdfghjkl zxcvbnm1 iloveyou iloveyou1 sunshine princess football ' +
    'baseball dragon123 monkey123 letmein1 letmein123 welcome1 welcome123 admin123 administrator trustno1 superman ' +
    'starwars whatever computer internet changeme changeme123 secret123 master123 shadow123 michael1 jennifer ' +
    'india123 india@123 bharat123 krishna123 sachin123 pakistan123 mypassword newpassword yourpassword default1 ' +
    'test1234 testtest guest123 login123 sytext123 sytext1234 whatsapp telegram instagram facebook'
  ).split(' '),
)

/** Why a new password is too easy to guess, or null when it's fine. */
export function weakPasswordReason(password: string, { email, name }: { email?: string; name?: string } = {}): string | null {
  const lower = password.toLowerCase()
  if (COMMON.has(lower)) return 'That password is one of the most common ones, so it would be guessed quickly. Choose another.'
  if (/^(.)\1+$/.test(password)) return 'Use more than one repeated character.'
  const digits = '01234567890123456789'
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  if (digits.includes(lower) || [...digits].reverse().join('').includes(lower) || letters.includes(lower) || 'qwertyuiopasdfghjklzxcvbnm'.includes(lower)) {
    return 'A run of keys or numbers is easy to guess. Choose another password.'
  }
  const local = email?.split('@')[0]?.toLowerCase()
  if (local && local.length >= 4 && lower.includes(local)) return "Don't use your email address in your password."
  const first = name?.trim().split(/\s+/)[0]?.toLowerCase()
  if (first && first.length >= 4 && lower.replace(/[^a-z]/g, '') === first) return "Don't make your password just your name."
  return null
}
