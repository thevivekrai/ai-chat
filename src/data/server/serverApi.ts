import type {
  AuthResult,
  PublicUser,
  ServerFeatures,
  ServerInbox,
  ServerOlderMessages,
  TelegramCodeResult,
  TelegramVerifyResult,
  WhatsAppLinkResult,
} from './types'
import type { Message } from '../types'

/**
 * The Sytext server's HTTP API: same origin, with the session in an httpOnly cookie. Changes are
 * always sent as JSON, which the server requires (it's what keeps other sites from posting forms).
 */

export class ServerError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** True when the session is missing or expired. */
export const isSignedOut = (error: unknown) => error instanceof ServerError && error.status === 401

async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    })
  } catch {
    throw new ServerError(0, "Can't reach the server. Check your connection and try again.")
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok || data === null) {
    throw new ServerError(res.status, data?.error ?? `The server answered with an error (${res.status}).`)
  }
  return data
}

const segment = (id: string) => encodeURIComponent(id)

export const serverApi = {
  /**
   * What the server offers, or null when there is no Sytext server (the app was deployed as a
   * static site, or the API isn't running): the app then works without accounts, as before.
   */
  async features(): Promise<ServerFeatures | null> {
    try {
      const res = await fetch('/api/config', { headers: { Accept: 'application/json' } })
      if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) return null
      return (await res.json()) as ServerFeatures
    } catch {
      return null
    }
  },

  /* ── Signing in ──────────────────────────────────────────────────────────── */

  /** The signed-in user, or null without a session. */
  async me(): Promise<PublicUser | null> {
    try {
      return (await request<{ user: PublicUser }>('GET', '/auth/me')).user
    } catch (error) {
      if (isSignedOut(error)) return null
      throw error
    }
  },
  register: (input: { name: string; email: string; password: string }) => request<AuthResult>('POST', '/auth/register', input),
  login: (input: { email: string; password: string }) => request<AuthResult>('POST', '/auth/login', input),
  google: (credential: string) => request<AuthResult>('POST', '/auth/google', { credential }),
  logout: () => request<{ ok: true }>('POST', '/auth/logout'),

  rename: (name: string) => request<{ user: PublicUser }>('PATCH', '/me', { name }),
  setPassword: (input: { password: string; current?: string }) => request<AuthResult>('POST', '/me/password', input),
  uploadAvatar: (image: string) => request<{ user: PublicUser }>('POST', '/me/avatar', { image }),

  /* ── Linked chats ────────────────────────────────────────────────────────── */

  inbox: () => request<ServerInbox>('GET', '/inbox'),
  send: (threadId: string, body: string, replyToId?: string) =>
    request<{ message: Message }>('POST', `/threads/${segment(threadId)}/messages`, { body, ...(replyToId ? { replyToId } : {}) }),
  markRead: (threadId: string) => request<{ ok: true }>('POST', `/threads/${segment(threadId)}/read`),
  react: (threadId: string, messageId: string, emoji: string | null) =>
    request<{ message: Message }>('POST', `/threads/${segment(threadId)}/reactions`, { messageId, emoji }),
  typing: (threadId: string, typing: boolean) => request<{ ok: true }>('POST', `/threads/${segment(threadId)}/typing`, { typing }),
  older: (threadId: string, beforeId: string) =>
    request<ServerOlderMessages>('GET', `/threads/${segment(threadId)}/messages?before=${segment(beforeId)}`),

  linkWhatsApp: (request_: { method: 'code'; phone: string } | { method: 'qr' }) =>
    request<WhatsAppLinkResult>('POST', '/link/whatsapp', request_),
  unlinkWhatsApp: () => request<{ ok: true }>('DELETE', '/link/whatsapp'),
  telegramCode: (phone: string) => request<TelegramCodeResult>('POST', '/link/telegram/code', { phone }),
  telegramQr: () => request<{ qr: string }>('POST', '/link/telegram/qr'),
  telegramVerify: (code: string) => request<TelegramVerifyResult>('POST', '/link/telegram/verify', { code }),
  telegramPassword: (password: string) => request<TelegramVerifyResult>('POST', '/link/telegram/password', { password }),
  unlinkTelegram: () => request<{ ok: true }>('DELETE', '/link/telegram'),
}
