import { beforeEach, describe, expect, it, vi } from 'vitest'

// A Claude key saved by the previous version of the app.
const saved = new Map<string, string>([
  [
    'tidings.settings',
    JSON.stringify({
      version: 2,
      state: { theme: 'dark', aiEnabled: true, aiThreadIds: ['t1'], claude: { apiKey: 'sk-ant-old', model: 'claude-sonnet-5-5', triageModel: 'claude-haiku-5-5' } },
    }),
  ],
])
const localStorage = {
  getItem: (k: string) => saved.get(k) ?? null,
  setItem: (k: string, v: string) => void saved.set(k, v),
  removeItem: (k: string) => void saved.delete(k),
}
vi.stubGlobal('localStorage', localStorage)
vi.stubGlobal('window', { localStorage })
vi.mock('@/data/server/serverApi', () => ({ serverApi: {} }))
vi.mock('@/data/server/deviceStore', () => ({ wipeDeviceStore: vi.fn() }))

const { useSettings, DEFAULT_AI } = await import('./settings')
const { useSession } = await import('./session')
const { currentAiEngine, engineOf } = await import('./aiEngine')
const { llmConfigured } = await import('@/ai')
const { useAi } = await import('./ai')

describe('the AI engine', () => {
  it('keeps a Claude key saved by the previous version', () => {
    expect(useSettings.getState()).toMatchObject({ theme: 'dark', aiEnabled: true })
    expect(useSettings.getState().ai).toEqual({
      choice: 'anthropic',
      keys: { anthropic: 'sk-ant-old' },
      models: { anthropic: { model: 'claude-sonnet-5-5', triageModel: 'claude-haiku-5-5' } },
      baseUrl: '',
    })
    expect(currentAiEngine()).toMatchObject({ kind: 'key', name: 'Claude', model: 'claude-sonnet-5-5' })
    expect(llmConfigured()).toBe(true)
  })

  describe('choosing', () => {
    beforeEach(() => useSession.setState({ status: 'signed-out', features: null }))

    it('uses the shared AI only for a signed-in user of a server that offers it', () => {
      useSettings.getState().setAi(DEFAULT_AI)
      expect(currentAiEngine().kind).toBe('demo')
      expect(llmConfigured()).toBe(false)
      useSession.setState({ status: 'signed-in', features: { ai: false } as never })
      expect(currentAiEngine().kind).toBe('demo')
      useSession.setState({ features: { ai: true } as never })
      expect(currentAiEngine()).toEqual({ kind: 'shared', name: 'Shared AI' })
      expect(llmConfigured()).toBe(true)
    })

    it('uses a provider once it has a key (and an address, for "Other")', () => {
      expect(engineOf({ ...DEFAULT_AI, choice: 'google' }, true).kind).toBe('demo')
      expect(engineOf({ ...DEFAULT_AI, choice: 'google', keys: { google: 'AIza' } }, true)).toMatchObject({
        kind: 'key',
        model: 'gemini-flash-latest',
        triageModel: 'gemini-flash-lite-latest',
      })
      const custom = { ...DEFAULT_AI, choice: 'custom' as const, keys: { custom: 'k' }, models: { custom: { model: 'm', triageModel: '' } } }
      expect(engineOf(custom, true).kind).toBe('demo')
      expect(engineOf({ ...custom, baseUrl: 'https://x.example/v1' }, true)).toMatchObject({ kind: 'key', model: 'm', triageModel: 'm' })
      expect(engineOf({ ...DEFAULT_AI, choice: 'demo' }, true).kind).toBe('demo')
    })

    it('works results out again when the engine changes', () => {
      useSettings.getState().setAi({ ...DEFAULT_AI, choice: 'demo' })
      useAi.setState({ summary: { t1: { status: 'done' } as never } })
      useSettings.getState().setAi({ choice: 'openai', keys: { openai: 'sk' } })
      expect(useAi.getState().summary).toEqual({})
    })
  })
})
