import { describe, expect, it } from 'vitest'
import { hashRecoveryKey, matchesRecoveryKey, newRecoveryKey, normalizeRecoveryKey } from './recoveryKeys.ts'

describe('recovery keys', () => {
  it('are five groups of five unambiguous characters, different every time', () => {
    const keys = new Set(Array.from({ length: 200 }, newRecoveryKey))
    expect(keys.size).toBe(200)
    for (const key of keys) expect(key).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){4}[0-9A-HJKMNP-TV-Z]{5}$/)
  })

  it('match however they are typed', () => {
    const key = newRecoveryKey()
    const hash = hashRecoveryKey(key)
    expect(matchesRecoveryKey(key, hash)).toBe(true)
    expect(matchesRecoveryKey(key.toLowerCase(), hash)).toBe(true)
    expect(matchesRecoveryKey(key.replace(/-/g, ' '), hash)).toBe(true)
    expect(matchesRecoveryKey(` ${key.replace(/-/g, '')} `, hash)).toBe(true)
  })

  it('read O, I and L as 0, 1 and 1', () => {
    expect(normalizeRecoveryKey('o0iIl-11111-11111-11111-11111')).toBe('0011111111111111111111111')
  })

  it("don't match another key, a malformed one, or an account without one", () => {
    const hash = hashRecoveryKey(newRecoveryKey())
    expect(matchesRecoveryKey(newRecoveryKey(), hash)).toBe(false)
    expect(matchesRecoveryKey('', hash)).toBe(false)
    expect(matchesRecoveryKey('not a key', hash)).toBe(false)
    expect(matchesRecoveryKey('UUUUU-UUUUU-UUUUU-UUUUU-UUUUU', hash)).toBe(false)
    expect(matchesRecoveryKey(newRecoveryKey(), undefined)).toBe(false)
  })
})
