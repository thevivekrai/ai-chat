import type { ConnectionsApi, ConnectionsState, InboxApi } from '../api'
import { MatrixConnector, signInToMatrix } from '../connectors/matrix/matrixConnector'
import { DEFAULT_TELEGRAM_API, isBadToken, TelegramError } from '../connectors/telegram/botApi'
import { TelegramConnector } from '../connectors/telegram/telegramConnector'
import type { Connector, ConnectorEvent, ConnectorId } from '../connectors/types'
import { createMockApi } from '../mock/mockApi'
import { searchMessages } from '../search'
import { serverApi } from '../server/serverApi'
import { ServerConnector } from '../server/serverConnector'
import { LINKED_PREFIXES, type PublicUser } from '../server/types'
import type { InboxEvent, InboxSnapshot, Message, ScheduledMessage, Task, Thread } from '../types'
import { ME_ID, NO_CAPABILITIES } from '../types'
import {
  CONFIG_KEY,
  LOCAL_KEY,
  loadConfig,
  loadLocal,
  saveConfig,
  saveLocal,
  type ConnectionsConfig,
  type LocalState,
} from './persisted'

/**
 * The inbox as one API over every source: the demo inbox and any connected accounts.
 *
 * - Reads merge every source; writes are routed by id prefix ("tg:", "mx:", "wa:"/"tga:" for
 *   accounts linked on the Sytext server, none for demo chats).
 * - Done/snoozed state, tasks and "send later" for real accounts live on this device, since the
 *   networks have no such thing; for chats linked on the Sytext server, done/snoozed and tasks
 *   are kept with the account instead, so signing out and back in (or another device) keeps them. Scheduled messages go out while the app is open; one that was
 *   due while it was closed waits for the user rather than arriving hours late.
 * - Connectors keep syncing in the background and push changes through `subscribe`.
 */

const SCHEDULER_INTERVAL_MS = 5_000
/** A scheduled message this late (the app was closed) is held back instead of sent. */
const MISSED_AFTER_MS = 60 * 60 * 1000

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

type SourceId = 'demo' | ConnectorId | 'server'

export function sourceOf(id: string): SourceId {
  if (id.startsWith('tg:')) return 'telegram'
  if (id.startsWith('mx:')) return 'matrix'
  if (Object.values(LINKED_PREFIXES).some((prefix) => id.startsWith(prefix))) return 'server'
  return 'demo'
}

function createConnector(id: ConnectorId, config: ConnectionsConfig): Connector | null {
  if (id === 'telegram' && config.telegram) return new TelegramConnector(config.telegram)
  if (id === 'matrix' && config.matrix) return new MatrixConnector(config.matrix)
  return null
}

export function createUnifiedApi(): InboxApi {
  const demoApi = createMockApi()
  let config = loadConfig()
  let local: LocalState = loadLocal()
  const connectors = new Map<ConnectorId, { connector: Connector; detach: () => void }>()
  /** Accounts linked on the Sytext server, while signed in to it. */
  let server: { connector: ServerConnector; name: string; detach: () => void } | null = null
  /**
   * The demo chats are for trying Sytext without an account: once signed in, only your own chats
   * show (the setting is kept for when you sign out, or use it without an account).
   */
  const demoShown = () => config.demo && !server
  const signedOutListeners = new Set<() => void>()
  const userListeners = new Set<(user: PublicUser) => void>()
  /** Latest copy of every connector thread, for events that need the whole thread. */
  const threadCache = new Map<string, Thread>()
  const listeners = new Set<(event: InboxEvent) => void>()
  const connectionListeners = new Set<(state: ConnectionsState) => void>()
  let running = false
  let stopRunning: (() => void) | null = null

  const emit = (event: InboxEvent) => listeners.forEach((listener) => listener(event))
  const persistLocal = () => saveLocal(local)

  /* ── Sources ─────────────────────────────────────────────────────────────── */

  function attach(id: ConnectorId) {
    const connector = createConnector(id, config)
    if (!connector) return
    const offEvents = connector.subscribe((event) => onConnectorEvent(event))
    const offStatus = connector.onStatus(() => notifyConnections())
    connectors.set(id, { connector, detach: () => (offEvents(), offStatus(), connector.stop()) })
    if (running) connector.start()
  }

  function detach(id: ConnectorId) {
    connectors.get(id)?.detach()
    connectors.delete(id)
  }

  for (const id of ['telegram', 'matrix'] as const) attach(id)

  /** Every connected source besides the demo inbox. */
  const sources = (): Connector[] => [...[...connectors.values()].map((e) => e.connector), ...(server ? [server.connector] : [])]

  function connectorFor(threadId: string): Connector {
    const source = sourceOf(threadId)
    const connector = source === 'demo' ? undefined : source === 'server' ? server?.connector : connectors.get(source)?.connector
    if (!connector) throw new Error('This account is no longer connected.')
    return connector
  }

  const hasSource = (source: SourceId) => (source === 'server' ? !!server : source !== 'demo' && connectors.has(source))

  /** Chats whose done/snoozed state and tasks the server keeps with the account. */
  const keptWithAccount = (threadId: string) => sourceOf(threadId) === 'server' && !!server

  /** Adds this device's done/snoozed state and tags to a connector's thread (the account's, for linked chats). */
  function withLocalState(thread: Thread): Thread {
    threadCache.set(thread.id, thread)
    if (keptWithAccount(thread.id)) return local.archived.includes(thread.id) ? { ...thread, archived: true } : thread
    const state = local.threadState[thread.id]
    return {
      ...thread,
      doneAt: state?.doneAt ?? null,
      snoozedUntil: state?.snoozedUntil ?? null,
      ...(state?.labels?.length ? { labels: state.labels } : {}),
      ...(state?.labelsLocked ? { labelsLocked: true } : {}),
      ...(local.archived.includes(thread.id) ? { archived: true } : {}),
    }
  }

  function onConnectorEvent(event: ConnectorEvent) {
    switch (event.type) {
      case 'reloaded':
        void reloadAll().then(moveToAccount)
        return
      case 'thread.updated':
        emit({ type: 'thread.updated', thread: withLocalState(event.thread) })
        return
      case 'message.created': {
        emit(event)
        // Like most inboxes, a new message brings a snoozed chat straight back (the server does the
        // same for the chats it keeps).
        const cached = threadCache.get(event.message.threadId)
        if (keptWithAccount(event.message.threadId)) {
          if (event.message.senderId !== ME_ID && cached?.snoozedUntil) {
            emit({ type: 'thread.updated', thread: withLocalState({ ...cached, snoozedUntil: null }) })
          }
          return
        }
        const state = local.threadState[event.message.threadId]
        if (event.message.senderId !== ME_ID && state?.snoozedUntil) {
          state.snoozedUntil = null
          persistLocal()
          if (cached) emit({ type: 'thread.updated', thread: withLocalState(cached) })
        }
        return
      }
      default:
        emit(event)
    }
  }

  /**
   * Done/snoozed state and tasks kept on this device for linked chats (before the account kept
   * them) move to the account, once its chats have loaded. What can't be moved stays here.
   */
  let moving = false
  async function moveToAccount() {
    const connector = server?.connector
    if (!connector || moving) return
    const known = new Set(connector.snapshot().threads.map((t) => t.id))
    const states = Object.entries(local.threadState).filter(([id]) => sourceOf(id) === 'server' && known.has(id))
    const tasks = local.tasks.filter((t) => t.source && sourceOf(t.source.threadId) === 'server' && known.has(t.source.threadId))
    if (!states.length && !tasks.length) return
    moving = true
    try {
      const moved = new Set<string>()
      for (const [id, state] of states) {
        if (await connector.setThreadState(id, state).then(() => true, () => false)) moved.add(id)
      }
      const movedTasks = new Set<string>()
      for (const task of tasks) if (await connector.putTask(task).then(() => true, () => false)) movedTasks.add(task.id)
      local = {
        ...local,
        threadState: Object.fromEntries(Object.entries(local.threadState).filter(([id]) => !moved.has(id))),
        tasks: local.tasks.filter((t) => !movedTasks.has(t.id)),
      }
      persistLocal()
    } finally {
      moving = false
    }
    await reloadAll()
  }

  async function snapshot(): Promise<InboxSnapshot> {
    const demoSnapshot = demoShown() ? await demoApi.loadInbox() : null
    if (demoSnapshot && !local.importedDemoTasks) {
      local = { ...local, tasks: [...local.tasks, ...demoSnapshot.tasks], importedDemoTasks: true }
      persistLocal()
    }
    const parts = sources().map((connector) => connector.snapshot())
    const liveThreadIds = new Set(parts.flatMap((p) => p.threads.map((t) => t.id)))
    const demoThreadIds = new Set(demoSnapshot?.threads.map((t) => t.id))
    // Tasks from demo chats show with them: not while they're hidden, or after a regenerated demo
    // dropped the chat they point into (they'd have nowhere to go).
    const kept = parts.flatMap((p) => p.tasks ?? [])
    const keptIds = new Set(kept.map((t) => t.id))
    const tasks = [
      ...local.tasks.filter((t) => !keptIds.has(t.id) && (!t.source || sourceOf(t.source.threadId) !== 'demo' || demoThreadIds.has(t.source.threadId))),
      ...kept,
    ]
    return {
      me: {
        id: ME_ID,
        // Your name when signed in; in the demo, its persona; otherwise what your accounts call you.
        name: server?.name || demoSnapshot?.me.name || parts.find((p) => p.selfName)?.selfName || 'Me',
      },
      contacts: [...(demoSnapshot?.contacts ?? []), ...parts.flatMap((p) => p.contacts)],
      threads: [...(demoSnapshot?.threads ?? []), ...parts.flatMap((p) => p.threads.map(withLocalState))],
      messages: [...(demoSnapshot?.messages ?? []), ...parts.flatMap((p) => p.messages)],
      scheduled: [...(demoSnapshot?.scheduled ?? []), ...local.scheduled.filter((s) => liveThreadIds.has(s.threadId))],
      tasks,
    }
  }

  async function reloadAll() {
    emit({ type: 'reset', snapshot: await snapshot() })
  }

  /* ── Scheduled sends for real accounts ───────────────────────────────────── */

  const sending = new Set<string>()

  function updateScheduled(item: ScheduledMessage) {
    local = { ...local, scheduled: local.scheduled.map((s) => (s.id === item.id ? item : s)) }
    persistLocal()
    emit({ type: 'scheduled.updated', scheduled: item })
  }

  function removeScheduled(id: string) {
    local = { ...local, scheduled: local.scheduled.filter((s) => s.id !== id) }
    persistLocal()
  }

  /** Sends one scheduled message, at most once even with the app open in several tabs. */
  async function deliver(item: ScheduledMessage): Promise<Message> {
    const run = async () => {
      // Another tab may have sent or cancelled it already.
      const current = loadLocal().scheduled.find((s) => s.id === item.id)
      if (!current) throw new Error('This message was already sent or cancelled.')
      const message = await connectorFor(item.threadId).sendMessage(item.threadId, item.body)
      local = loadLocal()
      removeScheduled(item.id)
      return message
    }
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
    return locks ? locks.request(`tidings:scheduled:${item.id}`, run) : run()
  }

  async function deliverDue(now = Date.now()) {
    for (const item of local.scheduled) {
      if (item.error || sending.has(item.id) || Date.parse(item.sendAt) > now) continue
      const source = sourceOf(item.threadId)
      if (source === 'demo' || !hasSource(source)) continue
      if (now - Date.parse(item.sendAt) > MISSED_AFTER_MS) {
        updateScheduled({ ...item, error: 'Not sent: the app was closed at the scheduled time.' })
        continue
      }
      sending.add(item.id)
      try {
        const message = await deliver(item)
        emit({ type: 'scheduled.removed', scheduledId: item.id })
        emit({ type: 'message.created', message })
      } catch (error) {
        if (local.scheduled.some((s) => s.id === item.id)) {
          updateScheduled({ ...item, error: `Not sent: ${error instanceof Error ? error.message : 'sending failed'}` })
        }
      } finally {
        sending.delete(item.id)
      }
    }
  }

  /* ── Running ─────────────────────────────────────────────────────────────── */

  function onDemoEvent(event: InboxEvent) {
    if (event.type === 'reset') void reloadAll()
    else emit(event)
  }

  /** Follows the demo inbox's events while it is shown; set while running. */
  let showDemo: ((enabled: boolean) => void) | null = null

  function start() {
    running = true
    let offDemo = demoShown() ? demoApi.subscribe(onDemoEvent) : null
    for (const connector of sources()) connector.start()
    const timer = setInterval(() => void deliverDue(), SCHEDULER_INTERVAL_MS)
    void deliverDue()

    // Another tab changed accounts, tasks or done/snoozed state: pick that up.
    let pending: ReturnType<typeof setTimeout> | null = null
    const onStorage = (e: StorageEvent) => {
      if (e.key === CONFIG_KEY) reconcile(loadConfig())
      if (e.key !== LOCAL_KEY && e.key !== CONFIG_KEY) return
      local = loadLocal()
      if (pending) clearTimeout(pending)
      pending = setTimeout(() => void reloadAll(), 300)
    }
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)

    showDemo = (enabled) => {
      offDemo?.()
      offDemo = enabled ? demoApi.subscribe(onDemoEvent) : null
    }
    stopRunning = () => {
      running = false
      offDemo?.()
      clearInterval(timer)
      if (pending) clearTimeout(pending)
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
      for (const connector of sources()) connector.stop()
      showDemo = null
    }
  }

  /** Brings running connectors in line with a changed config. */
  function reconcile(next: ConnectionsConfig) {
    const previous = config
    config = next
    for (const id of ['telegram', 'matrix'] as const) {
      if (JSON.stringify(previous[id]) === JSON.stringify(next[id])) continue
      detach(id)
      attach(id)
    }
    if (previous.demo !== next.demo) showDemo?.(demoShown())
    notifyConnections()
  }

  /* ── Connections ─────────────────────────────────────────────────────────── */

  function connectionsState(): ConnectionsState {
    const linked = server?.connector.accounts() ?? []
    return {
      demo: demoShown(),
      telegram: connectors.get('telegram')?.connector.status() ?? null,
      matrix: connectors.get('matrix')?.connector.status() ?? null,
      server: server && {
        status: server.connector.status(),
        known: server.connector.accountsKnown(),
        whatsapp: linked.find((a) => a.network === 'whatsapp') ?? null,
        telegram: linked.find((a) => a.network === 'telegram') ?? null,
        guffshuff: linked.find((a) => a.network === 'guffshuff') ?? null,
        instagram: linked.find((a) => a.network === 'instagram') ?? null,
      },
    }
  }

  function notifyConnections() {
    const state = connectionsState()
    connectionListeners.forEach((listener) => listener(state))
  }

  function saveAndApply(next: ConnectionsConfig) {
    saveConfig(next)
    reconcile(next)
  }

  /** Removes everything this device kept for one source's chats (and, if asked, tasks from them). */
  function forgetLocal(source: SourceId, { tasks = false } = {}) {
    const keep = (threadId: string) => sourceOf(threadId) !== source
    local = {
      ...local,
      threadState: Object.fromEntries(Object.entries(local.threadState).filter(([id]) => keep(id))),
      archived: local.archived.filter(keep),
      scheduled: local.scheduled.filter((s) => keep(s.threadId)),
      tasks: tasks ? local.tasks.filter((t) => !t.source || keep(t.source.threadId)) : local.tasks,
    }
    persistLocal()
  }

  function requireServer(): ServerConnector {
    if (!server) throw new Error('Sign in to link accounts.')
    return server.connector
  }

  const connections: ConnectionsApi = {
    get: connectionsState,

    subscribe(listener) {
      connectionListeners.add(listener)
      return () => connectionListeners.delete(listener)
    },

    async setDemoEnabled(enabled) {
      saveAndApply({ ...config, demo: enabled })
      await reloadAll()
    },

    async connectTelegram({ token, apiBase }) {
      const telegram = { token: token.trim(), apiBase: apiBase?.trim() || DEFAULT_TELEGRAM_API }
      try {
        await TelegramConnector.verify(telegram)
      } catch (error) {
        if (isBadToken(error)) throw new Error("Telegram didn't accept that token. Copy it again from @BotFather.")
        if (error instanceof TelegramError && error.code === 0) {
          throw new Error(`Couldn't reach ${telegram.apiBase}. Check your connection or the server address.`)
        }
        throw error
      }
      // A different bot's cached chats are dropped by the connector once it sees the new bot.
      saveAndApply({ ...config, telegram })
      await reloadAll()
    },

    async connectMatrix(login) {
      const matrix = await signInToMatrix(login)
      if (config.matrix) {
        await connectors.get('matrix')?.connector.forget()
        forgetLocal('matrix')
      }
      saveAndApply({ ...config, matrix })
      await reloadAll()
    },

    async disconnect(id) {
      await connectors.get(id)?.connector.forget()
      forgetLocal(id)
      const next = { ...config }
      delete next[id]
      saveAndApply(next)
      await reloadAll()
    },

    async applyFix(id, fixId) {
      await connectors.get(id)?.connector.applyFix?.(fixId)
    },

    async setServerSession(user) {
      if (user && server) {
        server.name = user.name
        return
      }
      if (!user && !server) return
      if (user) {
        const connector = new ServerConnector({
          owner: user.id,
          onSignedOut: () => signedOutListeners.forEach((listener) => listener()),
          onUserUpdated: (changed) => userListeners.forEach((listener) => listener(changed)),
        })
        const offEvents = connector.subscribe((event) => onConnectorEvent(event))
        const offStatus = connector.onStatus(() => notifyConnections())
        const offAccounts = connector.onAccounts(() => notifyConnections())
        server = { connector, name: user.name, detach: () => (offEvents(), offStatus(), offAccounts(), void connector.forget()) }
        if (running) connector.start()
      } else {
        server?.detach()
        server = null
        // Signed out: nothing of that account's chats stays on this device (the connector deletes
        // its copy of them). The links themselves carry on, on the server.
        forgetLocal('server', { tasks: true })
      }
      showDemo?.(demoShown())
      notifyConnections()
      await reloadAll()
    },

    onSignedOut(listener) {
      signedOutListeners.add(listener)
      return () => signedOutListeners.delete(listener)
    },

    onUserUpdated(listener) {
      userListeners.add(listener)
      return () => userListeners.delete(listener)
    },

    async linkWhatsApp(request) {
      const connector = requireServer()
      const result = await serverApi.linkWhatsApp(request)
      void connector.refreshAccounts().catch(() => undefined)
      return result
    },

    onLinkQr(listener) {
      return server ? server.connector.onQr(listener) : () => {}
    },

    async requestTelegramCode(phone) {
      const connector = requireServer()
      const result = await serverApi.telegramCode(phone)
      void connector.refreshAccounts().catch(() => undefined)
      return result
    },

    async requestTelegramQr() {
      const connector = requireServer()
      const result = await serverApi.telegramQr()
      void connector.refreshAccounts().catch(() => undefined)
      return result
    },

    async verifyTelegramCode(code) {
      const connector = requireServer()
      const result = await serverApi.telegramVerify(code)
      void connector.refreshAccounts().catch(() => undefined)
      return result
    },

    async verifyTelegramPassword(password) {
      const connector = requireServer()
      const result = await serverApi.telegramPassword(password)
      void connector.refreshAccounts().catch(() => undefined)
      return result
    },

    async linkGuffshuff(username, password) {
      const connector = requireServer()
      const result = await serverApi.linkGuffshuff(username, password)
      await connector.refreshAccounts()
      return result
    },

    async linkInstagram(username, password) {
      const connector = requireServer()
      const result = await serverApi.linkInstagram(username, password)
      await connector.refreshAccounts()
      return result
    },

    async verifyInstagramCode(code) {
      const connector = requireServer()
      const result = await serverApi.instagramVerify(code)
      await connector.refreshAccounts()
      return result
    },

    async unlink(network) {
      const connector = requireServer()
      await (network === 'whatsapp'
        ? serverApi.unlinkWhatsApp()
        : network === 'guffshuff'
          ? serverApi.unlinkGuffshuff()
          : network === 'instagram'
            ? serverApi.unlinkInstagram()
            : serverApi.unlinkTelegram())
      // Done/snoozed state and scheduled sends for that network's chats go too.
      const prefix = LINKED_PREFIXES[network]
      local = {
        ...local,
        threadState: Object.fromEntries(Object.entries(local.threadState).filter(([id]) => !id.startsWith(prefix))),
        scheduled: local.scheduled.filter((s) => !s.threadId.startsWith(prefix)),
      }
      persistLocal()
      await connector.refreshAccounts()
    },
  }

  /* ── InboxApi ────────────────────────────────────────────────────────────── */

  return {
    loadInbox: snapshot,

    async sendMessage(threadId, body, options) {
      if (sourceOf(threadId) === 'demo') return demoApi.sendMessage(threadId, body, options)
      return connectorFor(threadId).sendMessage(threadId, body, options)
    },

    capabilities(threadId) {
      if (sourceOf(threadId) === 'demo') return demoApi.capabilities(threadId)
      const source = sourceOf(threadId)
      const connector = source === 'server' ? server?.connector : connectors.get(source as ConnectorId)?.connector
      return connector?.capabilities?.(threadId) ?? NO_CAPABILITIES
    },

    async actOnMessage(threadId, messageId, action) {
      if (sourceOf(threadId) === 'demo') return demoApi.actOnMessage(threadId, messageId, action)
      const connector = connectorFor(threadId)
      if (!connector.actOnMessage) throw new Error("This chat can't do that.")
      return connector.actOnMessage(threadId, messageId, action)
    },

    async react(threadId, messageId, emoji) {
      if (sourceOf(threadId) === 'demo') return demoApi.react(threadId, messageId, emoji)
      const connector = connectorFor(threadId)
      if (!connector.react) throw new Error("This chat doesn't support reactions.")
      return connector.react(threadId, messageId, emoji)
    },

    async setTyping(threadId, typing) {
      if (sourceOf(threadId) === 'demo') return demoApi.setTyping(threadId, typing)
      try {
        await connectorFor(threadId).setTyping?.(threadId, typing)
      } catch {
        // Only a courtesy to the other side; never worth an error.
      }
    },

    async loadOlder(threadId, beforeId) {
      if (sourceOf(threadId) === 'demo') return demoApi.loadOlder(threadId, beforeId)
      const connector = connectorFor(threadId)
      return connector.loadOlder ? connector.loadOlder(threadId, beforeId) : { messages: [], hasMore: false }
    },

    async markRead(threadId, options) {
      if (sourceOf(threadId) === 'demo') return demoApi.markRead(threadId)
      // A read marker that doesn't reach the network is caught up on the next read; never fail here,
      // unless a read receipt was asked for.
      const reading = connectorFor(threadId).markRead(threadId, options)
      const thread = (await (options?.receipt ? reading : reading.catch(() => null))) ?? threadCache.get(threadId)
      if (!thread) throw new Error(`Unknown thread ${threadId}`)
      return withLocalState({ ...thread, unreadCount: 0 })
    },

    async updateThreadState(threadId, patch) {
      if (sourceOf(threadId) === 'demo') return demoApi.updateThreadState(threadId, patch)
      if (keptWithAccount(threadId)) return withLocalState(await requireServer().setThreadState(threadId, patch))
      const current = local.threadState[threadId] ?? { doneAt: null, snoozedUntil: null, labels: [], labelsLocked: false }
      local = { ...local, threadState: { ...local.threadState, [threadId]: { ...current, ...patch } } }
      persistLocal()
      const thread = threadCache.get(threadId)
      if (!thread) throw new Error(`Unknown thread ${threadId}`)
      return withLocalState(thread)
    },

    async archiveThread(threadId, archived) {
      if (sourceOf(threadId) === 'demo') return demoApi.archiveThread(threadId, archived)
      const connector = connectorFor(threadId)
      if (connector.archiveThread) return withLocalState(await connector.archiveThread(threadId, archived))
      // Networks that can't archive: kept on this device, like done and snoozed.
      const others = local.archived.filter((id) => id !== threadId)
      local = { ...local, archived: archived ? [...others, threadId] : others }
      persistLocal()
      const thread = threadCache.get(threadId)
      if (!thread) throw new Error(`Unknown thread ${threadId}`)
      return withLocalState(thread)
    },

    async scheduleMessage(threadId, body, sendAt) {
      if (sourceOf(threadId) === 'demo') return demoApi.scheduleMessage(threadId, body, sendAt)
      connectorFor(threadId)
      const item: ScheduledMessage = { id: newId('ls'), threadId, body, sendAt, createdAt: new Date().toISOString() }
      local = { ...local, scheduled: [...local.scheduled, item] }
      persistLocal()
      return item
    },

    async cancelScheduled(scheduledId) {
      if (local.scheduled.some((s) => s.id === scheduledId)) return removeScheduled(scheduledId)
      return demoApi.cancelScheduled(scheduledId)
    },

    async sendScheduledNow(scheduledId) {
      const item = local.scheduled.find((s) => s.id === scheduledId)
      if (!item) return demoApi.sendScheduledNow(scheduledId)
      sending.add(item.id)
      try {
        return await deliver(item)
      } catch (error) {
        updateScheduled({ ...item, error: `Not sent: ${error instanceof Error ? error.message : 'sending failed'}` })
        throw error
      } finally {
        sending.delete(item.id)
      }
    },

    async findPeople(query) {
      if (!server) return []
      return serverApi.findPeople(query)
    },

    async startChat(contactId) {
      requireServer()
      const { thread } = await serverApi.startChat(contactId)
      return withLocalState(thread)
    },

    async searchMessages(query, options) {
      const limit = options?.limit ?? 20
      const demoHits = demoShown() ? await demoApi.searchMessages(query, { limit }) : []
      const parts = sources().map((connector) => connector.snapshot())
      const connectorHits = searchMessages(
        {
          threads: parts.flatMap((p) => p.threads),
          messages: parts.flatMap((p) => p.messages),
          contacts: parts.flatMap((p) => p.contacts),
        },
        query,
        limit,
      )
      return [...demoHits, ...connectorHits].sort((a, b) => b.score - a.score).slice(0, limit)
    },

    async addTask(input) {
      const task: Task = { id: newId('t'), done: false, createdAt: new Date().toISOString(), ...input }
      if (task.source && keptWithAccount(task.source.threadId)) return requireServer().putTask(task)
      local = { ...local, tasks: [...local.tasks, task] }
      persistLocal()
      return task
    },

    async updateTask(taskId, patch) {
      const keptTask = server?.connector.snapshot().tasks?.find((t) => t.id === taskId)
      if (keptTask) return requireServer().putTask({ ...keptTask, ...patch })
      const task = local.tasks.find((t) => t.id === taskId)
      if (!task) throw new Error(`Unknown task ${taskId}`)
      const updated = { ...task, ...patch }
      local = { ...local, tasks: local.tasks.map((t) => (t.id === taskId ? updated : t)) }
      persistLocal()
      return updated
    },

    async deleteTask(taskId) {
      if (server?.connector.hasTask(taskId)) return requireServer().deleteTask(taskId)
      local = { ...local, tasks: local.tasks.filter((t) => t.id !== taskId) }
      persistLocal()
    },

    subscribe(listener) {
      listeners.add(listener)
      if (!running) start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stopRunning?.()
      }
    },

    connections,

    demo: {
      async reset() {
        if (!demoShown()) return snapshot()
        await demoApi.demo.reset()
        // The demo chats are regenerated, so tasks that pointed into them go too.
        local = { ...local, tasks: local.tasks.filter((t) => !t.source || sourceOf(t.source.threadId) !== 'demo') }
        persistLocal()
        return snapshot()
      },
      async simulateIncoming() {
        return demoShown() ? demoApi.demo.simulateIncoming() : null
      },
    },
  }
}
