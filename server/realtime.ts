import type { Response } from 'express'
import type { ServerEvent } from '../src/data/server/types.ts'

export type { ServerEvent }

export interface Hub {
  /** Streams events to one browser tab until it disconnects. */
  attach(userId: string, res: Response): void
  publish(userId: string, event: ServerEvent): void
  /** Number of open streams, for tests and health checks. */
  size(): number
  closeAll(): void
}

/** Server-sent events: one-way, survives proxies, and the browser reconnects on its own. */
export function createHub({ heartbeatMs = 20_000 } = {}): Hub {
  const streams = new Map<string, Set<Response>>()

  return {
    attach(userId, res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Tell proxies not to buffer the stream.
        'X-Accel-Buffering': 'no',
      })
      res.write(': connected\n\n')
      const set = streams.get(userId) ?? new Set()
      set.add(res)
      streams.set(userId, set)
      // Comments keep idle connections from being closed by proxies along the way.
      const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs)
      res.on('close', () => {
        clearInterval(heartbeat)
        set.delete(res)
        if (set.size === 0) streams.delete(userId)
      })
    },

    publish(userId, event) {
      const set = streams.get(userId)
      if (!set) return
      const frame = `data: ${JSON.stringify(event)}\n\n`
      for (const res of set) res.write(frame)
    },

    size: () => [...streams.values()].reduce((n, s) => n + s.size, 0),

    closeAll() {
      for (const set of streams.values()) for (const res of set) res.end()
      streams.clear()
    },
  }
}
