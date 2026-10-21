import { AlarmClock, AlarmClockOff, ArrowLeft, Check, Sparkles, Undo2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { NetworkDot } from '@/components/ui/NetworkDot'
import { Menu } from '@/components/ui/Popover'
import { useBreakpoint } from '@/lib/media'
import { NETWORKS } from '@/lib/networks'
import { snoozeOptions } from '@/lib/schedule'
import { formatShortWhen, toMs } from '@/lib/time'
import { markDone, reopenThread, snoozeThread, toggleAiPanel, unsnoozeThread } from '@/store/actions'
import { useClock } from '@/store/clock'
import { useInbox } from '@/store/inbox'
import { useUi } from '@/store/ui'

export function ConversationHeader({ threadId }: { threadId: string }) {
  const { thread, contacts, lastAt } = useInbox(
    useShallow((s) => {
      const messages = s.messages[threadId]
      const last = messages?.[messages.length - 1]
      return { thread: s.threads[threadId], contacts: s.contacts, lastAt: last ? toMs(last.sentAt) : 0 }
    }),
  )
  const { aiPanelOpen, aiSheetOpen } = useUi(useShallow((s) => ({ aiPanelOpen: s.aiPanelOpen, aiSheetOpen: s.aiSheetOpen })))
  const wide = useBreakpoint('wide')
  const now = useClock((s) => s.now)
  if (!thread) return null

  const isGroup = thread.kind === 'group'
  const people = thread.participantIds.map((id) => contacts[id]).filter(Boolean)
  const person = isGroup ? undefined : people[0]
  const done = !!thread.doneAt && toMs(thread.doneAt) >= lastAt
  const snoozed = !!thread.snoozedUntil && toMs(thread.snoozedUntil) > now
  const aiOpen = wide ? aiPanelOpen : aiSheetOpen
  const subtitle = [
    NETWORKS[thread.network].name,
    isGroup ? `${people.length + 1} members` : person?.handle,
    person?.org && person.org !== thread.title ? person.org : person?.label,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line px-2 sm:px-4">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        aria-label="Back to chats"
        onClick={() => useUi.getState().closeMobileThread()}
      >
        <ArrowLeft className="size-5" />
      </Button>
      <Avatar name={thread.title} seed={thread.id} group={isGroup} network={thread.network} />
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[15px] leading-tight font-semibold">{thread.title}</h2>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <NetworkDot network={thread.network} />
          <span className="truncate">{subtitle}</span>
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {done ? (
          <Button size="sm" onClick={() => reopenThread(threadId)} title="Put back in the queue">
            <Undo2 className="size-3.5" aria-hidden /> <span className="hidden sm:inline">Reopen</span>
          </Button>
        ) : (
          <Button size="sm" onClick={() => markDone(threadId)} title="Mark done (E)">
            <Check className="size-3.5" aria-hidden /> <span className="hidden sm:inline">Done</span>
            <Kbd className="hidden lg:inline-flex">E</Kbd>
          </Button>
        )}
        <SnoozeMenu threadId={threadId} snoozed={snoozed} />
        <Button
          variant={aiOpen ? 'soft' : 'ghost'}
          size="icon-sm"
          aria-pressed={aiOpen}
          aria-label="AI assist (A)"
          title="AI assist (A)"
          onClick={toggleAiPanel}
        >
          <Sparkles className="size-4" />
        </Button>
      </div>
    </header>
  )
}

function SnoozeMenu({ threadId, snoozed }: { threadId: string; snoozed: boolean }) {
  const open = useUi((s) => s.snoozeMenuOpen)
  const setOpen = useUi((s) => s.setSnoozeMenuOpen)
  const now = useClock((s) => s.now)
  const items = snoozeOptions(now).map((o) => ({
    id: o.id,
    label: o.label,
    hint: formatShortWhen(o.at.getTime(), now),
    icon: AlarmClock,
    onSelect: () => void snoozeThread(threadId, o.at),
  }))
  if (snoozed) items.unshift({ id: 'unsnooze', label: 'Unsnooze', hint: '', icon: AlarmClockOff, onSelect: () => void unsnoozeThread(threadId) })

  return (
    <Menu
      title="Snooze until"
      panelClassName="min-w-64"
      open={open}
      onOpenChange={setOpen}
      items={items}
      renderTrigger={(props) => (
        <Button {...props} variant={snoozed ? 'soft' : 'ghost'} size="icon-sm" aria-label="Snooze (S)" title="Snooze (S)">
          <AlarmClock className="size-4" />
        </Button>
      )}
    />
  )
}
