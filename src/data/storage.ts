/**
 * localStorage with a safety net: it is unavailable in tests and can throw in private modes or when
 * full, so reads and writes fall back to memory instead of crashing the app.
 */
const memory = new Map<string, string>()

export const storage = {
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
  remove(key: string) {
    memory.delete(key)
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(key)
    } catch {
      // Nothing to clean up.
    }
  },
}

export function readJson<T>(key: string): T | null {
  const raw = storage.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function writeJson(key: string, value: unknown) {
  storage.set(key, JSON.stringify(value))
}
