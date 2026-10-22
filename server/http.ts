import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express'
import { ObjectId, type Collection } from 'mongodb'
import { SESSION_COOKIE, type SessionTokens } from './auth/tokens.ts'
import type { UserDoc } from './db.ts'

/** An error with a status code and a message that is safe to show the user. */
export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const part of header?.split(';') ?? []) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const name = part.slice(0, index).trim()
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      // Malformed cookie value: ignore it.
    }
  }
  return cookies
}

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('X-Frame-Options', 'DENY')
  // Google's sign-in popup needs to talk back to this window.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')
  next()
}

/**
 * Every request that changes something must be JSON. A cross-site form can't send that without a
 * CORS preflight, which this server never approves, so the session cookie can't be ridden (CSRF).
 */
export const jsonOnly: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.is('application/json')) return next()
  next(new HttpError(415, 'Send JSON.'))
}

/** A small in-memory limiter: enough for one instance; use a shared store when scaling out. */
export function rateLimit({ windowMs, max, name }: { windowMs: number; max: number; name: string }): RequestHandler {
  const hits = new Map<string, number[]>()
  setInterval(() => {
    const cutoff = Date.now() - windowMs
    for (const [key, times] of hits) {
      const recent = times.filter((t) => t > cutoff)
      if (recent.length) hits.set(key, recent)
      else hits.delete(key)
    }
  }, windowMs).unref()

  return (req, res, next) => {
    const key = `${name}:${req.ip}`
    const now = Date.now()
    const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs)
    if (recent.length >= max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000))
      return next(new HttpError(429, 'Too many attempts. Wait a few minutes and try again.'))
    }
    recent.push(now)
    hits.set(key, recent)
    next()
  }
}

/** The signed-in user's id, set by `requireUser`. */
export function userIdOf(res: Response): ObjectId {
  return res.locals.userId as ObjectId
}

/** Lets a request through only with a valid session for a user who still exists. */
export function requireUser(tokens: SessionTokens, users: Collection<UserDoc>): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const session = await tokens.verify(parseCookies(req.headers.cookie)[SESSION_COOKIE])
    if (!session || !ObjectId.isValid(session.userId)) return next(new HttpError(401, 'Sign in to continue.'))
    const userId = new ObjectId(session.userId)
    const user = await users.findOne({ _id: userId }, { projection: { sessionsValidAfter: 1 } })
    const cutoff = user?.sessionsValidAfter ? Math.floor(user.sessionsValidAfter.getTime() / 1000) : 0
    if (!user || session.issuedAt < cutoff) return next(new HttpError(401, 'Sign in to continue.'))
    res.locals.userId = userId
    next()
  }
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  void _next
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message })
    return
  }
  // Body parser errors carry their own status (too large, malformed JSON).
  const status = typeof error?.status === 'number' && error.status >= 400 && error.status < 500 ? error.status : 500
  if (status === 500) console.error(error)
  res.status(status).json({ error: status === 500 ? 'Something went wrong on the server.' : String(error.message ?? 'Bad request') })
}

/** Reads a required string field from a JSON body. */
export function field(body: unknown, name: string, { max = 500, trim = true } = {}): string {
  const value = (body as Record<string, unknown> | undefined)?.[name]
  if (typeof value !== 'string') throw new HttpError(400, `Missing ${name}.`)
  const text = trim ? value.trim() : value
  if (!text) throw new HttpError(400, `Missing ${name}.`)
  if (text.length > max) throw new HttpError(400, `${name} is too long.`)
  return text
}
