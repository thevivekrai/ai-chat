import { useEffect, useState, type RefObject } from 'react'

/**
 * Whether an element is on screen, or nearly (within `margin`). Where the browser can't tell, it's
 * taken to be.
 */
export function useOnScreen(ref: RefObject<Element | null>, margin = '200px'): boolean {
  const [onScreen, setOnScreen] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setOnScreen(!!entry?.isIntersecting), { rootMargin: margin })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, margin])
  return onScreen
}
