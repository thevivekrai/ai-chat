import type { ReactNode } from 'react'
import { CalendarDays, Check, CornerDownRight, Lock, Plus, ShieldCheck, Sparkles, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { ExtractedTask } from '@/ai'
import { AiFailed } from '@/components/ui/AiFailed'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { SkeletonLines } from '@/components/ui/Skeleton'
import { Switch } from '@/components/ui/Switch'
import { PriorityTag } from '@/components/ui/Tags'
import { cn } from '@/lib/cn'
import { NETWORKS } from '@/lib/networks'
import { formatDurationLong, formatWhen } from '@/lib/time'
import { addExtractedTask, openThread, setThreadAiAccess, toggleDrafts } from '@/store/actions'
import { useAi } from '@/store/ai'
import { useClock } from '@/store/clock'
import { settledLastMessageId, useInbox } from '@/store/inbox'
import { useThreadViews } from '@/store/selectors'
import { canAiReadThread, usesClaude, useSettings } from '@/store/settings'

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-wider text-faint uppercase">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

export function AiPanel({ threadId, onClose, className }: { threadId: string; onClose(): void; className?: string }) {
  const allowed = useSettings((s) => canAiReadThread(s, threadId))
  const claude = useSettings(usesClaude)
  const { thread, contacts } = useInbox(useShallow((s) => ({ thread: s.threads[threadId], contacts: s.contacts })))
  if (!thread) return null
  const people = thread.participantIds.map((id) => contacts[id]).filter(Boolean)

  return (
    <div className={cn('flex h-full flex-col', className)}>
      <div className="flex h-16 shrink-0 items-center gap-2 border-b border-line px-4">
        <Sparkles className="size-4 text-accent-ink" aria-hidden />
        <h2 className="text-sm font-semibold">AI assist</h2>
        <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close AI panel" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        <div className="rounded-xl border border-line bg-surface-2/60 p-3">
          <div className="flex items-center gap-3">
            <ShieldCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <p className="flex-1 text-[13px] font-medium">AI can read this chat</p>
            <Switch
              checked={allowed}
              onChange={(on) => setThreadAiAccess(threadId, on)}
              label="Allow AI to read this chat"
            />
          </div>
          <p className="mt-1.5 pl-7 text-xs leading-relaxed text-muted">
            {allowed
              ? claude
                ? 'This chat is sent to Claude when a feature needs it. Results stay on this device.'
                : 'Only this chat is read, and results stay on this device.'
              : 'Turn on to get a priority, summary, tasks and drafts for this chat.'}
          </p>
        </div>

        {allowed ? (
          <>
            <PrioritySection threadId={threadId} />
            <SummarySection threadId={threadId} />
            <TasksSection threadId={threadId} />
            <Button variant="soft" className="w-full" onClick={() => toggleDrafts(threadId)}>
              <Sparkles className="size-4" aria-hidden /> Draft replies <Kbd className="ml-1 bg-surface/60">R</Kbd>
            </Button>
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-line-strong p-4 text-center">
            <Lock className="mx-auto size-5 text-faint" aria-hidden />
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              AI features are off for this chat. Your messages aren't read until you allow it.
            </p>
          </div>
        )}

        <Section title={thread.kind === 'group' ? `Members · ${people.length + 1}` : 'Contact'}>
          <ul className="space-y-2.5">
            {people.map((p) => (
              <li key={p.id} className="flex items-center gap-2.5">
                <Avatar name={p.name} seed={p.id} size="sm" />
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">{p.name}</p>
                  <p className="truncate text-xs text-muted">
                    {NETWORKS[p.network].name} · {p.handle}
                    {p.label ? ` · ${p.label}` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  )
}

function PrioritySection({ threadId }: { threadId: string }) {
  const entry = useAi((s) => s.priority[threadId])
  const view = useThreadViews().find((v) => v.id === threadId)
  const now = useClock((s) => s.now)
  const result = entry?.result
  const waiting = view?.needsReply && view.waitingSince ? now - view.waitingSince : 0

  return (
    <Section title="Priority">
      {entry?.status === 'error' && (
        <AiFailed message={entry.error} onRetry={() => useAi.getState().ensurePriority(threadId)} className="mb-2" />
      )}
      {!result ? (
        entry?.status !== 'error' && <SkeletonLines lines={2} />
      ) : (
        <div className={cn('rounded-xl border border-line p-3', entry.status === 'loading' && 'opacity-60')}>
          <div className="flex flex-wrap items-center gap-2">
            <PriorityTag priority={result.priority} />
            <span className="text-xs text-muted">
              {result.expectsReply
                ? waiting
                  ? `Waiting ${formatDurationLong(waiting)}`
                  : 'Needs your reply'
                : 'No reply needed'}
            </span>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed">{result.reason}</p>
        </div>
      )}
    </Section>
  )
}

function SummarySection({ threadId }: { threadId: string }) {
  const entry = useAi((s) => s.summary[threadId])
  const summary = entry?.result
  return (
    <Section title="Summary">
      {entry?.status === 'error' && (
        <AiFailed message={entry.error} onRetry={() => useAi.getState().ensureSummary(threadId)} className="mb-2" />
      )}
      {!summary ? (
        entry?.status !== 'error' && <SkeletonLines lines={3} />
      ) : (
        <div className={cn('space-y-2', entry.status === 'loading' && 'opacity-60')}>
          <p className="text-[13px] leading-relaxed">{summary.oneLine}</p>
          {summary.bullets.length > 0 && (
            <details className="group text-[13px]">
              <summary className="cursor-pointer list-none text-xs font-medium text-accent-ink select-none hover:underline">
                <span className="group-open:hidden">Show key points ({summary.bullets.length})</span>
                <span className="hidden group-open:inline">Hide key points</span>
              </summary>
              <ul className="mt-2 space-y-1.5 text-muted">
                {summary.bullets.map((b) => (
                  <li key={b} className="flex gap-2">
                    <span className="mt-[9px] size-1 shrink-0 rounded-full bg-accent" aria-hidden />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Section>
  )
}

function TasksSection({ threadId }: { threadId: string }) {
  const entry = useAi((s) => s.tasks[threadId])
  const added = useInbox((s) => s.tasks)
  const fresh = useInbox((s) => entry?.key === settledLastMessageId(s.messages[threadId]))
  const now = useClock((s) => s.now)
  const tasks = entry?.result

  const isAdded = (t: ExtractedTask) =>
    added.some((a) => a.source?.messageId === t.sourceMessageId && a.title === t.title)

  return (
    <Section title="Detected tasks" aside={tasks && <span className="text-xs text-faint">{tasks.length}</span>}>
      {entry?.status === 'error' && (
        <AiFailed message={entry.error} onRetry={() => useAi.getState().ensureTasks(threadId)} className="mb-2" />
      )}
      {!tasks ? (
        entry?.status !== 'error' && <SkeletonLines lines={2} />
      ) : tasks.length === 0 ? (
        <p className="text-[13px] text-muted">No tasks or dates in this chat.</p>
      ) : (
        <ul className={cn('space-y-2', !fresh && 'opacity-60')}>
          {tasks.map((t) => {
            const done = isAdded(t)
            return (
              <li key={t.id} className="rounded-xl border border-line p-3">
                <p className="text-[13px] leading-snug font-medium">{t.title}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  {t.dueAt && (
                    <span className="inline-flex items-center gap-1">
                      <CalendarDays className="size-3.5" aria-hidden />
                      {formatWhen(t.dueAt, now)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => openThread(threadId, t.sourceMessageId)}
                    className="inline-flex items-center gap-1 hover:text-fg"
                  >
                    <CornerDownRight className="size-3.5" aria-hidden /> View message
                  </button>
                </div>
                <Button
                  size="sm"
                  variant={done ? 'ghost' : 'secondary'}
                  disabled={done}
                  className="mt-2.5 w-full"
                  onClick={() => void addExtractedTask(threadId, t)}
                >
                  {done ? (
                    <>
                      <Check className="size-3.5" aria-hidden /> Added to tasks
                    </>
                  ) : (
                    <>
                      <Plus className="size-3.5" aria-hidden /> Add to tasks
                    </>
                  )}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}
