import { createHash } from 'node:crypto'
import type { ObjectId } from 'mongodb'
import type { Sealer } from '../crypto.ts'
import type { Collections } from '../db.ts'

/** How long a picture (or the lack of one) is trusted before asking the network again. */
const FRESH_FOR_MS = 7 * 24 * 60 * 60 * 1000
/** Pictures bigger than this aren't kept (previews are a few kilobytes). */
const MAX_BYTES = 512 * 1024

/**
 * Profile and group pictures from linked networks, kept on the server (sealed, like everything
 * else of the user's) and served at /api/avatars/<id>. Networks hand out short-lived links, or
 * none at all (Telegram), so a copy is the only way to show them reliably.
 */
export function createAvatars(col: Collections, sealer: Sealer) {
  const urlFor = (id: string, version: string) => `/api/avatars/${encodeURIComponent(id)}?v=${version}`

  return {
    /** Whether the picture was checked recently enough to skip asking again. */
    async fresh(userId: ObjectId, id: string): Promise<boolean> {
      const doc = await col.avatars.findOne({ userId, id }, { projection: { checkedAt: 1 } })
      return !!doc && Date.now() - doc.checkedAt.getTime() < FRESH_FOR_MS
    },

    /** Stores a picture (null: there is none) and returns the URL to show it at, if any. */
    async save(userId: ObjectId, id: string, image: { data: Buffer; contentType: string } | null): Promise<string | null> {
      const checkedAt = new Date()
      if (!image || image.data.length === 0 || image.data.length > MAX_BYTES) {
        await col.avatars.updateOne(
          { userId, id },
          { $set: { checkedAt }, $unset: { data: '', contentType: '', version: '' } },
          { upsert: true },
        )
        return null
      }
      const version = createHash('sha256').update(image.data).digest('hex').slice(0, 12)
      await col.avatars.updateOne(
        { userId, id },
        { $set: { checkedAt, version, contentType: image.contentType, data: sealer.seal(image.data.toString('base64')) } },
        { upsert: true },
      )
      return urlFor(id, version)
    },

    async get(userId: ObjectId, id: string): Promise<{ data: Buffer; contentType: string } | null> {
      const doc = await col.avatars.findOne({ userId, id })
      if (!doc?.data || !doc.contentType) return null
      try {
        return { data: Buffer.from(sealer.open(doc.data), 'base64'), contentType: doc.contentType }
      } catch {
        return null // Sealed with another key.
      }
    },
  }
}

export type Avatars = ReturnType<typeof createAvatars>

/** Downloads a picture from a link a network gave out. */
export async function downloadImage(url: string): Promise<{ data: Buffer; contentType: string } | null> {
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
