import { useSyncExternalStore } from 'react'

/** Mirrors the Tailwind breakpoints the layout uses (`wide` is defined in index.css). */
export const BREAKPOINTS = { md: 768, lg: 1024, xl: 1280, wide: 1440 } as const

export type Breakpoint = keyof typeof BREAKPOINTS

const queryFor = (bp: Breakpoint) => `(min-width: ${BREAKPOINTS[bp]}px)`

export function isAtLeast(bp: Breakpoint): boolean {
  return typeof window !== 'undefined' && window.matchMedia(queryFor(bp)).matches
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

export const useBreakpoint = (bp: Breakpoint) => useMediaQuery(queryFor(bp))

export const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)
