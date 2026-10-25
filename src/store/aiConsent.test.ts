import { expect, it } from 'vitest'
import { keepAiConsent, restoreAiConsent } from './aiConsent'
import { useSettings } from './settings'

it("gives an account's AI choices back when it signs in again, and to nobody else", () => {
  useSettings.setState({ aiThreadIds: [] })
  keepAiConsent('u1', ['wa:ravi', 'tga:asha'])

  restoreAiConsent('u2')
  expect(useSettings.getState().aiThreadIds).toEqual([])

  restoreAiConsent('u1')
  expect(useSettings.getState().aiThreadIds).toEqual(['wa:ravi', 'tga:asha'])

  // Given back once: signing in again later doesn't re-add chats turned off since.
  useSettings.setState({ aiThreadIds: [] })
  restoreAiConsent('u1')
  expect(useSettings.getState().aiThreadIds).toEqual([])
})
