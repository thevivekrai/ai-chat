/**
 * The handful of Telegram Bot API calls the connector needs. Requests are form-encoded POSTs, which
 * browsers send without a CORS preflight.
 *
 * https://core.telegram.org/bots/api
 */
export const DEFAULT_TELEGRAM_API = 'https://api.telegram.org'

export interface BotApiConfig {
  token: string
  /** Telegram's Bot API, or a self-hosted telegram-bot-api server. */
  apiBase: string
}

export interface TgUser {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
}

export interface TgChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

export interface TgMessage {
  message_id: number
  date: number
  chat: TgChat
  from?: TgUser
  sender_chat?: TgChat
  text?: string
  caption?: string
  photo?: unknown[]
  video?: { file_name?: string }
  animation?: unknown
  video_note?: unknown
  voice?: unknown
  audio?: { title?: string; file_name?: string }
  document?: { file_name?: string; file_size?: number }
  sticker?: { emoji?: string }
  location?: unknown
  venue?: { title: string }
  contact?: { first_name: string; phone_number: string }
  poll?: { question: string }
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  edited_message?: TgMessage
  channel_post?: TgMessage
  edited_channel_post?: TgMessage
}

export class TelegramError extends Error {
  /** Telegram's error code (401 bad token, 409 conflict, 429 flood wait…); 0 when unreachable. */
  readonly code: number
  readonly retryAfter?: number

  constructor(code: number, message: string, retryAfter?: number) {
    super(message)
    this.name = 'TelegramError'
    this.code = code
    this.retryAfter = retryAfter
  }
}

interface TgResponse<T> {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

export async function callBotApi<T>(
  { token, apiBase }: BotApiConfig,
  method: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) body.set(key, typeof value === 'string' ? value : JSON.stringify(value))
  }

  let response: Response
  try {
    response = await fetch(`${apiBase.replace(/\/+$/, '')}/bot${token}/${method}`, { method: 'POST', body, signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new TelegramError(0, "Couldn't reach Telegram. Check your connection.")
  }

  let data: TgResponse<T>
  try {
    data = (await response.json()) as TgResponse<T>
  } catch {
    throw new TelegramError(response.status, `Telegram answered with HTTP ${response.status}.`)
  }
  if (!data.ok) {
    throw new TelegramError(
      data.error_code ?? response.status,
      data.description ?? 'Telegram could not process the request.',
      data.parameters?.retry_after,
    )
  }
  return data.result as T
}

/** Whether the error means the token itself is bad. Telegram answers 404 for malformed tokens. */
export function isBadToken(error: unknown): boolean {
  return error instanceof TelegramError && (error.code === 401 || error.code === 404)
}
