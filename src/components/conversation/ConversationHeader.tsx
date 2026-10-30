import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Check,
  CheckCheck,
  Eraser,
  MoreVertical,
  Search,
  Sparkles,
  Tag as TagIcon,
  Undo2,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Avatar } from '@/components/ui/Avatar'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { NetworkIcon } from '@/components/ui/NetworkIcon'
import { Menu, type MenuItem } from '@/components/ui/Popover'
import { CHAT_LABELS, type ChatLabel } from '@/data/types'
import { LABELS, whyOf } from '@/lib/chatLabels'
import { typingLabel } from '@/lib/format'
import { useBreakpoint } from '@/lib/media'
import { NETWORKS } from '@/lib/networks'
import { snoozeOptions } from '@/lib/schedule'
import { formatShortWhen, toMs } from '@/lib/time'
import {
  archiveThread,
  clearThreadLabels,
  markDone,
  reopenThread,
  sendReadReceipt,
  setThreadLabelsLocked,
  snoozeThread,
  toggleAiPanel,
  toggleThreadLabel,
  unsnoozeThread,
} from '@/store/actions'
import { useClock } from '@/store/clock'
import { useInbox } from '@/store/inbox'
import { useThreadView } from '@/store/selectors'
import { useIncognito } from '@/store/privacy'
import { useUi } from '@/store/ui'

export function ConversationHeader({ threadId }: { threadId: string }) {
  const { thread, contacts, lastAt, typing } = useInbox(
    useShallow((s) => {
      const messages = s.messages[threadId]
      const last = messages?.[messages.length - 1]
      return { thread: s.threads[threadId], contacts: s.contacts, lastAt: last ? toMs(last.sentAt) : 0, typing: s.typing[threadId] }
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
      <Avatar
        name={thread.title}
        seed={thread.id}
        group={isGroup}
        network={thread.network}
        imageUrl={isGroup ? thread.avatarUrl : person?.avatarUrl}
      />
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[15px] leading-tight font-semibold">{thread.title}</h2>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <NetworkIcon network={thread.network} />
          {typing?.length ? (
            <span className="truncate font-medium text-accent-ink" aria-live="polite">
              {typingLabel(typing.map((id) => contacts[id]?.name ?? 'Someone'), isGroup)}
            </span>
          ) : (
            <span className="truncate">{subtitle}</span>
          )}
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
        <ChatSearchButton threadId={threadId} />
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
        <TagMenu threadId={threadId} own={thread.labels ?? []} locked={!!thread.labelsLocked} />
        <ChatMenu threadId={threadId} archived={!!thread.archived} />
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

/** Tags put on the chat by hand, from the same set the AI uses. */
/**
 * The chat's tags. Ticks are the user's own; a tag the AI gave says so and why, and ticking it
 * keeps it as the user's own.
 */
function TagMenu({ threadId, own, locked }: { threadId: string; own: ChatLabel[]; locked: boolean }) {
  const view = useThreadView(threadId)
  const labels = view?.labels ?? own
  const sources = view?.labelSources ?? {}
  const items: MenuItem[] = [
    ...CHAT_LABELS.map((label) => {
      const hint = labels.includes(label) ? whyOf(sources[label]) : undefined
      return {
        id: label,
        label: LABELS[label].label,
        icon: LABELS[label].icon,
        checked: own.includes(label),
        ...(hint ? { hint } : {}),
        onSelect: () => void toggleThreadLabel(threadId, label),
      }
    }),
    {
      id: 'ai-tags',
      label: 'Let AI tag this chat',
      icon: Sparkles,
      checked: !locked,
      onSelect: () => void setThreadLabelsLocked(threadId, !locked),
    },
    ...(labels.length ? [{ id: 'clear', label: 'Clear all tags', icon: Eraser, onSelect: () => void clearThreadLabels(threadId) }] : []),
  ]
  return (
    <Menu
      title="Tags"
      items={items}
      side="auto"
      panelClassName="min-w-52"
      renderTrigger={(props) => (
        // A small chip on every screen: the tag icon, and how many tags the chat has.
        <Button
          {...props}
          variant={labels.length ? 'soft' : 'ghost'}
          size="icon-sm"
          className={cn(labels.length > 0 && 'w-auto gap-1 px-2')}
          aria-label={labels.length ? `Tags: ${labels.map((l) => LABELS[l].label).join(', ')}` : 'Tag this chat'}
          title="Tag this chat"
        >
          <TagIcon className="size-4" />
          {labels.length > 0 && <span className="text-xs tabular-nums">{labels.length}</span>}
        </Button>
      )}
    />
  )
}

/** What else can be done with the chat. */
function ChatMenu({ threadId, archived }: { threadId: string; archived: boolean }) {
  const incognito = useIncognito()
  const searching = useUi((s) => s.chatSearch?.threadId === threadId)
  const items: MenuItem[] = [
    // Also a button in the header, except on phones, where there's no room for it.
    {
      id: 'search',
      label: searching ? 'Close search' : 'Search in this chat',
      icon: Search,
      onSelect: () => useUi.getState().setChatSearch(searching ? null : { threadId, query: '', current: null }),
    },
    archived
      ? { id: 'unarchive', label: 'Unarchive chat', icon: ArchiveRestore, onSelect: () => void archiveThread(threadId, false) }
      : { id: 'archive', label: 'Archive chat', icon: Archive, onSelect: () => void archiveThread(threadId, true) },
  ]
  // Incognito mode reads without telling them; this tells them, for this chat, once.
  if (incognito) items.push({ id: 'read-receipt', label: 'Mark as read for them', icon: CheckCheck, onSelect: () => void sendReadReceipt(threadId) })
  return (
    <Menu
      items={items}
      panelClassName="min-w-56"
      renderTrigger={(props) => (
        <Button {...props} variant="ghost" size="icon-sm" aria-label="More for this chat" title="More">
          <MoreVertical className="size-4" />
        </Button>
      )}
    />
  )
}

/** Opens (or closes) the search inside this chat. */
function ChatSearchButton({ threadId }: { threadId: string }) {
  const searching = useUi((s) => s.chatSearch?.threadId === threadId)
  return (
    <Button
      variant={searching ? 'soft' : 'ghost'}
      size="icon-sm"
      className="max-sm:hidden"
      aria-pressed={searching}
      aria-label="Search in this chat"
      title="Search in this chat"
      onClick={() => useUi.getState().setChatSearch(searching ? null : { threadId, query: '', current: null })}
    >
      <Search className="size-4" />
    </Button>
  )
}
