/**
 * Which AI actually runs: the one chosen in Settings → AI, if it can run here. The shared AI needs
 * a signed-in account on a server that offers it, and a provider needs its key; otherwise the
 * built-in demo AI runs. Keeps the AI module (setLlmConfig) in step with that.
 */
import { keyProvider, setLlmConfig, SHARED_AI_NAME, type KeyProviderId, type LlmConfig } from '@/ai'
import { useAi } from './ai'
import { useSession } from './session'
import { useSettings, type AiSettings } from './settings'

export type AiEngine =
  | { kind: 'demo'; name: string }
  | { kind: 'shared'; name: string }
  | { kind: 'key'; name: string; provider: KeyProviderId; model: string; triageModel: string }

const DEMO: AiEngine = { kind: 'demo', name: 'Demo AI' }

/** Whether this server offers the shared AI to this user right now. */
export function sharedAiAvailable(session: { status: string; features: { ai?: boolean } | null }) {
  return session.status === 'signed-in' && !!session.features?.ai
}

export function modelsOf(ai: AiSettings, provider: KeyProviderId) {
  const preset = keyProvider(provider)
  const chosen = ai.models[provider]
  return { model: chosen?.model || preset.model, triageModel: chosen?.triageModel || chosen?.model || preset.triageModel }
}

export function engineOf(ai: AiSettings, sharedAvailable: boolean): AiEngine {
  if (ai.choice === 'demo') return DEMO
  if (ai.choice === 'shared') return sharedAvailable ? { kind: 'shared', name: SHARED_AI_NAME } : DEMO
  const provider = ai.choice
  if (!ai.keys[provider]?.trim() || (provider === 'custom' && !ai.baseUrl.trim())) return DEMO
  const { model, triageModel } = modelsOf(ai, provider)
  if (!model) return DEMO
  return { kind: 'key', name: keyProvider(provider).name, provider, model, triageModel }
}

export function currentAiEngine(): AiEngine {
  return engineOf(useSettings.getState().ai, sharedAiAvailable(useSession.getState()))
}

export function useAiEngine(): AiEngine {
  const ai = useSettings((s) => s.ai)
  const shared = useSession(sharedAiAvailable)
  return engineOf(ai, shared)
}

/** A string that changes whenever results from the engine would differ. */
export const engineKey = (engine: AiEngine) =>
  engine.kind === 'key' ? `${engine.provider}:${engine.model}:${engine.triageModel}` : engine.kind

function configOf(engine: AiEngine, ai: AiSettings): LlmConfig | null {
  if (engine.kind === 'demo') return null
  if (engine.kind === 'shared') return { provider: 'shared' }
  return {
    provider: engine.provider,
    apiKey: ai.keys[engine.provider] ?? '',
    model: engine.model,
    triageModel: engine.triageModel,
    baseUrl: engine.provider === 'custom' ? ai.baseUrl.trim() : undefined,
  }
}

let synced: string | undefined

function sync() {
  const engine = currentAiEngine()
  setLlmConfig(configOf(engine, useSettings.getState().ai))
  // Results from another engine or model are worked out again.
  const key = engineKey(engine)
  if (synced !== undefined && synced !== key) useAi.getState().forgetAll()
  synced = key
}
sync()
useSettings.subscribe(sync)
useSession.subscribe(sync)

/** Where allowed chats go, in one sentence for privacy notes. */
export function engineWhere(engine: AiEngine): string {
  if (engine.kind === 'demo') return 'The built-in demo AI runs on this device.'
  if (engine.kind === 'shared') return "They are sent to Google's Gemini through this app's server."
  return `They are sent to ${engine.name} with your API key.`
}
