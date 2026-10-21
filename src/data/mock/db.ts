import { storage } from '../storage'
import type { InboxSnapshot } from '../types'
import { buildSeed, SEED_VERSION } from './seed'

/**
 * The demo inbox's "server": one JSON document in localStorage, so refreshing keeps sent
 * messages and done/snoozed state in the demo chats.
 */
const STORAGE_KEY = 'tidings.mockdb'

export interface MockDb extends InboxSnapshot {
  version: number
  seededAt: string
  /** Next entry of INCOMING_POOL to deliver when simulating an incoming message. */
  incomingCursor: number
}

export function seedDb(now: number = Date.now()): MockDb {
  return { version: SEED_VERSION, seededAt: new Date(now).toISOString(), incomingCursor: 0, ...buildSeed(now) }
}

export function loadDb(): MockDb {
  const raw = storage.get(STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as MockDb
      if (parsed.version === SEED_VERSION) return parsed
    } catch {
      // Corrupt or foreign data: reseed below.
    }
  }
  const db = seedDb()
  saveDb(db)
  return db
}

export function saveDb(db: MockDb) {
  storage.set(STORAGE_KEY, JSON.stringify(db))
}
