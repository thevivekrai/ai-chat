import { readJson, storage, writeJson } from '../../storage'
import type { Attachment, Contact, Message, Thread } from '../../types'
import { ME_ID } from '../../types'
import { Emitter, type Connector, type ConnectorEvent, type ConnectorSnapshot, type ConnectorStatus } from '../types'
import { callBotApi, isBadToken, TelegramError, type BotApiConfig, type TgChat, type TgMessage, type TgUpdate, type TgUser } from './botApi'

/**
 * A Telegram bot as an inbox: people message the bot (or a group it's in), and you reply as the bot.
 *
 * Bots can't fetch chat history, only new updates (which Telegram keeps for 24 hours), so every
 * message is stored on this device as it arrives. Telegram also rejects two readers polling the
 * same bot at once, so only one browser tab polls; the others follow along through a
 * BroadcastChannel.
 *
 * Ids: thread "tg:<chatId>", message "tg:<chatId>:<messageId>", contact "tg:u:<userId>" for people
 * and "tg:c:<chatId>" for channels.
 */

const STORE_KEY = 'tidings.telegram'
const POLL_SECONDS = 30
const MAX_MESSAGES_PER_CHAT = 400

interface StoredChat {
  id: number
  type: TgChat['type']
  title: string
  /** Contact keys ("u:<id>" or "c:<id>") seen writing in this chat. */
  members: string[]
}

interface StoredContact {
  name: string
  username?: string
}

interface TelegramStore {
  bot: { id: number; name: string; username: string } | null
  /** Next update to ask Telegram for; everything before it has been stored. */
  offset: number
  chats: Record<string, StoredChat>
  contacts: Record<string, StoredContact>
  messages: Record<string, Message[]>
  unread: Record<string, number>
}

type TabMessage =
  | { type: 'events'; events: ConnectorEvent[] }
  | { type: 'sent'; message: Message }
  | { type: 'read'; chatId: string }

const emptyStore = (): TelegramStore => ({ bot: null, offset: 0, chats: {}, contacts: {}, messages: {}, unread: {} })

const fullName = (u: { first_name?: string; last_name?: string; title?: string }) =>
  u.title ?? [u.first_name, u.last_name].filter(Boolean).join(' ') ?? 'Telegram user'

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString()

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Text and attachments for a message; null for service messages (joins, pins…), which are skipped. */
function content(msg: TgMessage): { body: string; attachments?: Attachment[] } | null {
  const caption = msg.caption ?? ''
  if (msg.text) return { body: msg.text }
  if (msg.photo) return { body: caption, attachments: [{ kind: 'image', name: 'Photo' }] }
  if (msg.document) {
    const size = msg.document.file_size ? `${Math.max(1, Math.round(msg.document.file_size / 1024))} KB` : undefined
    return { body: caption, attachments: [{ kind: 'file', name: msg.document.file_name ?? 'File', size }] }
  }
  if (msg.video) return { body: caption, attachments: [{ kind: 'file', name: msg.video.file_name ?? 'Video' }] }
  if (msg.audio) return { body: caption, attachments: [{ kind: 'file', name: msg.audio.title ?? msg.audio.file_name ?? 'Audio' }] }
  if (msg.voice) return { body: '🎤 Voice message' }
  if (msg.video_note) return { body: '🎬 Video message' }
  if (msg.animation) return { body: caption || 'GIF' }
  if (msg.sticker) return { body: `${msg.sticker.emoji ?? ''} Sticker`.trim() }
  if (msg.venue) return { body: `📍 ${msg.venue.title}` }
  if (msg.location) return { body: '📍 Location' }
  if (msg.contact) return { body: `👤 ${msg.contact.first_name} · ${msg.contact.phone_number}` }
  if (msg.poll) return { body: `📊 ${msg.poll.question}` }
  return null
}

export class TelegramConnector implements Connector {
  readonly id = 'telegram' as const
  private store: TelegramStore
  private readonly config: BotApiConfig
  private readonly events = new Emitter<ConnectorEvent>()
  private readonly statuses = new Emitter<ConnectorStatus>()
  private current: ConnectorStatus = { state: 'connecting' }
  private abort: AbortController | null = null
  private channel: BroadcastChannel | null = null
  /** Whether this tab polls Telegram and writes the store. */
  private leader = false

  constructor(config: BotApiConfig) {
    this.config = config
    this.store = readJson<TelegramStore>(STORE_KEY) ?? emptyStore()
  }

  /** Checks a token before it is saved. */
  static async verify(config: BotApiConfig): Promise<TgUser> {
    return callBotApi<TgUser>(config, 'getMe')
  }

  /* ── Connector ─────────────────────────────────────────────────────────── */

  snapshot(): ConnectorSnapshot {
    const chatIds = Object.keys(this.store.chats)
    return {
      contacts: Object.keys(this.store.contacts).map((key) => this.contact(key)),
      threads: chatIds.map((id) => this.thread(id)),
      messages: chatIds.flatMap((id) => this.store.messages[id] ?? []),
      selfName: this.store.bot?.name,
    }
  }

  start() {
    if (this.abort) return
    const abort = new AbortController()
    this.abort = abort
    this.openChannel()
    void this.run(abort.signal)
  }

  stop() {
    this.abort?.abort()
    this.abort = null
    this.channel?.close()
    this.channel = null
    this.leader = false
  }

  async sendMessage(threadId: string, body: string): Promise<Message> {
    const chatId = threadId.slice('tg:'.length)
    const sent = await callBotApi<TgMessage>(this.config, 'sendMessage', { chat_id: chatId, text: body })
    const message: Message = {
      id: `tg:${chatId}:${sent.message_id}`,
      threadId,
      senderId: ME_ID,
      body: sent.text ?? body,
      sentAt: iso(sent.date),
      // Bots can't see delivery or read receipts.
      status: 'sent',
    }
    this.addMessage(chatId, message)
    if (this.leader) {
      this.persist()
      this.broadcast({ type: 'events', events: [{ type: 'message.created', message }] })
    } else {
      this.broadcast({ type: 'sent', message })
    }
    return message
  }

  async markRead(threadId: string): Promise<Thread | null> {
    const chatId = threadId.slice('tg:'.length)
    if (!this.store.chats[chatId]) return null
    // Bots have no read receipts; the count only lives here.
    this.store.unread[chatId] = 0
    if (this.leader) this.persist()
    this.broadcast({ type: 'read', chatId })
    return this.thread(chatId)
  }

  subscribe(listener: (event: ConnectorEvent) => void) {
    return this.events.on(listener)
  }

  status() {
    return this.current
  }

  onStatus(listener: (status: ConnectorStatus) => void) {
    return this.statuses.on(listener)
  }

  async applyFix(id: string) {
    if (id !== 'remove-webhook') return
    await callBotApi(this.config, 'deleteWebhook', { drop_pending_updates: false })
    this.stop()
    this.start()
  }

  async forget() {
    this.stop()
    this.store = emptyStore()
    storage.remove(STORE_KEY)
  }

  /* ── Sync ──────────────────────────────────────────────────────────────── */

  private async run(signal: AbortSignal) {
    this.setStatus({ state: 'connecting', account: this.account() })
    let attempt = 0
    while (!signal.aborted) {
      try {
        const me = await callBotApi<TgUser>(this.config, 'getMe', {}, signal)
        if (this.store.bot?.id !== undefined && this.store.bot.id !== me.id) this.store = emptyStore()
        this.store.bot = { id: me.id, name: fullName(me), username: me.username ?? String(me.id) }
        break
      } catch (error) {
        if (signal.aborted) return
        if (isBadToken(error)) return this.fail('Telegram no longer accepts this bot token. Connect again with a new one.')
        this.setStatus({ state: 'error', account: this.account(), detail: errorText(error) })
        await sleep(Math.min(30_000, 2_000 * 2 ** attempt++), signal)
      }
    }
    if (signal.aborted || !this.store.bot) return

    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
    if (!locks) {
      await this.lead(signal)
      return
    }
    // Only one tab may poll a bot. Until this tab's turn comes, it follows along.
    const waiting = setTimeout(() => this.setStatus({ state: 'online', account: this.account(), detail: 'Syncing in another tab' }), 800)
    try {
      await locks.request(`tidings:telegram:${this.store.bot.id}`, { signal }, async () => {
        clearTimeout(waiting)
        await this.lead(signal)
      })
    } catch {
      // Aborted while waiting for the lock.
    } finally {
      clearTimeout(waiting)
    }
  }

  private async lead(signal: AbortSignal) {
    this.leader = true
    // Another tab may have stored newer messages while this one was following.
    const saved = readJson<TelegramStore>(STORE_KEY)
    if (saved && saved.bot?.id === this.store.bot?.id && saved.offset >= this.store.offset) {
      this.store = { ...saved, bot: this.store.bot }
      this.events.emit({ type: 'reloaded' })
    }
    this.persist()
    // The token works; a long poll can take a while to return when nobody is writing.
    this.setStatus({ state: 'online', account: this.account() })
    try {
      await this.poll(signal)
    } finally {
      this.leader = false
    }
  }

  private async poll(signal: AbortSignal) {
    let failures = 0
    while (!signal.aborted) {
      try {
        const updates = await callBotApi<TgUpdate[]>(
          this.config,
          'getUpdates',
          {
            offset: this.store.offset,
            timeout: POLL_SECONDS,
            allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post'],
          },
          signal,
        )
        failures = 0
        if (this.current.state !== 'online' || this.current.detail) this.setStatus({ state: 'online', account: this.account() })
        if (updates.length === 0) continue
        const events = updates.flatMap((u) => this.applyUpdate(u))
        this.store.offset = updates[updates.length - 1].update_id + 1
        this.persist()
        for (const event of events) this.events.emit(event)
        this.broadcast({ type: 'events', events })
      } catch (error) {
        if (signal.aborted) return
        if (isBadToken(error)) return this.fail('Telegram no longer accepts this bot token. Connect again with a new one.')
        if (error instanceof TelegramError && error.code === 409 && /webhook/i.test(error.message)) {
          return this.fail("This bot delivers its messages to a webhook, so they can't be read here.", {
            id: 'remove-webhook',
            label: 'Remove the webhook and read messages here',
          })
        }
        if (error instanceof TelegramError && error.code === 409) {
          this.setStatus({
            state: 'error',
            account: this.account(),
            detail: "Another app is reading this bot's messages. Stop it, or give Tidings its own bot.",
          })
          await sleep(15_000, signal)
          continue
        }
        if (error instanceof TelegramError && error.code === 429) {
          await sleep((error.retryAfter ?? 5) * 1000, signal)
          continue
        }
        failures++
        this.setStatus({ state: failures > 2 ? 'error' : 'connecting', account: this.account(), detail: errorText(error) })
        await sleep(Math.min(30_000, 1_000 * 2 ** failures), signal)
      }
    }
  }

  private applyUpdate(update: TgUpdate): ConnectorEvent[] {
    const fresh = update.message ?? update.channel_post
    if (fresh) return this.applyMessage(fresh)
    const edited = update.edited_message ?? update.edited_channel_post
    if (edited) return this.applyEdit(edited)
    return []
  }

  private applyMessage(msg: TgMessage): ConnectorEvent[] {
    const body = content(msg)
    if (!body) return []
    const events: ConnectorEvent[] = []
    const chatId = String(msg.chat.id)

    // Who wrote it: a person, or a channel / anonymous group admin posting as the chat.
    const senderKey = msg.from && !msg.sender_chat ? `u:${msg.from.id}` : `c:${(msg.sender_chat ?? msg.chat).id}`
    const sender = msg.from && !msg.sender_chat ? msg.from : (msg.sender_chat ?? msg.chat)
    const contact: StoredContact = { name: fullName(sender), username: sender.username }
    const known = this.store.contacts[senderKey]
    if (!known || known.name !== contact.name || known.username !== contact.username) {
      this.store.contacts[senderKey] = contact
      events.push({ type: 'contact.updated', contact: this.contact(senderKey) })
    }

    const chat = this.store.chats[chatId] ?? { id: msg.chat.id, type: msg.chat.type, title: '', members: [] }
    chat.title = msg.chat.type === 'private' ? fullName(msg.chat) : (msg.chat.title ?? chat.title)
    if (!chat.members.includes(senderKey)) chat.members.push(senderKey)
    this.store.chats[chatId] = chat

    const message: Message = {
      id: `tg:${chatId}:${msg.message_id}`,
      threadId: `tg:${chatId}`,
      senderId: `tg:${senderKey}`,
      body: body.body,
      sentAt: iso(msg.date),
      ...(body.attachments ? { attachments: body.attachments } : {}),
    }
    if (this.addMessage(chatId, message)) {
      this.store.unread[chatId] = (this.store.unread[chatId] ?? 0) + 1
      events.push({ type: 'thread.updated', thread: this.thread(chatId) }, { type: 'message.created', message })
    }
    return events
  }

  private applyEdit(msg: TgMessage): ConnectorEvent[] {
    const chatId = String(msg.chat.id)
    const list = this.store.messages[chatId]
    const id = `tg:${chatId}:${msg.message_id}`
    const index = list?.findIndex((m) => m.id === id) ?? -1
    const body = content(msg)
    if (!list || index === -1 || !body) return []
    const message: Message = { ...list[index], body: body.body, attachments: body.attachments }
    list[index] = message
    return [{ type: 'message.updated', message }]
  }

  /** Stores a message, keeping each chat to its most recent messages. False if it was already there. */
  private addMessage(chatId: string, message: Message): boolean {
    const list = (this.store.messages[chatId] ??= [])
    if (list.some((m) => m.id === message.id)) return false
    list.push(message)
    if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT)
    return true
  }

  /* ── Mapping ───────────────────────────────────────────────────────────── */

  private thread(chatId: string): Thread {
    const chat = this.store.chats[chatId]
    const direct = chat.type === 'private'
    return {
      id: `tg:${chatId}`,
      network: 'telegram',
      kind: direct ? 'direct' : 'group',
      title: chat.title || 'Telegram chat',
      participantIds: (direct ? [`u:${chatId}`] : chat.members).map((key) => `tg:${key}`),
      unreadCount: this.store.unread[chatId] ?? 0,
      doneAt: null,
      snoozedUntil: null,
    }
  }

  private contact(key: string): Contact {
    const c = this.store.contacts[key] ?? { name: 'Telegram user' }
    return {
      id: `tg:${key}`,
      name: c.name || 'Telegram user',
      network: 'telegram',
      handle: c.username ? `@${c.username}` : key.startsWith('c:') ? 'Channel' : `ID ${key.slice(2)}`,
    }
  }

  /* ── Tabs, status, storage ─────────────────────────────────────────────── */

  private openChannel() {
    if (typeof BroadcastChannel === 'undefined') return
    this.channel = new BroadcastChannel(STORE_KEY)
    this.channel.onmessage = ({ data }: MessageEvent<TabMessage>) => {
      if (data.type === 'events') {
        // The leader has stored these already; pick up its copy and pass the changes on.
        if (!this.leader) this.store = readJson<TelegramStore>(STORE_KEY) ?? this.store
        for (const event of data.events) this.events.emit(event)
      } else if (data.type === 'sent' && this.leader) {
        const chatId = data.message.threadId.slice('tg:'.length)
        if (this.addMessage(chatId, data.message)) this.persist()
        this.broadcast({ type: 'events', events: [{ type: 'message.created', message: data.message }] })
      } else if (data.type === 'read') {
        this.store.unread[data.chatId] = 0
        if (this.leader) this.persist()
        if (this.store.chats[data.chatId]) this.events.emit({ type: 'thread.updated', thread: this.thread(data.chatId) })
      }
    }
  }

  private broadcast(message: TabMessage) {
    this.channel?.postMessage(message)
  }

  private persist() {
    writeJson(STORE_KEY, this.store)
  }

  private account() {
    return this.store.bot ? `@${this.store.bot.username}` : undefined
  }

  private setStatus(status: ConnectorStatus) {
    this.current = status
    this.statuses.emit(status)
  }

  private fail(detail: string, fix?: ConnectorStatus['fix']) {
    this.setStatus({ state: 'error', account: this.account(), detail, fix })
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Telegram is unreachable right now.'
}
