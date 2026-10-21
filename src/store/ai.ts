import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  AiAccessError,
  TONES,
  canAiRead,
  classifyPriority,
  draftReply,
  extractTasks,
  summarizeThread,
  type AiThread,
  type ExtractedTask,
  type PriorityResult,
  type ThreadSummary,
  type Tone,
} from '@/ai'
import { toAiThread } from './aiInput'
import { settledLastMessageId, useInbox } from './inbox'

/**
 * Results of AI calls, with loading state. Each result is keyed by the thread's latest settled
 * message, so a new message makes it stale and it is recomputed on next use.
 */
export interface AiEntry<T> {
  key: string
  status: 'loading' | 'ready' | 'error'
  result?: T
}

export interface DraftSet {
  key: string
  variant: number
  items: Record<Tone, AiEntry<string>>
}

interface ResultTypes {
  priority: PriorityResult
  summary: ThreadSummary
  tasks: ExtractedTask[]
}

type Slice = keyof ResultTypes
type Entries<K extends Slice> = Record<string, AiEntry<ResultTypes[K]>>

interface AiState {
  priority: Entries<'priority'>
  summary: Entries<'summary'>
  tasks: Entries<'tasks'>
  drafts: Record<string, DraftSet>
  ensurePriority(threadId: string): void
  ensureSummary(threadId: string): void
  ensureTasks(threadId: string): void
  /** Starts (or restarts, with a new wording) the three tone drafts for a thread. */
  requestDrafts(threadId: string, options?: { regenerate?: boolean }): void
  forgetThread(threadId: string): void
  forgetAll(): void
}

/** Cache key and AI input for a thread, or null when AI may not read it. */
function aiInputFor(threadId: string): { key: string; thread: AiThread } | null {
  if (!canAiRead(threadId)) return null
  const { threads, messages, contacts, me } = useInbox.getState()
  const thread = threads[threadId]
  const key = settledLastMessageId(messages[threadId])
  if (!thread || !key) return null
  return { key, thread: toAiThread(thread, messages[threadId] ?? [], contacts, me) }
}

export const useAi = create<AiState>()(
  persist(
    (set, get) => {
      function ensure<K extends Slice>(slice: K, threadId: string, run: (thread: AiThread) => Promise<ResultTypes[K]>) {
        const input = aiInputFor(threadId)
        if (!input) return
        const entries = () => get()[slice] as Entries<K>
        const current = entries()[threadId]
        if (current && current.key === input.key && current.status !== 'error') return

        const write = (entry: AiEntry<ResultTypes[K]> | null) =>
          set(() => {
            const next = { ...entries() }
            if (entry) next[threadId] = entry
            else delete next[threadId]
            return { [slice]: next } as Partial<AiState>
          })
        const stillCurrent = () => entries()[threadId]?.key === input.key

        // Keep the previous result visible while recomputing, so tags don't flicker.
        write({ key: input.key, status: 'loading', result: current?.result })
        run(input.thread)
          .then((result) => stillCurrent() && write({ key: input.key, status: 'ready', result }))
          .catch((error: unknown) => {
            if (stillCurrent()) write(error instanceof AiAccessError ? null : { key: input.key, status: 'error' })
          })
      }

      return {
        priority: {},
        summary: {},
        tasks: {},
        drafts: {},

        ensurePriority: (threadId) => ensure('priority', threadId, classifyPriority),
        ensureSummary: (threadId) => ensure('summary', threadId, summarizeThread),
        ensureTasks: (threadId) => ensure('tasks', threadId, extractTasks),

        requestDrafts(threadId, { regenerate = false } = {}) {
          const input = aiInputFor(threadId)
          if (!input) return
          const { key, thread } = input
          const current = get().drafts[threadId]
          const reusable =
            current?.key === key && Object.values(current.items).every((item) => item.status !== 'error')
          if (reusable && !regenerate) return

          const variant = current?.key === key && regenerate ? current.variant + 1 : 0
          const loading: AiEntry<string> = { key, status: 'loading' }
          set((s) => ({
            drafts: { ...s.drafts, [threadId]: { key, variant, items: { short: loading, friendly: loading, professional: loading } } },
          }))

          const settle = (tone: Tone, entry: AiEntry<string>) =>
            set((s) => {
              const drafts = s.drafts[threadId]
              if (!drafts || drafts.key !== key || drafts.variant !== variant) return {}
              return { drafts: { ...s.drafts, [threadId]: { ...drafts, items: { ...drafts.items, [tone]: entry } } } }
            })

          for (const tone of TONES) {
            draftReply(thread, tone, variant)
              .then(({ text }) => settle(tone, { key, status: 'ready', result: text }))
              .catch(() => settle(tone, { key, status: 'error' }))
          }
        },

        forgetThread(threadId) {
          const without = <T>(record: Record<string, T>) => {
            const next = { ...record }
            delete next[threadId]
            return next
          }
          set((s) => ({
            priority: without(s.priority),
            summary: without(s.summary),
            tasks: without(s.tasks),
            drafts: without(s.drafts),
          }))
        },

        forgetAll: () => set({ priority: {}, summary: {}, tasks: {}, drafts: {} }),
      }
    },
    {
      name: 'tidings.ai',
      version: 1,
      // Only finished results are worth keeping across reloads; drafts are always fresh.
      partialize: (s) => ({ priority: onlyReady(s.priority), summary: onlyReady(s.summary), tasks: onlyReady(s.tasks) }),
    },
  ),
)

function onlyReady<T>(entries: Record<string, AiEntry<T>>): Record<string, AiEntry<T>> {
  return Object.fromEntries(Object.entries(entries).filter(([, e]) => e.status === 'ready'))
}
