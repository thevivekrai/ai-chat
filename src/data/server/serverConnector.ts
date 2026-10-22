import { Emitter, type Connector, type ConnectorEvent, type ConnectorSnapshot, type ConnectorStatus } from '../connectors/types'
import type { Contact, Message, Thread } from '../types'
import { ME_ID } from '../types'
import { isSignedOut, serverApi } from './serverApi'
import type { LinkedNetwork, PublicAccount, ServerEvent, ServerInbox } from './types'

type MessageChange = Extract<ConnectorEvent, { type: 'message.created' | 'message.updated' }>

/**
 * Chats from the WhatsApp and Telegram accounts linked on the Tidings server. The server keeps
 * them (encrypted at rest) and pushes changes as server-sent events; this keeps a copy for the
 * session, re-reading the whole inbox whenever the stream (re)connects so nothing is missed.
 *
 * Ids start with "wa:" or "tga:".
 */
export class ServerConnector implements Connector {
  readonly id = 'server'
  private threads = new Map<string, Thread>()
  private messages = new Map<string, Message>()
  private contacts = new Map<string, Contact>()
  private linked = new Map<LinkedNetwork, PublicAccount>()
  private readonly events = new Emitter<ConnectorEvent>()
  private readonly statusEvents = new Emitter<ConnectorStatus>()
  private readonly accountEvents = new Emitter<PublicAccount[]>()
  private readonly qrEvents = new Emitter<string>()
  private current: ConnectorStatus = { state: 'connecting' }
  private source: EventSource | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retries = 0
  private running = false
  /**
   * Sends in flight per chat. The server's echo of a message I'm sending can arrive before the
   * send itself returns; it's held until then, so the message doesn't briefly show twice.
   */
  private readonly inFlight = new Map<string, number>()
  private readonly held = new Map<string, MessageChange[]>()
  private readonly onSignedOut: () => void

  constructor({ onSignedOut }: { onSignedOut(): void }) {
    this.onSignedOut = onSignedOut
  }

  snapshot(): ConnectorSnapshot {
    return {
      threads: [...this.threads.values()],
      contacts: [...this.contacts.values()],
      messages: [...this.messages.values()],
    }
  }

  /** WhatsApp and Telegram as linked on the server. */
  accounts(): PublicAccount[] {
    return [...this.linked.values()]
  }

  onAccounts(listener: (accounts: PublicAccount[]) => void) {
    return this.accountEvents.on(listener)
  }

  /** Fresh QR codes while linking WhatsApp by QR. */
  onQr(listener: (qr: string) => void) {
    return this.qrEvents.on(listener)
  }

  start() {
    if (this.running) return
    this.running = true
    this.open()
  }

  stop() {
    this.running = false
    this.source?.close()
    this.source = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  status() {
    return this.current
  }

  onStatus(listener: (status: ConnectorStatus) => void) {
    return this.statusEvents.on(listener)
  }

  subscribe(listener: (event: ConnectorEvent) => void) {
    return this.events.on(listener)
  }

  async sendMessage(threadId: string, body: string): Promise<Message> {
    this.inFlight.set(threadId, (this.inFlight.get(threadId) ?? 0) + 1)
    try {
      const { message } = await serverApi.send(threadId, body)
      this.messages.set(message.id, message)
      return message
    } catch (error) {
      if (isSignedOut(error)) this.signedOut()
      throw error
    } finally {
      const left = (this.inFlight.get(threadId) ?? 1) - 1
      if (left > 0) this.inFlight.set(threadId, left)
      else {
        this.inFlight.delete(threadId)
        // After the sender has swapped in the sent message.
        setTimeout(() => this.release(threadId), 0)
      }
    }
  }

  async markRead(threadId: string): Promise<Thread | null> {
    const thread = this.threads.get(threadId)
    if (thread) this.threads.set(threadId, { ...thread, unreadCount: 0 })
    await serverApi.markRead(threadId)
    return this.threads.get(threadId) ?? null
  }

  /** Re-reads which accounts are linked, after linking or unlinking from this tab. */
  async refreshAccounts() {
    this.load(await serverApi.inbox())
  }

  async forget() {
    this.stop()
    this.threads.clear()
    this.messages.clear()
    this.contacts.clear()
    this.linked.clear()
  }

  /* ── The event stream ─────────────────────────────────────────────────────── */

  private open() {
    if (!this.running) return
    const source = new EventSource('/api/events')
    this.source = source
    // Each (re)connection starts from a fresh copy of the inbox, so nothing missed in between is lost.
    source.onopen = () => {
      this.retries = 0
      void serverApi
        .inbox()
        .then((inbox) => this.load(inbox))
        .catch((error) => this.failed(error))
    }
    source.onmessage = (e: MessageEvent<string>) => {
      let event: ServerEvent
      try {
        event = JSON.parse(e.data) as ServerEvent
      } catch {
        return
      }
      this.onEvent(event)
    }
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED) {
        // The browser reconnects by itself.
        this.setStatus({ state: 'connecting', detail: 'Reconnecting…' })
        return
      }
      // A failed response (signed out, the server restarting): the browser has given up.
      source.close()
      if (this.source === source) this.source = null
      void serverApi
        .inbox()
        .then((inbox) => {
          this.load(inbox)
          this.reopenLater()
        })
        .catch((error) => this.failed(error))
    }
  }

  private failed(error: unknown) {
    if (isSignedOut(error)) return this.signedOut()
    this.setStatus({ state: 'error', detail: "Can't reach the server. Retrying…" })
    this.source?.close()
    this.source = null
    this.reopenLater()
  }

  private reopenLater() {
    if (!this.running || this.retryTimer) return
    const delay = Math.min(60_000, 2000 * 2 ** this.retries++)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.open()
    }, delay)
  }

  private signedOut() {
    this.stop()
    this.onSignedOut()
  }

  private load(inbox: ServerInbox) {
    this.threads = new Map(inbox.threads.map((t) => [t.id, t]))
    this.messages = new Map(inbox.messages.map((m) => [m.id, m]))
    this.contacts = new Map(inbox.contacts.map((c) => [c.id, c]))
    this.linked = new Map(inbox.accounts.map((a) => [a.network, a]))
    this.accountEvents.emit(this.accounts())
    this.setStatus({ state: 'online' })
    this.events.emit({ type: 'reloaded' })
  }

  private onEvent(event: ServerEvent) {
    switch (event.type) {
      case 'message.created':
      case 'message.updated': {
        const { threadId } = event.message
        if (event.message.senderId === ME_ID && this.inFlight.has(threadId)) {
          this.held.set(threadId, [...(this.held.get(threadId) ?? []), event])
          return
        }
        this.messages.set(event.message.id, event.message)
        this.events.emit(event)
        return
      }
      case 'thread.updated':
        this.threads.set(event.thread.id, event.thread)
        this.events.emit(event)
        return
      case 'contact.updated':
        this.contacts.set(event.contact.id, event.contact)
        this.events.emit(event)
        return
      case 'account.updated':
        if (event.account.status === 'unlinked') this.linked.delete(event.account.network)
        else this.linked.set(event.account.network, event.account)
        this.accountEvents.emit(this.accounts())
        return
      case 'account.qr':
        this.qrEvents.emit(event.qr)
        return
      case 'reloaded':
        void serverApi
          .inbox()
          .then((inbox) => this.load(inbox))
          .catch((error) => this.failed(error))
    }
  }

  private release(threadId: string) {
    if (this.inFlight.has(threadId)) return
    const held = this.held.get(threadId) ?? []
    this.held.delete(threadId)
    for (const event of held) {
      this.messages.set(event.message.id, event.message)
      this.events.emit(event)
    }
  }

  private setStatus(status: ConnectorStatus) {
    if (status.state === this.current.state && status.detail === this.current.detail) return
    this.current = status
    this.statusEvents.emit(status)
  }
}
