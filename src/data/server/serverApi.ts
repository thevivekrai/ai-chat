import type {
  AuthResult,
  MessageHint,
  PublicUser,
  ServerFeatures,
  ServerInbox,
  ServerOlderMessages,
  TelegramCodeResult,
  TelegramVerifyResult,
  WhatsAppLinkResult,
} from './types'
import type { Message, MessageAction } from '../types'

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
  /** A forgotten password: the email and recovery key set a new one (and a new key comes back). */
  recover: (input: { email: string; recoveryKey: string; password: string }) => request<AuthResult>('POST', '/auth/recover', input),
  newRecoveryKey: (current: string) => request<{ user: PublicUser; recoveryKey: string }>('POST', '/me/recovery-key', { current }),

  rename: (name: string) => request<{ user: PublicUser }>('PATCH', '/me', { name }),
  setPassword: (input: { password: string; current?: string }) => request<AuthResult>('POST', '/me/password', input),
  uploadAvatar: (image: string) => request<{ user: PublicUser }>('POST', '/me/avatar', { image }),

  /* ── Linked chats ────────────────────────────────────────────────────────── */

  inbox: () => request<ServerInbox>('GET', '/inbox'),
  /**
   * The hints say what this device knows of a message, for the server to act on it if it no longer
   * keeps it (it keeps only the latest of each chat).
   */
  send: (threadId: string, body: string, replyToId?: string, replyTo?: MessageHint) =>
    request<{ message: Message }>('POST', `/threads/${segment(threadId)}/messages`, {
      body,
      ...(replyToId ? { replyToId } : {}),
      ...(replyTo ? { replyTo } : {}),
    }),
  markRead: (threadId: string) => request<{ ok: true }>('POST', `/threads/${segment(threadId)}/read`),
  /** The message as the server now has it, or null when it no longer keeps it. */
  react: (threadId: string, messageId: string, emoji: string | null, message?: MessageHint) =>
    request<{ message: Message | null }>('POST', `/threads/${segment(threadId)}/reactions`, {
      messageId,
      emoji,
      ...(message ? { message } : {}),
    }),
  /**
   * Sends a photo or file, with `caption` as its text. The body is the file itself; headers say
   * what it is (and require this site's own code to send it: other sites can't set them).
   */
  async sendFile(threadId: string, file: File, caption: string, replyToId?: string, replyTo?: MessageHint): Promise<{ message: Message }> {
    let res: Response
    try {
      res = await fetch(`/api/threads/${segment(threadId)}/files`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name || 'file'),
          'X-File-Type': file.type || 'application/octet-stream',
          ...(caption ? { 'X-Caption': encodeURIComponent(caption) } : {}),
          ...(replyToId ? { 'X-Reply-To': encodeURIComponent(replyToId) } : {}),
          ...(replyTo ? { 'X-Reply-Hint': encodeURIComponent(JSON.stringify(replyTo)) } : {}),
        },
        body: file,
      })
    } catch {
      throw new ServerError(0, "Can't reach the server. Check your connection and try again.")
    }
    const data = (await res.json().catch(() => null)) as ({ message: Message } & { error?: string }) | null
    if (!res.ok || data === null) throw new ServerError(res.status, data?.error ?? `The server answered with an error (${res.status}).`)
    return data
  },
  /** The message as the server now has it (null when it no longer keeps it), and whether it's gone. */
  messageAction: (threadId: string, messageId: string, action: MessageAction, message?: MessageHint) =>
    request<{ message: Message | null; removed?: boolean }>('POST', `/threads/${segment(threadId)}/message-actions`, {
      messageId,
      action,
      ...(message ? { message } : {}),
    }),
  typing: (threadId: string, typing: boolean) => request<{ ok: true }>('POST', `/threads/${segment(threadId)}/typing`, { typing }),
  older: (threadId: string, before: { id: string } & Partial<MessageHint>) => {
    const query = new URLSearchParams({ before: before.id })
    if (before.senderId && before.sentAt) {
      query.set('senderId', before.senderId)
      query.set('sentAt', before.sentAt)
    }
    return request<ServerOlderMessages>('GET', `/threads/${segment(threadId)}/messages?${query}`)
  },

  linkWhatsApp: (request_: { method: 'code'; phone: string } | { method: 'qr' }) =>
    request<WhatsAppLinkResult>('POST', '/link/whatsapp', request_),
  unlinkWhatsApp: () => request<{ ok: true }>('DELETE', '/link/whatsapp'),
  telegramCode: (phone: string) => request<TelegramCodeResult>('POST', '/link/telegram/code', { phone }),
  telegramQr: () => request<{ qr: string }>('POST', '/link/telegram/qr'),
  telegramVerify: (code: string) => request<TelegramVerifyResult>('POST', '/link/telegram/verify', { code }),
  telegramPassword: (password: string) => request<TelegramVerifyResult>('POST', '/link/telegram/password', { password }),
  unlinkTelegram: () => request<{ ok: true }>('DELETE', '/link/telegram'),
}
