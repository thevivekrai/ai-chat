import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { setAiAccessPolicy, setLlmConfig, type ClaudeModel } from '@/ai'

export type ThemePreference = 'light' | 'dark' | 'system'

export interface ClaudeSettings {
  /** The user's own Anthropic API key. Empty means the built-in demo AI is used. */
  apiKey: string
  model: ClaudeModel
  triageModel: ClaudeModel
}

interface SettingsState {
  theme: ThemePreference
  /** Master switch: "Allow AI to read selected threads". Off by default. */
  aiEnabled: boolean
  /** The threads the user selected for AI. Nothing is selected until the user opts in. */
  aiThreadIds: string[]
  claude: ClaudeSettings
  setTheme(theme: ThemePreference): void
  setAiEnabled(enabled: boolean): void
  setThreadsAllowed(threadIds: string[], allowed: boolean): void
  setClaude(patch: Partial<ClaudeSettings>): void
}

export const DEFAULT_CLAUDE: ClaudeSettings = {
  apiKey: '',
  model: 'claude-opus-5-5',
  // Sorting runs for every allowed chat whenever it changes: the fast model keeps that cheap.
  triageModel: 'claude-haiku-5-5',
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      aiEnabled: false,
      aiThreadIds: [],
      claude: DEFAULT_CLAUDE,
      setTheme: (theme) => set({ theme }),
      setAiEnabled: (aiEnabled) => set({ aiEnabled }),
      setThreadsAllowed: (threadIds, allowed) =>
        set((s) => {
          const ids = new Set(s.aiThreadIds)
          threadIds.forEach((id) => (allowed ? ids.add(id) : ids.delete(id)))
          return { aiThreadIds: [...ids] }
        }),
      setClaude: (patch) => set((s) => ({ claude: { ...s.claude, ...patch } })),
    }),
    {
      name: 'tidings.settings',
      version: 2,
      // v1 had no Claude settings; the defaults fill them in.
      migrate: (persisted) => persisted as SettingsState,
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<SettingsState>
        return { ...current, ...saved, claude: { ...DEFAULT_CLAUDE, ...saved.claude } }
      },
    },
  ),
)

export function canAiReadThread(state: Pick<SettingsState, 'aiEnabled' | 'aiThreadIds'>, threadId: string) {
  return state.aiEnabled && state.aiThreadIds.includes(threadId)
}

/** Whether AI features call Claude (a key is set) rather than the built-in demo AI. */
export function usesClaude(state: Pick<SettingsState, 'claude'>) {
  return state.claude.apiKey.trim() !== ''
}

// The AI module enforces consent itself; this is where it learns what the user allowed.
setAiAccessPolicy((threadId) => canAiReadThread(useSettings.getState(), threadId))

// ...and which model to call, if any.
function syncLlm({ claude }: SettingsState) {
  setLlmConfig(claude.apiKey.trim() ? claude : null)
}
syncLlm(useSettings.getState())
useSettings.subscribe(syncLlm)
