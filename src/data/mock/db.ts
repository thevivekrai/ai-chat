import type { InboxSnapshot } from '../types'
import { buildSeed, SEED_VERSION } from './seed'

/**
 * The mock "server": one JSON document in localStorage. This is what makes "Chats stored on this
 * device" literally true for the prototype, and why refreshing keeps sent messages, done/snoozed
 * state and tasks.
 */
const STORAGE_KEY = 'tidings.mockdb'

export interface MockDb extends InboxSnapshot {
  version: number
  seededAt: string
  /** Next entry of INCOMING_POOL to deliver when simulating an incoming message. */
  incomingCursor: number
}

// localStorage is unavailable in tests and can throw in private modes; fall back to memory.
const memory = new Map<string, string>()
const storage = {
  get(key: string): string | null {
    try {
      return typeof localStorage === 'undefined' ? (memory.get(key) ?? null) : localStorage.getItem(key)
    } catch {
      return memory.get(key) ?? null
    }
  },
  set(key: string, value: string) {
    try {
      if (typeof localStorage === 'undefined') memory.set(key, value)
      else localStorage.setItem(key, value)
    } catch {
      memory.set(key, value)
    }
  },
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
