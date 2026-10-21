import { describe, expect, it } from 'vitest'
import { cn } from './cn'

describe('cn', () => {
  it('lets later classes override conflicting earlier ones', () => {
    expect(cn('inline-flex h-5', 'hidden lg:inline-flex')).toBe('h-5 hidden lg:inline-flex')
    expect(cn('max-w-lg', false, 'max-w-2xl')).toBe('max-w-2xl')
  })

  it('knows the custom shadows and animations', () => {
    expect(cn('shadow-xs', 'shadow-card')).toBe('shadow-card')
    expect(cn('animate-pane-in', 'animate-fade-in')).toBe('animate-fade-in')
  })
})
