import type { BotApiConfig } from '../connectors/telegram/botApi'
import type { MatrixConfig } from '../connectors/matrix/matrixConnector'
import { readJson, writeJson } from '../storage'
import type { ScheduledMessage, Task, ThreadStatePatch } from '../types'

/**
 * What the unified API keeps on this device besides the connectors' own caches.
 *
 * Credentials live here too (bot token, Matrix access token), in this browser's local storage:
 * anyone with access to this browser profile can read them, so Settings says so and disconnecting
 * deletes them.
 */
export const CONFIG_KEY = 'tidings.connections'
export const LOCAL_KEY = 'tidings.local'

export interface ConnectionsConfig {
  /** Show the demo inbox alongside (or instead of) real accounts. */
  demo: boolean
  telegram?: BotApiConfig
  matrix?: MatrixConfig
}

/** Inbox features networks don't have, for chats from real accounts. */
export interface LocalState {
  /** Done and snoozed state, per thread. */
  threadState: Record<string, Required<ThreadStatePatch>>
  /** Every task, wherever it came from. */
  tasks: Task[]
  /** "Send later" for chats from real accounts. Demo chats keep theirs in the demo backend. */
  scheduled: ScheduledMessage[]
  /** Tasks used to live in the demo backend; they are copied over once. */
  importedDemoTasks: boolean
}

export function loadConfig(): ConnectionsConfig {
  return { demo: true, ...readJson<Partial<ConnectionsConfig>>(CONFIG_KEY) }
}

export function saveConfig(config: ConnectionsConfig) {
  writeJson(CONFIG_KEY, config)
}

export function loadLocal(): LocalState {
  return { threadState: {}, tasks: [], scheduled: [], importedDemoTasks: false, ...readJson<Partial<LocalState>>(LOCAL_KEY) }
}

export function saveLocal(state: LocalState) {
  writeJson(LOCAL_KEY, state)
}
