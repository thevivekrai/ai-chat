import { useEffect, useMemo, useRef } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Archive, CloudOff, Hourglass, Link2, Loader2, MessagesSquare, Search, Sparkles, Tag, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { ChatLabel } from '@/ai'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Panel } from '@/components/ui/Panel'
import { useTickEffect } from '@/hooks/useTickEffect'
import { LABELS } from '@/lib/chatLabels'
import { cn } from '@/lib/cn'
import { NETWORKS } from '@/lib/networks'
import { isAtLeast } from '@/lib/media'
import { turnOnAi } from '@/store/actions'
import { useClock } from '@/store/clock'
import { hasRealAccount, useConnections } from '@/store/connections'
import { useInbox } from '@/store/inbox'
import { selectViewThreads, useThreadViews } from '@/store/selectors'
import { useSession } from '@/store/session'
import { useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import { AllCaughtUp, EmptyState, NoMatches } from './EmptyStates'
import { ThreadRow } from './ThreadRow'

type ListView = 'needs-reply' | 'all' | 'waiting' | 'archived'

const COPY: Record<ListView, { title: string; subtitle: (ai: boolean) => string }> = {
  'needs-reply': {
    title: 'Needs reply',
    subtitle: (ai) => (ai ? 'By priority, then wait time' : 'Longest wait first'),
  },
  all: { title: 'All chats', subtitle: () => 'Most recent first' },
  waiting: { title: 'Waiting on them', subtitle: () => "You asked, they haven't answered" },
  archived: { title: 'Archived', subtitle: () => 'Out of your lists until you unarchive' },
}

export function ThreadListPane({ view }: { view: ListView }) {
  const { networks, query, selectedThreadId, searchFocusTick } = useUi(
    useShallow((s) => ({
      networks: s.networks,
      query: s.listQuery,
      selectedThreadId: s.selectedThreadId,
      searchFocusTick: s.searchFocusTick,
    })),
  )
  const { status, error, messages, contacts } = useInbox(
    useShallow((s) => ({ status: s.status, error: s.error, messages: s.messages, contacts: s.contacts })),
  )
  const aiEnabled = useSettings((s) => s.aiEnabled)
  const now = useClock((s) => s.now)
  const views = useThreadViews()
  const { demoShown, connected, linkedKnown, serverOffline } = useConnections(
    useShallow((s) => ({
      demoShown: s.demo,
      connected: hasRealAccount(s),
      // Signed in, but the server hasn't said what's linked yet: it isn't "nothing is linked".
      linkedKnown: !s.server || s.server.known,
      serverOffline: s.server?.status.state === 'error',
    })),
  )
  const signedIn = useSession((s) => s.status === 'signed-in')
  const hintDismissed = useUi((s) => s.connectHintDismissed)

  const listTag = useUi((s) => s.listTag)
  // The tags in this list (before filtering by one), most common first.
  const tagCounts = useMemo(() => {
    const counts = new Map<ChatLabel, number>()
    for (const v of selectViewThreads(views, view, { networks, query, messages })) {
      for (const label of v.labels) counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    return [...counts].sort((a, b) => b[1] - a[1])
  }, [views, view, networks, query, messages])
  const list = useMemo(
    () => selectViewThreads(views, view, { networks, query, messages, tag: listTag }),
    [views, view, networks, query, messages, listTag],
  )
  const ids = useMemo(() => list.map((v) => v.id), [list])
  const waitingCount = useMemo(() => views.filter((v) => v.waitingOnThem).length, [views])
  const classifying = aiEnabled && list.some((v) => v.priorityLoading)

  // J/K walk this list.
  useEffect(() => useUi.getState().setNavThreadIds(ids), [ids])

  // On wide screens, open the first thread rather than showing an empty pane.
  useEffect(() => {
    if (status !== 'ready' || !isAtLeast('md')) return
    const current = useUi.getState().selectedThreadId
    // Opened by the app, not by the person, so the address bar stays on the list.
    if ((!current || !useInbox.getState().threads[current]) && ids.length) useUi.getState().selectThread(ids[0], { auto: true })
  }, [status, ids])

  const searchRef = useRef<HTMLInputElement>(null)
  useTickEffect(searchFocusTick, () => searchRef.current?.focus())

  const copy = COPY[view]
  const setQuery = useUi.getState().setListQuery

  return (
    <Panel aria-label={copy.title}>
      <header className="space-y-3 border-b border-line px-4 pt-4 pb-3">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="shrink-0 text-base font-semibold tracking-tight whitespace-nowrap">
            {copy.title}
            {status === 'ready' && <span className="ml-2 text-sm font-normal text-faint tabular-nums">{list.length}</span>}
          </h1>
          <p className="min-w-0 truncate text-xs text-faint">{copy.subtitle(aiEnabled)}</p>
        </div>
        <label className="flex h-9 items-center gap-2 rounded-xl border border-line bg-surface-2/60 px-2.5 text-sm transition-colors focus-within:border-accent/40 focus-within:bg-surface focus-within:ring-4 focus-within:ring-accent/10">
          <Search className="size-4 shrink-0 text-faint" aria-hidden />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('')
                e.currentTarget.blur()
              }
            }}
            placeholder="Filter chats"
            aria-label="Filter chats"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
          />
          {query ? (
            <button type="button" aria-label="Clear filter" onClick={() => setQuery('')} className="text-faint hover:text-fg">
              <X className="size-4" />
            </button>
          ) : (
            <Kbd className="hidden md:inline-flex">/</Kbd>
          )}
        </label>
        {aiEnabled && (tagCounts.length > 0 || listTag) && (
          <div role="group" aria-label="Filter by tag" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]">
            {(listTag && !tagCounts.some(([t]) => t === listTag) ? [[listTag, 0] as const, ...tagCounts] : tagCounts).map(([tag, count]) => {
              const { label, icon: Icon } = LABELS[tag]
              const on = listTag === tag
              return (
                <button
                  key={tag}
                  type="button"
                  aria-pressed={on}
                  onClick={() => useUi.getState().setListTag(on ? null : tag)}
                  className={cn(
                    'inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium ring-1 ring-inset transition-colors',
                    on ? 'bg-accent text-white ring-accent' : 'bg-surface-2/60 text-muted ring-line hover:text-fg',
                  )}
                >
                  <Icon className="size-3.5" aria-hidden />
                  {label}
                  <span className={cn('tabular-nums', on ? 'text-white/80' : 'text-faint')}>{count}</span>
                </button>
              )
            })}
          </div>
        )}
        {networks.length > 0 && (
          <p className="text-xs text-muted">
            Showing {networks.map((n) => NETWORKS[n].name).join(', ')} ·{' '}
            <button type="button" className="text-accent-ink hover:underline" onClick={() => useUi.getState().clearNetworks()}>
              show all
            </button>
          </p>
        )}
      </header>

      {demoShown && !connected && !hintDismissed && status === 'ready' && <ConnectHint />}
      {!aiEnabled && view === 'needs-reply' && status === 'ready' && views.length > 0 && <AiOffBanner />}
      {classifying && view === 'needs-reply' && (
        <div className="flex items-center gap-2 border-b border-line bg-accent-soft/50 px-4 py-2 text-xs text-accent-ink">
          <Loader2 className="size-3.5 animate-spin" aria-hidden /> Sorting by priority…
        </div>
      )}

      {/* layoutScroll lets the sliding row highlight account for this list's scroll position. */}
      <motion.div layoutScroll className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {status === 'error' ? (
          <EmptyState
            icon={<CloudOff className="size-6" />}
            title="Couldn't load your chats"
            actions={
              <Button size="sm" onClick={() => void useInbox.getState().load()}>
                Try again
              </Button>
            }
          >
            {error}
          </EmptyState>
        ) : status !== 'ready' ? (
          <ListSkeleton />
        ) : views.length === 0 && !linkedKnown ? (
          // The server is still answering (one waking up takes a moment): it may well have chats.
          serverOffline ? (
            <EmptyState
              icon={<CloudOff className="size-6" />}
              title="Can't reach the server"
              actions={
                <Button size="sm" onClick={() => void useInbox.getState().load()}>
                  Try again
                </Button>
              }
            >
              Your linked accounts and their chats are on the server. This keeps trying.
            </EmptyState>
          ) : (
            <ListSkeleton />
          )
        ) : views.length === 0 ? (
          <EmptyState
            icon={<Link2 className="size-6" />}
            title={connected ? 'No chats yet' : signedIn ? 'Link WhatsApp or Telegram' : 'Connect an account'}
            actions={
              <Button variant="primary" size="sm" onClick={() => useUi.getState().openSettings('accounts')}>
                {connected ? 'Check accounts' : signedIn ? 'Link an account' : 'Connect an account'}
              </Button>
            }
          >
            {connected
              ? 'Chats appear here as they arrive. A Telegram bot shows chats once someone messages it.'
              : signedIn
                ? 'Your chats show up here once you link your WhatsApp or Telegram.'
                : 'Bring in a Telegram bot or a Matrix account (with its WhatsApp, Instagram, Slack and SMS bridges), or turn the demo chats back on.'}
          </EmptyState>
        ) : list.length === 0 ? (
          query ? (
            <NoMatches query={query} onClear={() => setQuery('')} />
          ) : listTag ? (
            <EmptyState
              icon={<Tag className="size-6" />}
              title={`No ${LABELS[listTag].label.toLowerCase()} chats here`}
              actions={
                <Button size="sm" onClick={() => useUi.getState().setListTag(null)}>
                  Show all
                </Button>
              }
            >
              None of the chats in this list has that tag right now.
            </EmptyState>
          ) : view === 'needs-reply' ? (
            <AllCaughtUp waitingCount={waitingCount} />
          ) : view === 'waiting' ? (
            <EmptyState icon={<Hourglass className="size-6" />} title="Nobody owes you a reply">
              When you ask someone something, the chat shows up here until they answer.
            </EmptyState>
          ) : view === 'archived' ? (
            <EmptyState icon={<Archive className="size-6" />} title="No archived chats">
              Archive a chat from its ⋯ menu to keep it out of your lists. Chats you archive on WhatsApp or
              Telegram show up here too.
            </EmptyState>
          ) : (
            <EmptyState icon={<MessagesSquare className="size-6" />} title="No chats here">
              Try clearing the network filter.
            </EmptyState>
          )
        ) : (
          <ul className="relative space-y-0.5 p-2">
            <AnimatePresence initial={false} mode="popLayout">
              {list.map((v) => (
                <motion.li
                  key={v.id}
                  layout="position"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -24, transition: { duration: 0.18 } }}
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                >
                  <ThreadRow
                    view={v}
                    selected={v.id === selectedThreadId}
                    now={now}
                    contacts={contacts}
                    showWaitingOnThem={view === 'waiting'}
                  />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </motion.div>
    </Panel>
  )
}

function ConnectHint() {
  const session = useSession((s) => s.status)
  return (
    <div className="flex items-start gap-3 border-b border-line px-4 py-3">
      <Link2 className="mt-0.5 size-4 shrink-0 text-accent-ink" aria-hidden />
      <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted">
        These are demo chats.{' '}
        {session === 'guest' ? (
          <button
            type="button"
            className="font-medium text-accent-ink hover:underline"
            onClick={() => useSession.getState().showSignIn()}
          >
            Sign in to link WhatsApp or Telegram
          </button>
        ) : (
          <button
            type="button"
            className="font-medium text-accent-ink hover:underline"
            onClick={() => useUi.getState().openSettings('accounts')}
          >
            {session === 'signed-in' ? 'Link WhatsApp or Telegram' : 'Connect Telegram or Matrix'}
          </button>
        )}{' '}
        to bring in your own.
      </p>
      <button
        type="button"
        aria-label="Dismiss"
        className="-m-1 rounded-lg p-1 text-faint hover:text-fg"
        onClick={() => useUi.getState().dismissConnectHint()}
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

function AiOffBanner() {
  return (
    <div className="border-b border-line bg-accent-soft/60 px-4 py-3">
      <div className="flex gap-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface text-accent-ink shadow-card">
          <Sparkles className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-fg">Let AI sort this queue and draft replies</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            It only reads the chats you allow, and they stay on this device.
          </p>
          <div className="mt-2.5 flex gap-2">
            <Button variant="primary" size="sm" onClick={() => turnOnAi()}>
              Turn on AI
            </Button>
            <Button variant="ghost" size="sm" onClick={() => useUi.getState().openSettings('ai')}>
              Choose chats
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-1 p-2" aria-busy="true" aria-label="Loading chats">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex gap-3 px-3 py-3">
          <div className="skeleton size-10 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="skeleton h-3 w-2/5" />
            <div className="skeleton h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  )
}
