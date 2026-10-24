import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAi } from '@/store/ai'
import { useInbox } from '@/store/inbox'
import { engineKey, useAiEngine } from '@/store/aiEngine'
import { useSettings } from '@/store/settings'

/**
 * Keeps every AI-readable thread classified, so the Needs-reply queue is always sorted by priority.
 * Results are cached per thread state, so this only calls the model for new or changed threads.
 */
export function useAiAutopilot() {
  const { status, threads, messages } = useInbox(
    useShallow((s) => ({ status: s.status, threads: s.threads, messages: s.messages })),
  )
  const { aiEnabled, aiThreadIds } = useSettings(useShallow((s) => ({ aiEnabled: s.aiEnabled, aiThreadIds: s.aiThreadIds })))
  const engine = engineKey(useAiEngine())
  // Cleared when the user retries after a setup problem (bad key, unavailable model).
  const problem = useAi((s) => s.problem)

  useEffect(() => {
    if (status !== 'ready' || !aiEnabled || problem) return
    for (const id of aiThreadIds) if (threads[id]) useAi.getState().ensurePriority(id)
  }, [status, aiEnabled, aiThreadIds, threads, messages, engine, problem])
}
