import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  AiAccessError,
  LlmError,
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
import { toast } from './toasts'

/**
 * The least time between two tagging runs for the same chat. A burst of messages would otherwise
 * be a burst of AI calls; the last of them is the one that matters, and it is run when the gap is up.
 */
export const TAGGING_GAP_MS = 20_000

/**
 * Results of AI calls, with loading state. Each result is keyed by the thread's latest settled
 * message, so a new message makes it stale and it is recomputed on next use.
 */
export interface AiEntry<T> {
  key: string
  status: 'loading' | 'ready' | 'error'
  result?: T
  /** Why it failed, in words for the user. */
  error?: string
}

/** A problem with the AI setup itself (bad key, unavailable model) rather than one chat. */
export interface AiProblem {
  kind: 'auth' | 'permission' | 'model'
  message: string
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
  problem: AiProblem | null
  ensurePriority(threadId: string): void
  ensureSummary(threadId: string): void
  ensureTasks(threadId: string): void
  /** Starts (or restarts, with a new wording) the three tone drafts for a thread. */
  requestDrafts(threadId: string, options?: { regenerate?: boolean }): void
  forgetThread(threadId: string): void
  forgetAll(): void
  clearProblem(): void
}

/** User-facing reason for a failed AI call. */
export function describeAiError(error: unknown): string {
  return error instanceof LlmError ? error.message : 'Something went wrong. Try again.'
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
      // Bumped when all results are forgotten (say, the AI changed): answers still on their way
      // from before then are dropped.
      let epoch = 0
      // After a rate limit, background sorting waits a minute instead of retrying at every change.
      let sortingPausedUntil = 0
      // A configuration problem is remembered until a call succeeds again.
      const noteSuccess = () => get().problem && set({ problem: null })
      const noteFailure = (error: unknown) => {
        if (error instanceof LlmError && error.kind === 'rate_limit') sortingPausedUntil = Date.now() + 60_000
        if (error instanceof LlmError && (error.kind === 'auth' || error.kind === 'permission' || error.kind === 'model')) {
          if (get().problem?.message !== error.message) set({ problem: { kind: error.kind, message: error.message } })
        }
      }

      // Per chat: when it was last tagged, and a run waiting for the gap to pass.
      const taggedAt = new Map<string, number>()
      const waiting = new Map<string, ReturnType<typeof setTimeout>>()
      // Chats whose failed tagging was already mentioned, so a flaky connection isn't a stream of toasts.
      const toldFailed = new Set<string>()

      function ensure<K extends Slice>(slice: K, threadId: string, run: (thread: AiThread) => Promise<ResultTypes[K]>) {
        // These run automatically; while the setup is broken (say, a rejected key) they would only fail again.
        if (get().problem) return
        if (slice === 'priority' && Date.now() < sortingPausedUntil) return
        const input = aiInputFor(threadId)
        if (!input) return
        const entries = () => get()[slice] as Entries<K>
        const current = entries()[threadId]
        if (current && current.key === input.key && current.status !== 'error') return
        if (slice === 'priority') {
          const wait = (taggedAt.get(threadId) ?? 0) + TAGGING_GAP_MS - Date.now()
          if (wait > 0) {
            if (!waiting.has(threadId)) {
              waiting.set(
                threadId,
                setTimeout(() => {
                  waiting.delete(threadId)
                  ensure(slice, threadId, run)
                }, wait),
              )
            }
            return
          }
          taggedAt.set(threadId, Date.now())
        }

        const write = (entry: AiEntry<ResultTypes[K]> | null) =>
          set(() => {
            const next = { ...entries() }
            if (entry) next[threadId] = entry
            else delete next[threadId]
            return { [slice]: next } as Partial<AiState>
          })
        const started = epoch
        const stillCurrent = () => started === epoch && entries()[threadId]?.key === input.key

        // Keep the previous result visible while recomputing, so the list doesn't jump around.
        write({ key: input.key, status: 'loading', result: current?.result })
        run(input.thread)
          .then((result) => {
            if (started !== epoch) return
            noteSuccess()
            toldFailed.delete(threadId)
            if (stillCurrent()) write({ key: input.key, status: 'ready', result })
          })
          .catch((error: unknown) => {
            if (started !== epoch) return
            noteFailure(error)
            if (!stillCurrent()) return
            if (error instanceof AiAccessError) return write(null)
            // The last good priority stays, so the queue doesn't reshuffle — but never its tags: they
            // were for an earlier state of the chat, and an old tag left in place is a wrong tag.
            const kept = slice === 'priority' && current?.result ? untagged(current.result as PriorityResult) : current?.result
            write({ key: input.key, status: 'error', result: kept as ResultTypes[K] | undefined, error: describeAiError(error) })
            if (slice === 'priority' && !toldFailed.has(threadId) && !get().problem) {
              toldFailed.add(threadId)
              const title = useInbox.getState().threads[threadId]?.title ?? 'a chat'
              toast({ title: 'Tagging skipped', description: `Couldn't tag ${title}, so it's left untagged for now.`, group: 'ai-tagging' })
            }
          })
      }

      return {
        priority: {},
        summary: {},
        tasks: {},
        drafts: {},
        problem: null,

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

          const started = epoch
          const settle = (tone: Tone, entry: AiEntry<string>) =>
            set((s) => {
              if (started !== epoch) return {}
              const drafts = s.drafts[threadId]
              if (!drafts || drafts.key !== key || drafts.variant !== variant) return {}
              return { drafts: { ...s.drafts, [threadId]: { ...drafts, items: { ...drafts.items, [tone]: entry } } } }
            })

          for (const tone of TONES) {
            draftReply(thread, tone, variant)
              .then(({ text }) => {
                if (started !== epoch) return
                noteSuccess()
                settle(tone, { key, status: 'ready', result: text })
              })
              .catch((error: unknown) => {
                if (started !== epoch) return
                noteFailure(error)
                settle(tone, { key, status: 'error', error: describeAiError(error) })
              })
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

        forgetAll: () => {
          epoch++
          for (const timer of waiting.values()) clearTimeout(timer)
          waiting.clear()
          taggedAt.clear()
          toldFailed.clear()
          set({ priority: {}, summary: {}, tasks: {}, drafts: {}, problem: null })
        },
        clearProblem: () => set({ problem: null }),
      }
    },
    {
      name: 'tidings.ai',
      version: 4,
      // Older priorities came from older rules, with tags nobody was sure of: every chat is tagged again.
      migrate: (persisted, version) => (version < 4 ? { ...(persisted as object), priority: {} } : persisted) as AiState,
      // Only finished results are worth keeping across reloads; drafts are always fresh.
      partialize: (s) => ({ priority: onlyReady(s.priority), summary: onlyReady(s.summary), tasks: onlyReady(s.tasks) }),
    },
  ),
)

/** A priority without its tags: what's left on screen when tagging the chat again failed. */
const untagged = (result: PriorityResult): PriorityResult => ({ ...result, labels: [], labelCalls: [] })

function onlyReady<T>(entries: Record<string, AiEntry<T>>): Record<string, AiEntry<T>> {
  return Object.fromEntries(Object.entries(entries).filter(([, e]) => e.status === 'ready'))
}
