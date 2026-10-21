import type { ConnectionsApi, ConnectionsState, InboxApi } from '../api'
import { MatrixConnector, signInToMatrix } from '../connectors/matrix/matrixConnector'
import { DEFAULT_TELEGRAM_API, isBadToken, TelegramError } from '../connectors/telegram/botApi'
import { TelegramConnector } from '../connectors/telegram/telegramConnector'
import type { Connector, ConnectorEvent, ConnectorId } from '../connectors/types'
import { createMockApi } from '../mock/mockApi'
import { searchMessages } from '../search'
import type { InboxEvent, InboxSnapshot, Message, ScheduledMessage, Task, Thread } from '../types'
import { ME_ID } from '../types'
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
 * - Reads merge every source; writes are routed by id prefix ("tg:", "mx:", none for demo chats).
 * - Done/snoozed state, tasks and "send later" for real accounts live on this device, since the
 *   networks have no such thing. Scheduled messages go out while the app is open; one that was
 *   due while it was closed waits for the user rather than arriving hours late.
 * - Connectors keep syncing in the background and push changes through `subscribe`.
 */

const SCHEDULER_INTERVAL_MS = 5_000
/** A scheduled message this late (the app was closed) is held back instead of sent. */
const MISSED_AFTER_MS = 60 * 60 * 1000

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

type SourceId = 'demo' | ConnectorId

export function sourceOf(id: string): SourceId {
  if (id.startsWith('tg:')) return 'telegram'
  if (id.startsWith('mx:')) return 'matrix'
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

  function connectorFor(threadId: string): Connector {
    const source = sourceOf(threadId)
    const entry = source === 'demo' ? undefined : connectors.get(source)
    if (!entry) throw new Error('This account is no longer connected.')
    return entry.connector
  }

  /** Adds this device's done/snoozed state to a connector's thread. */
  function withLocalState(thread: Thread): Thread {
    threadCache.set(thread.id, thread)
    const state = local.threadState[thread.id]
    return { ...thread, doneAt: state?.doneAt ?? null, snoozedUntil: state?.snoozedUntil ?? null }
  }

  function onConnectorEvent(event: ConnectorEvent) {
    switch (event.type) {
      case 'reloaded':
        void reloadAll()
        return
      case 'thread.updated':
        emit({ type: 'thread.updated', thread: withLocalState(event.thread) })
        return
      case 'message.created': {
        emit(event)
        // Like most inboxes, a new message brings a snoozed chat straight back.
        const state = local.threadState[event.message.threadId]
        const cached = threadCache.get(event.message.threadId)
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

  async function snapshot(): Promise<InboxSnapshot> {
    const demoSnapshot = config.demo ? await demoApi.loadInbox() : null
    if (demoSnapshot && !local.importedDemoTasks) {
      local = { ...local, tasks: [...local.tasks, ...demoSnapshot.tasks], importedDemoTasks: true }
      persistLocal()
    }
    const parts = [...connectors.values()].map(({ connector }) => connector.snapshot())
    const liveThreadIds = new Set(parts.flatMap((p) => p.threads.map((t) => t.id)))
    return {
      me: {
        id: ME_ID,
        // In the demo you're its persona; otherwise the name your accounts know you by.
        name: demoSnapshot?.me.name ?? parts.find((p) => p.selfName)?.selfName ?? 'Me',
      },
      contacts: [...(demoSnapshot?.contacts ?? []), ...parts.flatMap((p) => p.contacts)],
      threads: [...(demoSnapshot?.threads ?? []), ...parts.flatMap((p) => p.threads.map(withLocalState))],
      messages: [...(demoSnapshot?.messages ?? []), ...parts.flatMap((p) => p.messages)],
      scheduled: [...(demoSnapshot?.scheduled ?? []), ...local.scheduled.filter((s) => liveThreadIds.has(s.threadId))],
      tasks: local.tasks,
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
      if (source === 'demo' || !connectors.has(source)) continue
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
    let offDemo = config.demo ? demoApi.subscribe(onDemoEvent) : null
    for (const { connector } of connectors.values()) connector.start()
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
      for (const { connector } of connectors.values()) connector.stop()
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
    if (previous.demo !== next.demo) showDemo?.(next.demo)
    notifyConnections()
  }

  /* ── Connections ─────────────────────────────────────────────────────────── */

  function connectionsState(): ConnectionsState {
    return {
      demo: config.demo,
      telegram: connectors.get('telegram')?.connector.status() ?? null,
      matrix: connectors.get('matrix')?.connector.status() ?? null,
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

  /** Removes everything this device kept for one source's chats. */
  function forgetLocal(source: SourceId) {
    const keep = (threadId: string) => sourceOf(threadId) !== source
    local = {
      ...local,
      threadState: Object.fromEntries(Object.entries(local.threadState).filter(([id]) => keep(id))),
      scheduled: local.scheduled.filter((s) => keep(s.threadId)),
    }
    persistLocal()
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
  }

  /* ── InboxApi ────────────────────────────────────────────────────────────── */

  return {
    loadInbox: snapshot,

    async sendMessage(threadId, body) {
      if (sourceOf(threadId) === 'demo') return demoApi.sendMessage(threadId, body)
      return connectorFor(threadId).sendMessage(threadId, body)
    },

    async markRead(threadId) {
      if (sourceOf(threadId) === 'demo') return demoApi.markRead(threadId)
      // A read marker that doesn't reach the network is caught up on the next read; never fail here.
      const thread = (await connectorFor(threadId).markRead(threadId).catch(() => null)) ?? threadCache.get(threadId)
      if (!thread) throw new Error(`Unknown thread ${threadId}`)
      return withLocalState({ ...thread, unreadCount: 0 })
    },

    async updateThreadState(threadId, patch) {
      if (sourceOf(threadId) === 'demo') return demoApi.updateThreadState(threadId, patch)
      const current = local.threadState[threadId] ?? { doneAt: null, snoozedUntil: null }
      local = { ...local, threadState: { ...local.threadState, [threadId]: { ...current, ...patch } } }
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

    async searchMessages(query, options) {
      const limit = options?.limit ?? 20
      const demoHits = config.demo ? await demoApi.searchMessages(query, { limit }) : []
      const parts = [...connectors.values()].map(({ connector }) => connector.snapshot())
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
      local = { ...local, tasks: [...local.tasks, task] }
      persistLocal()
      return task
    },

    async updateTask(taskId, patch) {
      const task = local.tasks.find((t) => t.id === taskId)
      if (!task) throw new Error(`Unknown task ${taskId}`)
      const updated = { ...task, ...patch }
      local = { ...local, tasks: local.tasks.map((t) => (t.id === taskId ? updated : t)) }
      persistLocal()
      return updated
    },

    async deleteTask(taskId) {
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
        if (!config.demo) return snapshot()
        await demoApi.demo.reset()
        // The demo chats are regenerated, so tasks that pointed into them go too.
        local = { ...local, tasks: local.tasks.filter((t) => !t.source || sourceOf(t.source.threadId) !== 'demo') }
        persistLocal()
        return snapshot()
      },
      async simulateIncoming() {
        return config.demo ? demoApi.demo.simulateIncoming() : null
      },
    },
  }
}
