import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { isKeyProvider, setAiAccessPolicy, type KeyProviderId } from '@/ai'

export type ThemePreference = 'light' | 'dark' | 'system'

/**
 * "shared": the app's own AI, for signed-in users of a server that offers it. "demo": the built-in
 * demo AI, which never sends chats anywhere. Otherwise a provider the user brought a key for.
 */
export type AiChoice = 'shared' | 'demo' | KeyProviderId

export interface AiSettings {
  choice: AiChoice
  /** The user's own API keys, kept only in this browser. */
  keys: Partial<Record<KeyProviderId, string>>
  /** Model choices per provider; the provider's defaults until changed. */
  models: Partial<Record<KeyProviderId, { model: string; triageModel: string }>>
  /** The address of an "Other (OpenAI-compatible)" service. */
  baseUrl: string
}

interface SettingsState {
  theme: ThemePreference
  /** Master switch: "Allow AI to read selected threads". Off by default. */
  aiEnabled: boolean
  /** The threads the user selected for AI. Nothing is selected until the user opts in. */
  aiThreadIds: string[]
  ai: AiSettings
  /** Incognito mode on this device, without an account (an account keeps its own, for every device). */
  incognito: boolean
  setTheme(theme: ThemePreference): void
  setIncognito(on: boolean): void
  setAiEnabled(enabled: boolean): void
  setThreadsAllowed(threadIds: string[], allowed: boolean): void
  setAi(patch: Partial<AiSettings>): void
}

export const DEFAULT_AI: AiSettings = { choice: 'shared', keys: {}, models: {}, baseUrl: '' }

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      aiEnabled: false,
      aiThreadIds: [],
      ai: DEFAULT_AI,
      incognito: false,
      setTheme: (theme) => set({ theme }),
      setIncognito: (incognito) => set({ incognito }),
      setAiEnabled: (aiEnabled) => set({ aiEnabled }),
      setThreadsAllowed: (threadIds, allowed) =>
        set((s) => {
          const ids = new Set(s.aiThreadIds)
          threadIds.forEach((id) => (allowed ? ids.add(id) : ids.delete(id)))
          return { aiThreadIds: [...ids] }
        }),
      setAi: (patch) => set((s) => ({ ai: { ...s.ai, ...patch } })),
    }),
    {
      name: 'tidings.settings',
      version: 3,
      // v1 had no AI settings and v2 only a Claude key; a saved Claude key stays the choice.
      migrate: (persisted) => persisted as SettingsState,
      merge: (persisted, current) => {
        const { claude, ...saved } = (persisted ?? {}) as Partial<SettingsState> & { claude?: LegacyClaude }
        return { ...current, ...saved, ai: savedAi(saved.ai, claude) }
      },
      partialize: (s) => ({ theme: s.theme, aiEnabled: s.aiEnabled, aiThreadIds: s.aiThreadIds, ai: s.ai, incognito: s.incognito }),
    },
  ),
)

export function canAiReadThread(state: Pick<SettingsState, 'aiEnabled' | 'aiThreadIds'>, threadId: string) {
  return state.aiEnabled && state.aiThreadIds.includes(threadId)
}

interface LegacyClaude {
  apiKey?: string
  model?: string
  triageModel?: string
}

function savedAi(ai: Partial<AiSettings> | undefined, claude: LegacyClaude | undefined): AiSettings {
  if (ai) {
    const choice = ai.choice === 'shared' || ai.choice === 'demo' || isKeyProvider(ai.choice ?? '') ? ai.choice! : 'shared'
    return { ...DEFAULT_AI, ...ai, choice }
  }
  const key = claude?.apiKey?.trim()
  if (!key) return DEFAULT_AI
  const models = claude?.model && claude.triageModel ? { anthropic: { model: claude.model, triageModel: claude.triageModel } } : {}
  return { ...DEFAULT_AI, choice: 'anthropic', keys: { anthropic: key }, models }
}

// The AI module enforces consent itself; this is where it learns what the user allowed.
setAiAccessPolicy((threadId) => canAiReadThread(useSettings.getState(), threadId))
