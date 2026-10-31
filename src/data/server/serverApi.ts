import type {
  AuthResult,
  CalendarStatus,
  InstagramLinkResult,
  MessageHint,
  PublicAccount,
  PublicUser,
  ServerFeatures,
  ServerInbox,
  ServerOlderMessages,
  TelegramCodeResult,
  TelegramVerifyResult,
  WhatsAppLinkResult,
} from './types'
import type { Contact, Message, MessageAction, Task, Thread, ThreadStatePatch } from '../types'

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

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
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

/** A security question chosen, and its answer as typed. */
export interface SecurityAnswerInput {
  question: string
  answer: string
}

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
  register: (input: { name: string; email: string; password: string; acceptedTerms: boolean; securityQuestions: SecurityAnswerInput[] }) =>
    request<AuthResult>('POST', '/auth/register', input),
  login: (input: { email: string; password: string }) => request<AuthResult>('POST', '/auth/login', input),
  google: (credential: string) => request<AuthResult>('POST', '/auth/google', { credential }),
  logout: () => request<{ ok: true }>('POST', '/auth/logout'),
  /** Deletes the account for good: with the password, or the email typed out for a Google-only one. */
  deleteAccount: (proof: { current?: string; confirm?: string }) => request<{ ok: true }>('DELETE', '/me', proof),
  /** A forgotten password: the email and recovery key set a new one (and a new key comes back). */
  recover: (input: { email: string; recoveryKey: string; password: string }) => request<AuthResult>('POST', '/auth/recover', input),
  /** The security questions to answer for an email, when the recovery key is lost too. */
  recoveryQuestions: async (email: string) => (await request<{ questions: string[] }>('POST', '/auth/recover/questions', { email })).questions,
  recoverWithAnswers: (input: { email: string; answers: string[]; password: string }) => request<AuthResult>('POST', '/auth/recover/answers', input),
  setSecurityQuestions: (input: { current: string; securityQuestions: SecurityAnswerInput[] }) =>
    request<{ user: PublicUser }>('PUT', '/me/security-questions', input),
  newRecoveryKey: (current: string) => request<{ user: PublicUser; recoveryKey: string }>('POST', '/me/recovery-key', { current }),

  rename: (name: string) => request<{ user: PublicUser }>('PATCH', '/me', { name }),
  setIncognito: (incognito: boolean) => request<{ user: PublicUser }>('PATCH', '/me', { incognito }),
  setPassword: (input: { password: string; current?: string }) => request<AuthResult>('POST', '/me/password', input),
  uploadAvatar: (image: string) => request<{ user: PublicUser }>('POST', '/me/avatar', { image }),

  /* ── Linked chats ────────────────────────────────────────────────────────── */

  inbox: () => request<ServerInbox>('GET', '/inbox'),
  /** People to start a chat with, on the linked accounts: by phone number (WhatsApp), or name and @username (Telegram). */
  findPeople: async (query: string) =>
    (await request<{ people: { contact: Contact; hasChat: boolean }[] }>('GET', `/people?q=${encodeURIComponent(query)}`)).people,
  startChat: (contactId: string) => request<{ thread: Thread }>('POST', '/people/chat', { id: contactId }),
  /** Only which accounts are linked: a small answer, while the whole inbox can take a while. */
  accounts: async () => (await request<{ accounts: PublicAccount[] }>('GET', '/accounts')).accounts,
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
  /** `receipt` false: no read receipt (Incognito mode); true: one anyway. Left out, the account's setting decides. */
  markRead: (threadId: string, receipt?: boolean) =>
    request<{ ok: true; receipt: boolean }>('POST', `/threads/${segment(threadId)}/read`, receipt === undefined ? undefined : { receipt }),
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
  async sendFile(
    threadId: string,
    file: File,
    caption: string,
    replyToId?: string,
    replyTo?: MessageHint,
    sticker = false,
  ): Promise<{ message: Message }> {
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
          ...(sticker ? { 'X-Sticker': '1' } : {}),
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
  archive: (threadId: string, archived: boolean) =>
    request<{ thread: Thread }>('POST', `/threads/${segment(threadId)}/archive`, { archived }),
  /** Done and snoozed, kept with the account. */
  threadState: (threadId: string, patch: ThreadStatePatch) =>
    request<{ thread: Thread }>('POST', `/threads/${segment(threadId)}/state`, patch),
  putTask: (task: Task) => request<{ task: Task }>('PUT', `/tasks/${segment(task.id)}`, task),
  deleteTask: (taskId: string) => request<{ ok: true }>('DELETE', `/tasks/${segment(taskId)}`),
  pushKey: () => request<{ key: string }>('GET', '/push/key'),
  pushSubscribe: (subscription: PushSubscriptionJSON, preview: boolean) => request<{ ok: true }>('POST', '/push/subscribe', { subscription, preview }),
  pushUnsubscribe: (endpoint: string) => request<{ ok: true }>('POST', '/push/unsubscribe', { endpoint }),
  pushTest: () => request<{ sent: number }>('POST', '/push/test'),
  calendar: () => request<CalendarStatus>('GET', '/calendar'),
  disconnectCalendar: () => request<CalendarStatus>('DELETE', '/calendar'),
  syncTask: (task: Task, note?: string) =>
    request<{ ok: true; eventId: string }>('PUT', `/calendar/tasks/${segment(task.id)}`, { ...task, ...(note ? { note } : {}) }),
  unsyncTask: (taskId: string) => request<{ ok: true }>('DELETE', `/calendar/tasks/${segment(taskId)}`),
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
  linkInstagram: (username: string, password: string) =>
    request<InstagramLinkResult>('POST', '/link/instagram', { username, password }),
  linkInstagramSession: (cookies: string) => request<InstagramLinkResult>('POST', '/link/instagram/session', { cookies }),
  instagramVerify: (code: string) => request<InstagramLinkResult>('POST', '/link/instagram/verify', { code }),
  unlinkInstagram: () => request<{ ok: true }>('DELETE', '/link/instagram'),
  linkX: (cookies: string) => request<{ username: string; fullName: string }>('POST', '/link/x', { cookies }),
  unlinkX: () => request<{ ok: true }>('DELETE', '/link/x'),
  linkGuffshuff: (username: string, password: string) =>
    request<{ username: string; fullName: string }>('POST', '/link/guffshuff', { username, password }),
  unlinkGuffshuff: () => request<{ ok: true }>('DELETE', '/link/guffshuff'),
}
