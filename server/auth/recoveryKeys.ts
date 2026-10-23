import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Recovery keys: given once when an account is made, they reset its password together with the
 * email address, for when the password is forgotten (Sytext sends no email).
 *
 * A key is 25 characters of Crockford's base32, in five groups (125 random bits), like
 * 7K2QP-M9XHD-4T8RW-CZ6NB-J3VFA. That's far too many to guess, so a fast hash is enough to store
 * it, and only the hash is stored. Typing is forgiving: case, spaces and dashes don't matter, and
 * O, I and L are read as 0, 1 and 1.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const LENGTH = 25
const GROUP = 5

export function newRecoveryKey(): string {
  // 256 is a multiple of 32, so taking the low five bits of each byte is unbiased.
  const chars = [...randomBytes(LENGTH)].map((b) => ALPHABET[b & 31])
  const groups: string[] = []
  for (let i = 0; i < LENGTH; i += GROUP) groups.push(chars.slice(i, i + GROUP).join(''))
  return groups.join('-')
}

/** The key as typed, in its stored form, or null if it can't be one. */
export function normalizeRecoveryKey(input: string): string | null {
  const key = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  return key.length === LENGTH && [...key].every((c) => ALPHABET.includes(c)) ? key : null
}

export function hashRecoveryKey(key: string): string {
  return createHash('sha256').update(normalizeRecoveryKey(key) ?? key).digest('hex')
}

export function matchesRecoveryKey(input: string, storedHash: string | undefined): boolean {
  const key = normalizeRecoveryKey(input)
  // Hashed either way, so a malformed key or a missing hash takes as long as a wrong key.
  const actual = createHash('sha256').update(key ?? input).digest()
  const expected = Buffer.from(storedHash ?? '', 'hex')
  return !!key && expected.length === actual.length && timingSafeEqual(actual, expected)
}
