import { expect, it, vi } from 'vitest'

// Settings saved by the version where the shared AI was the default.
const saved = new Map<string, string>([
  ['tidings.settings', JSON.stringify({ version: 3, state: { theme: 'dark', ai: { choice: 'shared', keys: { google: 'AIza-kept' }, models: {}, baseUrl: '' } } })],
])
const localStorage = {
  getItem: (k: string) => saved.get(k) ?? null,
  setItem: (k: string, v: string) => void saved.set(k, v),
  removeItem: (k: string) => void saved.delete(k),
}
vi.stubGlobal('localStorage', localStorage)
vi.stubGlobal('window', { localStorage })

const { useSettings } = await import('./settings')

it('moves settings from when the shared AI was the default onto the demo AI, keeping keys', () => {
  expect(useSettings.getState().theme).toBe('dark')
  expect(useSettings.getState().ai).toMatchObject({ choice: 'demo', keys: { google: 'AIza-kept' } })
})
