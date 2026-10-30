import { describe, expect, it } from 'vitest'
import { pickStart } from './schedule'
import { targetLanguage } from '@/store/translations'

describe('picking a time by hand', () => {
  it('starts an hour on, on the next five minutes', () => {
    const now = new Date(2026, 9, 30, 14, 2, 30).getTime()
    expect(pickStart(now)).toEqual(new Date(2026, 9, 30, 15, 5, 0))
    // Already on a five-minute mark: stays on it.
    expect(pickStart(new Date(2026, 9, 30, 14, 10).getTime())).toEqual(new Date(2026, 9, 30, 15, 10))
  })

  it('never hands Intl a language tag it refuses', () => {
    // Some browsers report "en-US@posix"; Intl throws on that, which once broke the picker.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US@posix' }, configurable: true })
    try {
      expect(targetLanguage()).toBe('en-US')
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original)
    }
  })
})
