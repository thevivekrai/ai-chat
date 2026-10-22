import { useState } from 'react'

/** Busy and error state for a button that starts async work. */
export function useAsyncAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
      return false
    } finally {
      setBusy(false)
    }
  }
  /** Clears a shown error, e.g. when the form it belonged to changes. */
  const reset = () => setError(null)
  return { busy, error, run, reset }
}
