import { vi } from 'vitest'
import type { TgChat, TgMessage, TgUpdate, TgUser } from '@/data/connectors/telegram/botApi'

/**
 * An in-memory Telegram Bot API, installed as `fetch`. Long polls wait until a test pushes an
 * update (or the request is aborted), like the real getUpdates.
 */
export function installFakeTelegram({ token = '123:TEST' } = {}) {
  const bot: TgUser = { id: 999, is_bot: true, first_name: 'Mitti Studio', username: 'mitti_bot' }
  const updates: TgUpdate[] = []
  const sent: { chat_id: string; text: string }[] = []
  const calls: string[] = []
  let nextUpdateId = 1
  let nextMessageId = 100
  let waiting: (() => void)[] = []
  const state = { webhook: false, validToken: token }

  const reply = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 })
  const fail = (code: number, description: string) =>
    new Response(JSON.stringify({ ok: false, error_code: code, description }), { status: code })

  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const match = /\/bot([^/]+)\/(\w+)$/.exec(String(url))
    if (!match) return new Response('not found', { status: 404 })
    const [, usedToken, method] = match
    calls.push(method)
    const params = new URLSearchParams(String(init?.body ?? ''))
    if (usedToken !== state.validToken) return fail(401, 'Unauthorized')

    switch (method) {
      case 'getMe':
        return reply(bot)
      case 'deleteWebhook':
        state.webhook = false
        return reply(true)
      case 'getUpdates': {
        if (state.webhook) {
          return fail(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first")
        }
        const offset = Number(params.get('offset') ?? 0)
        const ready = () => updates.filter((u) => u.update_id >= offset)
        if (ready().length === 0) {
          await new Promise<void>((resolve, reject) => {
            waiting.push(resolve)
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          })
        }
        return reply(ready())
      }
      case 'sendMessage': {
        const chatId = params.get('chat_id') ?? ''
        const text = params.get('text') ?? ''
        sent.push({ chat_id: chatId, text })
        const message: TgMessage = {
          message_id: nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(chatId), type: Number(chatId) < 0 ? 'group' : 'private' },
          from: bot,
          text,
        }
        return reply(message)
      }
      default:
        return fail(404, 'Not Found: method not found')
    }
  })
  vi.stubGlobal('fetch', fetchMock)

  function push(update: Omit<TgUpdate, 'update_id'>) {
    updates.push({ ...update, update_id: nextUpdateId++ })
    const wake = waiting
    waiting = []
    wake.forEach((resolve) => resolve())
  }

  const person = (id: number, first_name: string, extra: Partial<TgUser> = {}): TgUser => ({ id, is_bot: false, first_name, ...extra })
  const privateChat = (user: TgUser): TgChat => ({ id: user.id, type: 'private', first_name: user.first_name, last_name: user.last_name, username: user.username })

  return {
    token,
    bot,
    sent,
    calls,
    state,
    push,
    person,
    privateChat,
    /** A new incoming message; returns its message id. */
    message(chat: TgChat, from: TgUser, fields: Partial<TgMessage>) {
      const message: TgMessage = { message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat, from, ...fields }
      push({ message })
      return message
    },
  }
}

/** Resolves once `check` passes, polling briefly; for waiting on background sync. */
export async function eventually(check: () => void, timeoutMs = 2000) {
  const started = Date.now()
  for (;;) {
    try {
      check()
      return
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}
