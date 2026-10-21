import { create } from 'zustand'

/**
 * A shared "now" that ticks every 30 seconds, so relative times ("5m", "unanswered for 2d") and
 * snooze expiry update without every component running its own timer.
 */
export const useClock = create<{ now: number }>(() => ({ now: Date.now() }))

export function startClock(intervalMs = 30_000): () => void {
  const tick = () => useClock.setState({ now: Date.now() })
  const id = setInterval(tick, intervalMs)
  const onVisible = () => document.visibilityState === 'visible' && tick()
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    clearInterval(id)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
