import { useEffect, useMemo } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CalendarDays, Check, ListTodo, Plus, Sparkles, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { ExtractedTask } from '@/ai'
import { EmptyState } from '@/components/threads/EmptyStates'
import { Button } from '@/components/ui/Button'
import { NetworkIcon } from '@/components/ui/NetworkIcon'
import { Panel } from '@/components/ui/Panel'
import { SkeletonLines } from '@/components/ui/Skeleton'
import type { NetworkId, Task, Thread } from '@/data/types'
import { cn } from '@/lib/cn'
import { DAY, formatWhen, startOfDay, toMs } from '@/lib/time'
import { addExtractedTask, openThread, turnOnAi } from '@/store/actions'
import { useAi } from '@/store/ai'
import { useClock } from '@/store/clock'
import { useInbox } from '@/store/inbox'
import { useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'

interface Suggestion {
  threadId: string
  task: ExtractedTask
}

const byDue = (a: string | null, b: string | null) => (a ? toMs(a) : Infinity) - (b ? toMs(b) : Infinity)

function inNetworks(threadId: string | undefined, threads: Record<string, Thread>, networks: NetworkId[]) {
  if (!networks.length) return true
  const thread = threadId ? threads[threadId] : undefined
  return !!thread && networks.includes(thread.network)
}

export function TasksView() {
  const { tasks, threads } = useInbox(useShallow((s) => ({ tasks: s.tasks, threads: s.threads })))
  const { aiEnabled, aiThreadIds } = useSettings(useShallow((s) => ({ aiEnabled: s.aiEnabled, aiThreadIds: s.aiThreadIds })))
  const extracted = useAi((s) => s.tasks)
  const networks = useUi((s) => s.networks)
  const now = useClock((s) => s.now)

  // Look for tasks in every chat AI is allowed to read.
  useEffect(() => {
    if (!aiEnabled) return
    for (const id of aiThreadIds) if (threads[id]) useAi.getState().ensureTasks(id)
  }, [aiEnabled, aiThreadIds, threads])

  const { groups, done } = useMemo(() => {
    const visible = tasks.filter((t) => inNetworks(t.source?.threadId, threads, networks))
    const open = visible.filter((t) => !t.done).sort((a, b) => byDue(a.dueAt, b.dueAt))
    const today = startOfDay(now)
    return {
      groups: [
        { id: 'overdue', label: 'Overdue', items: open.filter((t) => t.dueAt && toMs(t.dueAt) < today) },
        { id: 'today', label: 'Today', items: open.filter((t) => t.dueAt && toMs(t.dueAt) >= today && toMs(t.dueAt) < today + DAY) },
        { id: 'upcoming', label: 'Upcoming', items: open.filter((t) => t.dueAt && toMs(t.dueAt) >= today + DAY) },
        { id: 'someday', label: 'No date', items: open.filter((t) => !t.dueAt) },
      ].filter((g) => g.items.length),
      done: visible.filter((t) => t.done),
    }
  }, [tasks, threads, networks, now])

  const suggestions = useMemo(() => {
    if (!aiEnabled) return []
    const list: Suggestion[] = []
    for (const threadId of aiThreadIds) {
      if (!threads[threadId] || !inNetworks(threadId, threads, networks)) continue
      for (const task of extracted[threadId]?.result ?? []) {
        const added = tasks.some((t) => t.source?.messageId === task.sourceMessageId && t.title === task.title)
        const stale = task.dueAt && toMs(task.dueAt) < now - DAY
        if (!added && !stale) list.push({ threadId, task })
      }
    }
    return list.sort((a, b) => byDue(a.task.dueAt, b.task.dueAt))
  }, [aiEnabled, aiThreadIds, extracted, tasks, networks, threads, now])

  const scanning = aiEnabled && aiThreadIds.some((id) => extracted[id]?.status === 'loading' && !extracted[id]?.result)
  const ids = useMemo(() => [...new Set(tasks.flatMap((t) => (t.source ? [t.source.threadId] : [])))], [tasks])
  useEffect(() => useUi.getState().setNavThreadIds(ids), [ids])

  const openCount = groups.reduce((n, g) => n + g.items.length, 0)

  return (
    <Panel aria-label="Tasks">
      <header className="border-b border-line px-4 pt-4 pb-3">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-base font-semibold tracking-tight">
            Tasks <span className="ml-1.5 text-sm font-normal text-faint tabular-nums">{openCount}</span>
          </h1>
          <p className="text-xs text-faint">Things your chats asked of you</p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {openCount === 0 && done.length === 0 && (
          <EmptyState icon={<ListTodo className="size-6" />} title="No tasks yet">
            Open a chat and use <span className="font-medium text-fg">Add to tasks</span> on anything AI finds, like
            “Send invoice by Friday”.
          </EmptyState>
        )}

        {groups.map((g) => (
          <section key={g.id} className="mb-3">
            <h2
              className={cn(
                'px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wider uppercase',
                g.id === 'overdue' ? 'text-rose-600 dark:text-rose-400' : 'text-faint',
              )}
            >
              {g.label}
            </h2>
            <ul>
              <AnimatePresence initial={false}>
                {g.items.map((t) => (
                  <TaskRow key={t.id} task={t} thread={t.source ? threads[t.source.threadId] : undefined} now={now} />
                ))}
              </AnimatePresence>
            </ul>
          </section>
        ))}

        <section className="mt-2 rounded-xl bg-surface-2/60 p-2">
          <h2 className="flex items-center gap-1.5 px-2 pt-1 pb-2 text-[11px] font-semibold tracking-wider text-accent-ink uppercase">
            <Sparkles className="size-3.5" aria-hidden /> Found in your chats
          </h2>
          {!aiEnabled ? (
            <div className="px-2 pb-2">
              <p className="text-[13px] leading-relaxed text-muted">
                Turn on AI to pull to-dos and dates out of your chats automatically.
              </p>
              <Button variant="primary" size="sm" className="mt-2.5" onClick={() => turnOnAi()}>
                Turn on AI
              </Button>
            </div>
          ) : suggestions.length === 0 ? (
            scanning ? (
              <SkeletonLines lines={3} className="px-2 pb-2" />
            ) : (
              <p className="px-2 pb-2 text-[13px] text-muted">Nothing new — you've added everything AI found.</p>
            )
          ) : (
            <ul className="space-y-1.5">
              <AnimatePresence initial={false}>
                {suggestions.map(({ threadId, task }) => (
                  <motion.li
                    key={`${threadId}:${task.id}`}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, height: 0, marginTop: 0 }}
                    className="flex items-start gap-3 rounded-xl border border-line bg-surface px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-snug">{task.title}</p>
                      <TaskMeta dueAt={task.dueAt} thread={threads[threadId]} messageId={task.sourceMessageId} now={now} />
                    </div>
                    <Button size="sm" onClick={() => void addExtractedTask(threadId, task)}>
                      <Plus className="size-3.5" aria-hidden /> Add
                    </Button>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </section>

        {done.length > 0 && (
          <details className="group mt-3">
            <summary className="cursor-pointer list-none px-3 py-2 text-[11px] font-semibold tracking-wider text-faint uppercase select-none hover:text-muted">
              Completed · {done.length}
            </summary>
            <ul>
              {done.map((t) => (
                <TaskRow key={t.id} task={t} thread={t.source ? threads[t.source.threadId] : undefined} now={now} />
              ))}
            </ul>
          </details>
        )}
      </div>
    </Panel>
  )
}

function TaskRow({ task, thread, now }: { task: Task; thread: Thread | undefined; now: number }) {
  const { setTaskDone, deleteTask } = useInbox.getState()
  return (
    <motion.li
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, height: 0 }}
      className="group flex items-start gap-3 rounded-xl px-3 py-2.5 hover:bg-surface-2"
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={task.done}
        aria-label={task.done ? 'Mark as not done' : 'Mark as done'}
        onClick={() => void setTaskDone(task.id, !task.done)}
        className={cn(
          'mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-full border-2 transition-colors',
          task.done ? 'border-accent bg-accent' : 'border-line-strong hover:border-accent',
        )}
      >
        {task.done && <Check className="size-3 text-accent-fg" strokeWidth={3} aria-hidden />}
      </button>
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm leading-snug', task.done && 'text-faint line-through')}>{task.title}</p>
        <TaskMeta dueAt={task.dueAt} thread={thread} messageId={task.source?.messageId} now={now} />
      </div>
      <button
        type="button"
        aria-label="Delete task"
        onClick={() => void deleteTask(task.id)}
        className="rounded-md p-1 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-rose-600 focus-visible:opacity-100"
      >
        <Trash2 className="size-4" />
      </button>
    </motion.li>
  )
}

function TaskMeta({
  dueAt,
  thread,
  messageId,
  now,
}: {
  dueAt: string | null
  thread: Thread | undefined
  messageId?: string
  now: number
}) {
  const overdue = !!dueAt && toMs(dueAt) < startOfDay(now)
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      {dueAt && (
        <span className={cn('inline-flex items-center gap-1', overdue && 'text-rose-600 dark:text-rose-400')}>
          <CalendarDays className="size-3.5" aria-hidden /> {formatWhen(dueAt, now)}
        </span>
      )}
      {thread && (
        <button
          type="button"
          onClick={() => openThread(thread.id, messageId)}
          className="inline-flex min-w-0 items-center gap-1.5 hover:text-fg"
          title="Open the message"
        >
          <NetworkIcon network={thread.network} />
          <span className="truncate">{thread.title}</span>
        </button>
      )}
    </div>
  )
}
