import { useLayoutEffect } from 'react'
import { useMediaQuery } from '@/lib/media'
import { useSettings } from '@/store/settings'

/** Whether the app is in dark mode, from the theme setting and the OS preference. */
export function useDarkMode() {
  const theme = useSettings((s) => s.theme)
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  return theme === 'dark' || (theme === 'system' && systemDark)
}

/** Keeps the `dark` class on <html> in sync with the theme setting and the OS preference. */
export function useApplyTheme() {
  const dark = useDarkMode()

  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b0d10' : '#e8ebf0')
  }, [dark])
}
