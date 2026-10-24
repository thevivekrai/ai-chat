import {
  Emitter,
  type Connector,
  type ConnectorEvent,
  type ConnectorSnapshot,
  type ConnectorStatus,
  type OlderMessages,
  type SendOptions,
} from '../connectors/types'
import { withMyReaction } from '../reactions'
import type { ChatCapabilities, Contact, Message, MessageAction, ReadOptions, Thread } from '../types'
import { ME_ID, withAction } from '../types'
import { openDeviceStore, wipeDeviceStore, type DeviceStore } from './deviceStore'
import { isSignedOut, serverApi } from './serverApi'
import {
  MESSAGES_KEPT_PER_CHAT,
  type LinkedNetwork,
  type MessageHint,
  type PublicAccount,
  type PublicUser,
  type ServerEvent,
  type ServerInbox,
} from './types'

type MessageChange = Extract<ConnectorEvent, { type: 'message.created' | 'message.updated' }>

/** WhatsApp and Telegram, linked on the server, both do all of it. */
const LINKED_CAPABILITIES: ChatCapabilities = {
  reply: true,
  react: true,
  typing: true,
  history: true,
  files: true,
  edit: true,
  delete: true,
  pin: true,
  star: true,
}

/** How much of a quoted message goes along with a photo or file (in a header, which has a size limit). */
const QUOTE_IN_HEADER = 300

/** How many messages of each chat are read from the device on start; older ones as the user scrolls back. */
const IN_MEMORY_PER_CHAT = 50
/** One "Load earlier" from the device. */
const OLDER_PAGE = 30
/** How far a gap left while this device was away is filled in by itself, per chat. */
const GAP_PAGES = 3
const GAP_CHATS = 20

const PREFIX: Record<LinkedNetwork, string> = { whatsapp: 'wa:', telegram: 'tga:' }

const hintOf = (m: Message, withBody = false): MessageHint => ({
  id: m.id,
  senderId: m.senderId,
  sentAt: m.sentAt,
  ...(withBody ? { body: m.body || m.attachments?.[0]?.name || '' } : {}),
})

/**
 * All the server needs to keep its own copy of a message it no longer has (to pin or star it).
 * Links to anything but the server's own files only work on this device, so they're left out.
 */
const copyOf = (m: Message): MessageHint => ({
  id: m.id,
  senderId: m.senderId,
  sentAt: m.sentAt,
  body: m.body,
  ...(m.attachments?.length ? { attachments: m.attachments.map(({ url, ...a }) => (url?.startsWith('/api/files/') ? { ...a, url } : a)) } : {}),
  ...(m.replyTo ? { replyTo: m.replyTo } : {}),
  ...(m.reactions?.length ? { reactions: m.reactions } : {}),
  ...(m.editedAt ? { editedAt: m.editedAt } : {}),
  ...(m.status ? { status: m.status } : {}),
})

/**
 * Chats from the WhatsApp and Telegram accounts linked on the Sytext server.
 *
 * The server keeps only the latest messages of each chat and pushes changes as server-sent
 * events. This device keeps its own copy of everything it has seen (see deviceStore.ts): it's
 * shown straight away on start, even offline, merged with the server's copy whenever the stream
 * (re)connects, and scrolled back through before the network is asked for older messages.
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
  private readonly qrEvents = new Emitter<{ network: LinkedNetwork; qr: string }>()
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
  /** Each chat's latest photo or file upload, which the next one waits for. */
  private readonly uploads = new Map<string, Promise<unknown>>()
  private readonly onSignedOut: () => void
  private readonly onUserUpdated: (user: PublicUser) => void
  private readonly owner: string
  private readonly openStore: (owner: string) => Promise<DeviceStore>
  /** This device's copy, once opened and read. */
  private restoring: Promise<DeviceStore> | null = null
  private forgotten = false

  constructor({
    owner,
    onSignedOut,
    onUserUpdated = () => {},
    openStore = openDeviceStore,
  }: {
    /** The signed-in user's id: a copy left on this device by someone else is never shown. */
    owner: string
    onSignedOut(): void
    /** The account changed, here or on another device (its name, Incognito mode…). */
    onUserUpdated?(user: PublicUser): void
    openStore?: (owner: string) => Promise<DeviceStore>
  }) {
    this.owner = owner
    this.onSignedOut = onSignedOut
    this.onUserUpdated = onUserUpdated
    this.openStore = openStore
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

  /** Fresh QR codes while linking by QR. */
  onQr(listener: (network: LinkedNetwork, qr: string) => void) {
    return this.qrEvents.on(({ network, qr }) => listener(network, qr))
  }

  capabilities(): ChatCapabilities {
    return LINKED_CAPABILITIES
  }

  start() {
    if (this.running) return
    this.running = true
    void this.device()
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

  async sendMessage(threadId: string, body: string, options?: SendOptions): Promise<Message> {
    this.inFlight.set(threadId, (this.inFlight.get(threadId) ?? 0) + 1)
    try {
      const quoted = options?.replyToId ? this.messages.get(options.replyToId) : undefined
      const hint = quoted && hintOf(quoted, true)
      const file = options?.file
      const { message } = file
        ? // With a file, the quote travels in a header: its start is plenty to show it.
          await this.oneAtATime(threadId, () =>
            serverApi.sendFile(threadId, file, body, options.replyToId, hint && { ...hint, body: hint.body?.slice(0, QUOTE_IN_HEADER) }),
          )
        : await serverApi.send(threadId, body, options?.replyToId, hint)
      this.keepMessages([message])
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

  /**
   * Photos and files go to a chat one at a time, in the order they were sent: so they arrive in that
   * order, and the server holds one upload at a time.
   */
  private oneAtATime<T>(threadId: string, send: () => Promise<T>): Promise<T> {
    const turn = (this.uploads.get(threadId) ?? Promise.resolve()).catch(() => undefined).then(send)
    this.uploads.set(threadId, turn)
    turn
      .finally(() => {
        if (this.uploads.get(threadId) === turn) this.uploads.delete(threadId)
      })
      .catch(() => undefined)
    return turn
  }

  async actOnMessage(threadId: string, messageId: string, action: MessageAction): Promise<Message | null> {
    const mine = this.messages.get(messageId)
    // A pin or star keeps the message on the server however old, so it gets the whole message.
    const keeps = action.type === 'pin' || action.type === 'star'
    const { message, removed } = await this.signedIn(
      serverApi.messageAction(threadId, messageId, action, mine && (keeps ? copyOf(mine) : hintOf(mine))),
    )
    if (removed) {
      this.forgetMessage(messageId)
      return null
    }
    // The server no longer keeps it: only this device's copy changes. A copy it kept again lacks the
    // quote this device knows of (a quote never changes, so it stays).
    const updated = message
      ? { ...(mine?.replyTo && !message.deleted ? { replyTo: mine.replyTo } : {}), ...message }
      : mine && withAction(mine, action)
    if (!updated) throw new Error('That message is gone.')
    this.keepMessages([updated])
    return updated
  }

  async archiveThread(threadId: string, archived: boolean): Promise<Thread> {
    const { thread } = await this.signedIn(serverApi.archive(threadId, archived))
    this.keepThreads([thread])
    return thread
  }

  /** Deleted for me: gone from this device's copy too. */
  private forgetMessage(messageId: string) {
    this.messages.delete(messageId)
    void this.device().then((store) => store.remove({ messageIds: [messageId] }))
  }

  async react(threadId: string, messageId: string, emoji: string | null): Promise<Message> {
    const mine = this.messages.get(messageId)
    const { message } = await this.signedIn(serverApi.react(threadId, messageId, emoji, mine && hintOf(mine)))
    // The server no longer keeps it: only this device's copy changes.
    const updated = message ?? (mine && { ...mine, reactions: withMyReaction(mine.reactions, emoji) })
    if (!updated) throw new Error('That message is gone.')
    this.keepMessages([updated])
    return updated
  }

  async setTyping(threadId: string, typing: boolean) {
    await serverApi.typing(threadId, typing)
  }

  /** From this device's copy first; beyond that, from the server and through it the network. */
  async loadOlder(threadId: string, beforeId: string): Promise<OlderMessages> {
    const before = this.messages.get(beforeId)
    if (before) {
      const kept = await (await this.device()).older(threadId, before.sentAt, OLDER_PAGE)
      if (kept.length) {
        for (const m of kept) this.messages.set(m.id, m)
        return { messages: kept.reverse(), hasMore: true }
      }
    }
    const older = await this.signedIn(serverApi.older(threadId, before ? hintOf(before) : { id: beforeId }))
    this.keepMessages(older.messages)
    return older
  }

  async markRead(threadId: string, options?: ReadOptions): Promise<Thread | null> {
    const thread = this.threads.get(threadId)
    if (thread) this.keepThreads([{ ...thread, unreadCount: 0 }])
    await serverApi.markRead(threadId, options?.receipt)
    return this.threads.get(threadId) ?? null
  }

  /** Re-reads which accounts are linked, after linking or unlinking from this tab. */
  async refreshAccounts() {
    await this.load(await serverApi.inbox())
  }

  /** Signing out: everything about these chats leaves this device. */
  async forget() {
    this.stop()
    this.forgotten = true
    this.threads.clear()
    this.messages.clear()
    this.contacts.clear()
    this.linked.clear()
    if (this.restoring) await (await this.restoring.catch(() => null))?.clear()
    else await wipeDeviceStore()
  }

  /* ── This device's copy ───────────────────────────────────────────────────── */

  /** Opens the copy and shows what's in it, once; until the server answers, it's all there is. */
  private device(): Promise<DeviceStore> {
    this.restoring ??= (async () => {
      const store = await this.openStore(this.owner)
      const copy = await store.load(IN_MEMORY_PER_CHAT).catch((error: unknown) => {
        console.warn("[device] Couldn't read this device's copy:", error)
        return { threads: [], contacts: [], messages: [] }
      })
      if (this.forgotten) {
        await store.clear()
        return store
      }
      // Anything the server already sent is newer.
      for (const t of copy.threads) if (!this.threads.has(t.id)) this.threads.set(t.id, t)
      for (const c of copy.contacts) if (!this.contacts.has(c.id)) this.contacts.set(c.id, c)
      for (const m of copy.messages) if (!this.messages.has(m.id)) this.messages.set(m.id, m)
      if (copy.threads.length) this.events.emit({ type: 'reloaded' })
      return store
    })()
    return this.restoring
  }

  private keepMessages(messages: Message[]) {
    for (const m of messages) this.messages.set(m.id, m)
    if (messages.length) void this.device().then((store) => store.put({ messages }))
  }

  private keepThreads(threads: Thread[]) {
    for (const t of threads) this.threads.set(t.id, t)
    void this.device().then((store) => store.put({ threads }))
  }

  private keepContacts(contacts: Contact[]) {
    for (const c of contacts) this.contacts.set(c.id, c)
    void this.device().then((store) => store.put({ contacts }))
  }

  /* ── The event stream ─────────────────────────────────────────────────────── */

  private open() {
    if (!this.running) return
    const source = new EventSource('/api/events')
    this.source = source
    // Each (re)connection starts from a fresh copy of the inbox, so nothing missed in between is lost.
    source.onopen = () => {
      this.retries = 0
      void this.reload()
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
      void this.reload().then((ok) => {
        if (ok) this.reopenLater()
      })
    }
  }

  /** Fetches the server's copy and merges it in; false if that failed. */
  private async reload(): Promise<boolean> {
    try {
      await this.load(await serverApi.inbox())
      return true
    } catch (error) {
      this.failed(error)
      return false
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

  /** Passes a request's result on, noticing when the session has ended. */
  private async signedIn<T>(request: Promise<T>): Promise<T> {
    try {
      return await request
    } catch (error) {
      if (isSignedOut(error)) this.signedOut()
      throw error
    }
  }

  /**
   * Merges the server's copy into this device's. The server's is newer for whatever it has; what
   * only this device has (older messages) stays, except for networks no longer linked.
   */
  private async load(inbox: ServerInbox) {
    const store = await this.device()
    if (this.forgotten) return

    // Chats of a network that was unlinked (here or on another device) go.
    const linkedPrefixes = inbox.accounts.map((a) => PREFIX[a.network])
    const gone = (id: string) => !linkedPrefixes.some((prefix) => id.startsWith(prefix))
    const goneThreads = [...this.threads.keys()].filter(gone)
    const goneContacts = [...this.contacts.keys()].filter(gone)
    for (const id of goneThreads) this.threads.delete(id)
    for (const id of goneContacts) this.contacts.delete(id)
    for (const [id, m] of this.messages) if (gone(m.threadId)) this.messages.delete(id)
    if (goneThreads.length || goneContacts.length) store.remove({ threadIds: goneThreads, contactIds: goneContacts })

    // Deleted for me while this device was away (on the phone, or another device).
    const deleted = inbox.deleted ?? []
    for (const id of deleted) this.messages.delete(id)
    if (deleted.length) store.remove({ messageIds: deleted })

    const gaps = this.findGaps(inbox)
    for (const t of inbox.threads) this.threads.set(t.id, t)
    for (const c of inbox.contacts) this.contacts.set(c.id, c)
    for (const m of inbox.messages) this.messages.set(m.id, m)
    store.put({ threads: inbox.threads, contacts: inbox.contacts, messages: inbox.messages })

    this.linked = new Map(inbox.accounts.map((a) => [a.network, a]))
    this.accountEvents.emit(this.accounts())
    this.setStatus({ state: 'online' })
    this.events.emit({ type: 'reloaded' })
    if (gaps.length) void this.fillGaps(gaps)
  }

  /**
   * Chats where more messages came in while this device was away than the server keeps: between
   * the newest this device has and the oldest the server has, some are missing.
   */
  private findGaps(inbox: ServerInbox) {
    const fromServer = new Map<string, Message[]>()
    for (const m of inbox.messages) fromServer.set(m.threadId, [...(fromServer.get(m.threadId) ?? []), m])
    const newestHere = new Map<string, string>()
    for (const m of this.messages.values()) {
      if ((newestHere.get(m.threadId) ?? '') < m.sentAt) newestHere.set(m.threadId, m.sentAt)
    }
    const gaps: { threadId: string; from: Message; until: string }[] = []
    for (const [threadId, all] of fromServer) {
      const until = newestHere.get(threadId)
      // The chat's latest: older pinned and starred messages come along, but aren't part of the run.
      const list = [...all].sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1)).slice(0, MESSAGES_KEPT_PER_CHAT)
      if (!until || list.length < MESSAGES_KEPT_PER_CHAT) continue
      const oldest = list[list.length - 1]!
      if (until < oldest.sentAt) gaps.push({ threadId, from: oldest, until })
    }
    return gaps.sort((a, b) => (a.from.sentAt < b.from.sentAt ? 1 : -1)).slice(0, GAP_CHATS)
  }

  /** Fetches what's missing, a few pages per chat; anything further comes as the user scrolls back. */
  private async fillGaps(gaps: { threadId: string; from: Message; until: string }[]) {
    let added = false
    for (const gap of gaps) {
      let from = gap.from
      for (let page = 0; page < GAP_PAGES; page++) {
        const older = await serverApi.older(gap.threadId, hintOf(from)).catch(() => null)
        if (!older?.messages.length || this.forgotten) break
        this.keepMessages(older.messages)
        added = true
        from = older.messages[0]!
        if (from.sentAt <= gap.until || !older.hasMore) break
      }
    }
    if (added && !this.forgotten) this.events.emit({ type: 'reloaded' })
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
        this.keepMessages([event.message])
        this.events.emit(event)
        return
      }
      case 'message.deleted':
        this.forgetMessage(event.messageId)
        this.events.emit(event)
        return
      case 'thread.updated':
        this.keepThreads([event.thread])
        this.events.emit(event)
        return
      case 'contact.updated':
        this.keepContacts([event.contact])
        this.events.emit(event)
        return
      case 'account.updated':
        if (event.account.status === 'unlinked') this.linked.delete(event.account.network)
        else this.linked.set(event.account.network, event.account)
        this.accountEvents.emit(this.accounts())
        return
      case 'account.qr':
        this.qrEvents.emit({ network: event.network, qr: event.qr })
        return
      case 'typing':
        this.events.emit(event)
        return
      case 'reloaded':
        void this.reload()
        return
      case 'user.updated':
        if (event.user.id === this.owner) this.onUserUpdated(event.user)
    }
  }

  private release(threadId: string) {
    if (this.inFlight.has(threadId)) return
    const held = this.held.get(threadId) ?? []
    this.held.delete(threadId)
    for (const event of held) {
      this.keepMessages([event.message])
      this.events.emit(event)
    }
  }

  private setStatus(status: ConnectorStatus) {
    if (status.state === this.current.state && status.detail === this.current.detail) return
    this.current = status
    this.statusEvents.emit(status)
  }
}
