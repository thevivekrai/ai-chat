import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAiAccessPolicy, setLlmConfig, translate } from '.'

describe('translating a message', () => {
  beforeEach(() => setAiAccessPolicy(() => true))
  afterEach(() => {
    setLlmConfig(null)
    vi.unstubAllGlobals()
  })

  it('translates on the device when the browser can, sending nothing anywhere', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('LanguageDetector', { create: async () => ({ detect: async () => [{ detectedLanguage: 'hi', confidence: 0.9 }] }) })
    vi.stubGlobal('Translator', {
      availability: async () => 'available',
      create: async () => ({ translate: async (t: string) => `[en] ${t}` }),
    })
    setLlmConfig({ provider: 'shared' })
    expect(await translate('t1', 'Kal milte hain', 'en')).toEqual({ text: '[en] Kal milte hain', from: 'Hindi', by: 'device' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('asks the AI otherwise, for a chat it may read', async () => {
    setLlmConfig({ provider: 'shared' })
    let sent: { task?: string; system?: string } = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body))
        return new Response(JSON.stringify({ output: { text: "See you tomorrow", from: 'Hindi' } }), { status: 200 })
      }),
    )
    expect(await translate('t1', 'Kal milte hain', 'en-GB')).toEqual({ text: 'See you tomorrow', from: 'Hindi', by: 'ai' })
    expect(sent.task).toBe('translate')
    expect(sent.system).toMatch(/British English|English/)

    // Not for a chat the AI isn't allowed to read.
    setAiAccessPolicy(() => false)
    await expect(translate('t2', 'Kal milte hain', 'en')).rejects.toThrow(/not allowed/i)
  })

  it('says what is needed when there is no AI to ask', async () => {
    await expect(translate('t1', 'Kal milte hain', 'en')).rejects.toThrow(/shared AI/)
  })
})
