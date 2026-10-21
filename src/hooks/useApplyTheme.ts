import { useLayoutEffect } from 'react'
import { useMediaQuery } from '@/lib/media'
import { useSettings } from '@/store/settings'

/** Keeps the `dark` class on <html> in sync with the theme setting and the OS preference. */
export function useApplyTheme() {
  const theme = useSettings((s) => s.theme)
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  const dark = theme === 'dark' || (theme === 'system' && systemDark)

  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#09090b' : '#f3f3f5')
  }, [dark])
}
