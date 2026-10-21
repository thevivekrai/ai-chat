import { useEffect, useLayoutEffect, useRef } from 'react'

/**
 * Runs `run` each time `tick` changes after mount. Used for one-shot requests such as "focus the
 * composer": a component mounting later must not replay an old request.
 */
export function useTickEffect(tick: number, run: () => void) {
  const seen = useRef(tick)
  const latest = useRef(run)
  useLayoutEffect(() => {
    latest.current = run
  })
  useEffect(() => {
    if (tick === seen.current) return
    seen.current = tick
    latest.current()
  }, [tick])
}
