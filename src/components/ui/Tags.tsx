import { AlarmClock, CalendarClock, Clock } from 'lucide-react'
import type { ChatLabel, Priority } from '@/ai'
import { LABELS } from '@/lib/chatLabels'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/time'
import { whyOf } from '@/lib/chatLabels'
import type { LabelSource } from '@/store/selectors'

const PRIORITY: Record<Priority, { label: string; className: string; dot: string }> = {
  urgent: {
    label: 'Urgent',
    className: 'bg-rose-500/10 text-rose-700 ring-rose-500/25 dark:text-rose-300',
    dot: 'bg-rose-500',
  },
  normal: { label: 'Normal', className: 'bg-surface-2 text-muted ring-line', dot: 'bg-zinc-400 dark:bg-zinc-500' },
  low: { label: 'Low', className: 'text-faint ring-line', dot: 'bg-zinc-300 dark:bg-zinc-600' },
}

const PILL = 'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium ring-1 ring-inset'

export function PriorityTag({ priority, reason }: { priority: Priority; reason?: string }) {
  const style = PRIORITY[priority]
  return (
    <span className={cn(PILL, style.className)} title={reason ? `AI priority: ${reason}` : 'AI priority'}>
      <span className={cn('size-1.5 rounded-full', style.dot)} />
      {style.label}
    </span>
  )
}

/** One of a chat's tags. Those that need something from you stand out. */
export function LabelTag({ label, source }: { label: ChatLabel; source?: LabelSource }) {
  const { label: text, icon: Icon, hint } = LABELS[label]
  const asks = label === 'follow-up' || label === 'deadline'
  return (
    <span
      className={cn(PILL, asks ? 'bg-violet-500/10 text-violet-700 ring-violet-500/20 dark:text-violet-300' : 'bg-surface-2/70 text-muted ring-line')}
      title={`${text}: ${whyOf(source) ?? hint}`}
    >
      <Icon className="size-3" aria-hidden />
      {text}
    </span>
  )
}

export function PriorityTagSkeleton() {
  return <span aria-label="Classifying" className="skeleton inline-block h-5 w-14 rounded-full" />
}

export function UnansweredBadge({ waitingMs }: { waitingMs: number }) {
  return (
    <span
      className={cn(PILL, 'bg-amber-500/10 text-amber-800 ring-amber-500/25 dark:text-amber-300')}
      title="Time since they first asked and you haven't replied"
    >
      <Clock className="size-3" aria-hidden />
      Unanswered for {formatDuration(waitingMs)}
    </span>
  )
}

export function ScheduledBadge({ label }: { label: string }) {
  return (
    <span className={cn(PILL, 'bg-accent-soft text-accent-ink ring-accent/20')}>
      <CalendarClock className="size-3" aria-hidden />
      {label}
    </span>
  )
}

export function SnoozedBadge({ label }: { label: string }) {
  return (
    <span className={cn(PILL, 'bg-surface-2 text-muted ring-line')}>
      <AlarmClock className="size-3" aria-hidden />
      {label}
    </span>
  )
}
