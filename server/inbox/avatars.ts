import { createHash } from 'node:crypto'
import type { ObjectId } from 'mongodb'
import type { Sealer } from '../crypto.ts'
import type { Collections } from '../db.ts'

/** How long a picture (or the lack of one) is trusted before asking the network again. */
const FRESH_FOR_MS = 7 * 24 * 60 * 60 * 1000
/** Pictures bigger than this aren't kept (previews are a few kilobytes). */
const MAX_BYTES = 512 * 1024

export interface Picture {
  data: Buffer
  contentType: string
}

/**
 * Profile and group pictures from linked networks, served at /api/avatars/<id>.
 *
 * The database only records that a picture exists, its version and (for WhatsApp) the link it
 * can be downloaded from again: the images themselves are kept in memory, a few megabytes at
 * most, and fetched from the network again when needed. Browsers keep their own copy, since the
 * URL changes whenever the picture does.
 */
export function createAvatars(col: Collections, sealer: Sealer, { cacheBytes = 8 * 1024 * 1024 } = {}) {
  const urlFor = (id: string, version: string) => `/api/avatars/${encodeURIComponent(id)}?v=${version}`
  const keyOf = (userId: ObjectId, id: string) => `${userId.toHexString()}:${id}`

  /** Recently used pictures, least recently used first. */
  const memory = new Map<string, Picture>()
  let bytes = 0

  function remember(userId: ObjectId, id: string, picture: Picture) {
    const key = keyOf(userId, id)
    const old = memory.get(key)
    if (old) bytes -= old.data.length
    memory.delete(key)
    memory.set(key, picture)
    bytes += picture.data.length
    for (const [oldest, image] of memory) {
      if (bytes <= cacheBytes) break
      memory.delete(oldest)
      bytes -= image.data.length
    }
  }

  return {
    /** Whether the picture was checked recently enough to skip asking again. */
    async fresh(userId: ObjectId, id: string): Promise<boolean> {
      const doc = await col.avatars.findOne({ userId, id }, { projection: { checkedAt: 1 } })
      return !!doc && Date.now() - doc.checkedAt.getTime() < FRESH_FOR_MS
    },

    /**
     * Records a picture (null: there is none) and returns the URL to show it at, if any. `source`
     * is a link it can be downloaded from again later, where the network gives one.
     */
    async save(userId: ObjectId, id: string, picture: Picture | null, source?: string): Promise<string | null> {
      const checkedAt = new Date()
      if (!picture || picture.data.length === 0 || picture.data.length > MAX_BYTES) {
        await col.avatars.updateOne({ userId, id }, { $set: { checkedAt }, $unset: { version: '', source: '' } }, { upsert: true })
        return null
      }
      const version = createHash('sha256').update(picture.data).digest('hex').slice(0, 12)
      await col.avatars.updateOne(
        { userId, id },
        source ? { $set: { checkedAt, version, source: sealer.seal(source) } } : { $set: { checkedAt, version }, $unset: { source: '' } },
        { upsert: true },
      )
      remember(userId, id, picture)
      return urlFor(id, version)
    },

    /** Keeps a picture fetched from the network for the next time it's asked for. */
    remember(userId: ObjectId, id: string, picture: Picture) {
      if (picture.data.length > 0 && picture.data.length <= MAX_BYTES) remember(userId, id, picture)
    },

    /** Whether there is a picture for this id (and so whether it's worth asking the network). */
    async known(userId: ObjectId, id: string): Promise<boolean> {
      return !!(await col.avatars.findOne({ userId, id, version: { $exists: true } }, { projection: { _id: 1 } }))
    },

    /** The picture, from memory or the link it came from; null when only the network has it now. */
    async get(userId: ObjectId, id: string): Promise<Picture | null> {
      const key = keyOf(userId, id)
      const cached = memory.get(key)
      if (cached) {
        // Most recently used now.
        memory.delete(key)
        memory.set(key, cached)
        return cached
      }
      const doc = await col.avatars.findOne({ userId, id }, { projection: { version: 1, source: 1 } })
      if (!doc?.version || !doc.source) return null
      let link: string
      try {
        link = sealer.open(doc.source)
      } catch {
        return null // Sealed with another key.
      }
      // Links expire after a few weeks; the network is asked for a new one then.
      const picture = await downloadImage(link).catch(() => null)
      if (picture) remember(userId, id, picture)
      return picture
    },

    /** Drops one network's pictures for a user from memory (on unlink; the store deletes the records). */
    forget(userId: ObjectId, idPrefix: string) {
      const prefix = keyOf(userId, idPrefix)
      for (const [key, image] of memory) {
        if (!key.startsWith(prefix)) continue
        memory.delete(key)
        bytes -= image.data.length
      }
    },

    /** Removes images stored by earlier versions, which kept them in the database. */
    async compact(): Promise<number> {
      const result = await col.avatars.updateMany({ data: { $exists: true } }, { $unset: { data: '', contentType: '' } })
      return result.modifiedCount
    },
  }
}

export type Avatars = ReturnType<typeof createAvatars>

/** Downloads a picture from a link a network gave out. */
export async function downloadImage(url: string): Promise<Picture | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) return null
  const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg'
  if (!contentType.startsWith('image/')) return null
  return { data: Buffer.from(await res.arrayBuffer()), contentType }
}

/**
 * Runs picture downloads one at a time with a pause between them: networks rate-limit lookups,
 * and pictures can wait.
 */
export function createQueue(pauseMs = 400) {
  let tail: Promise<void> = Promise.resolve()
  let running: Promise<void> = Promise.resolve()
  const queued = new Set<string>()
  return {
    add(key: string, work: () => Promise<void>) {
      if (queued.has(key)) return
      queued.add(key)
      tail = tail
        .then(() => {
          running = work().catch((error) => console.error('[avatars]', error instanceof Error ? error.message : error))
          return running
        })
        .then(() => new Promise<void>((resolve) => setTimeout(resolve, pauseMs)))
        .finally(() => queued.delete(key))
    },
    /**
     * Resolves once the download in progress (if any) is done. Jobs that start later see their
     * account was unlinked and do nothing, so this is all unlinking has to wait for.
     */
    settled: () => running,
    /** Resolves once everything queued so far is done (for tests). */
    idle: () => tail,
  }
}

/** Runs at most `concurrency` jobs at once, for pictures someone is waiting to see. */
export function createLimiter(concurrency: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return async function run<T>(work: () => Promise<T>): Promise<T> {
    if (active < concurrency) active++
    else await new Promise<void>((resolve) => waiting.push(resolve)) // Handed a slot when one frees up.
    try {
      return await work()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}
