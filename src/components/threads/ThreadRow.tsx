import { memo, useEffect, useRef } from 'react'
import { motion } from 'motion/react'
import type { Contact } from '@/data/types'
import { Avatar } from '@/components/ui/Avatar'
import { LabelTag, PriorityTag, PriorityTagSkeleton, ScheduledBadge, SnoozedBadge, UnansweredBadge } from '@/components/ui/Tags'
import { UNANSWERED_BADGE_AFTER } from '@/config'
import { cn } from '@/lib/cn'
import { messagePreview, typingLabel } from '@/lib/format'
import { formatAgo, formatDuration, formatWhen } from '@/lib/time'
import { useInbox } from '@/store/inbox'
import { threadPicture, type ThreadView } from '@/store/selectors'
import { useUi } from '@/store/ui'

interface ThreadRowProps {
  view: ThreadView
  selected: boolean
  now: number
  contacts: Record<string, Contact>
  showWaitingOnThem?: boolean
}

export const ThreadRow = memo(function ThreadRow({ view, selected, now, contacts, showWaitingOnThem }: ThreadRowProps) {
  const draft = useUi((s) => s.composer[view.id])
  const typing = useInbox((s) => s.typing[view.id])
  const ref = useRef<HTMLButtonElement>(null)

  // Keep the selected row visible while moving with J/K.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  const { thread } = view
  const isGroup = thread.kind === 'group'
  const unread = thread.unreadCount
  const waitingMs = view.waitingSince ? now - view.waitingSince : 0

  const { priority, stalePriority } = view
  const tags = [
    // Done: Urgent no longer applies (Normal and Low stay); it comes back with a new message.
    view.aiAllowed &&
      !(view.done && (priority ?? stalePriority)?.priority === 'urgent') &&
      (priority ? (
        <PriorityTag key="p" priority={priority.priority} reason={priority.reason} />
      ) : stalePriority ? (
        <span key="p" className={cn(view.priorityLoading && 'animate-pulse opacity-60')}>
          <PriorityTag priority={stalePriority.priority} />
        </span>
      ) : (
        view.priorityLoading && <PriorityTagSkeleton key="p" />
      )),
    // Two tags at most in the list; the AI panel shows them all.
    ...view.labels.slice(0, 2).map((label) => <LabelTag key={`l-${label}`} label={label} />),
    view.needsReply && waitingMs >= UNANSWERED_BADGE_AFTER && <UnansweredBadge key="u" waitingMs={waitingMs} />,
    showWaitingOnThem && view.waitingOnThem && (
      <span key="w" className="text-[11px] text-muted">
        You asked {formatDuration(now - view.lastAt)} ago
      </span>
    ),
    view.scheduledCount > 0 && <ScheduledBadge key="s" label="Reply scheduled" />,
    view.snoozed && thread.snoozedUntil && (
      <SnoozedBadge key="z" label={`Snoozed until ${formatWhen(thread.snoozedUntil, now)}`} />
    ),
  ].filter(Boolean)

  return (
    <button
      ref={ref}
      type="button"
      data-thread-row={view.id}
      onClick={() => useUi.getState().selectThread(view.id)}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'group relative isolate flex w-full items-start gap-3 rounded-2xl px-3 py-3 text-left transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring',
        !selected && 'hover:bg-surface-2',
      )}
    >
      {/* One highlight for the whole list: it glides to the newly selected row. */}
      {selected && (
        <motion.span
          layoutId="thread-row-highlight"
          aria-hidden
          className="absolute inset-0 -z-10 rounded-2xl bg-pill-accent shadow-pill"
          transition={{ type: 'spring', stiffness: 560, damping: 42 }}
        />
      )}
      <Avatar
        name={thread.title}
        seed={thread.id}
        group={isGroup}
        network={thread.network}
        imageUrl={threadPicture(thread, contacts)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn('truncate text-sm text-fg', unread ? 'font-semibold' : 'font-medium')}>
            {thread.title}
          </span>
          <span className="ml-auto shrink-0 text-xs text-faint tabular-nums">
            {view.lastMessage ? formatAgo(view.lastMessage.sentAt, now) : ''}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <p className={cn('min-w-0 flex-1 truncate text-[13px]', unread ? 'text-fg' : 'text-muted')}>
            {typing?.length ? (
              <span className="font-medium text-accent-ink">
                {typingLabel(typing.map((id) => contacts[id]?.name ?? 'Someone'), isGroup)}
              </span>
            ) : draft ? (
              <>
                <span className="font-medium text-accent-ink">Draft:</span> {draft}
              </>
            ) : (
              messagePreview(view.lastMessage, contacts, isGroup)
            )}
          </p>
          {unread > 0 && (
            <span
              aria-label={`${unread} unread`}
              className="grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-fg tabular-nums"
            >
              {unread}
            </span>
          )}
        </div>
        {tags.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-1.5">{tags}</div>}
      </div>
    </button>
  )
})
