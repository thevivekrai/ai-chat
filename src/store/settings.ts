import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { setAiAccessPolicy } from '@/ai'

export type ThemePreference = 'light' | 'dark' | 'system'

interface SettingsState {
  theme: ThemePreference
  /** Master switch: "Allow AI to read selected threads". Off by default. */
  aiEnabled: boolean
  /** The threads the user selected for AI. Nothing is selected until the user opts in. */
  aiThreadIds: string[]
  setTheme(theme: ThemePreference): void
  setAiEnabled(enabled: boolean): void
  setThreadsAllowed(threadIds: string[], allowed: boolean): void
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      aiEnabled: false,
      aiThreadIds: [],
      setTheme: (theme) => set({ theme }),
      setAiEnabled: (aiEnabled) => set({ aiEnabled }),
      setThreadsAllowed: (threadIds, allowed) =>
        set((s) => {
          const ids = new Set(s.aiThreadIds)
          threadIds.forEach((id) => (allowed ? ids.add(id) : ids.delete(id)))
          return { aiThreadIds: [...ids] }
        }),
    }),
    { name: 'tidings.settings', version: 1 },
  ),
)

export function canAiReadThread(state: Pick<SettingsState, 'aiEnabled' | 'aiThreadIds'>, threadId: string) {
  return state.aiEnabled && state.aiThreadIds.includes(threadId)
}

// The AI module enforces consent itself; this is where it learns what the user allowed.
setAiAccessPolicy((threadId) => canAiReadThread(useSettings.getState(), threadId))
