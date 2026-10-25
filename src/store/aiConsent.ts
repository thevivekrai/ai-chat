import { readJson, storage, writeJson } from '@/data/storage'
import { useSettings } from './settings'

/**
 * Which linked chats AI may read is cleared on sign-out, so someone else signing in on this
 * device doesn't inherit it. It's kept here for the account that signed out, and given back when
 * that account signs in again.
 */
const keyOf = (userId: string) => `tidings.aiConsent.${userId}`

export function keepAiConsent(userId: string, threadIds: string[]) {
  if (threadIds.length) writeJson(keyOf(userId), threadIds)
}

export function restoreAiConsent(userId: string) {
  const ids = readJson<string[]>(keyOf(userId))
  storage.remove(keyOf(userId))
  if (Array.isArray(ids) && ids.length) useSettings.getState().setThreadsAllowed(ids.filter((id) => typeof id === 'string'), true)
}
