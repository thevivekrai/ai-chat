import { useId, useMemo } from 'react'
import { LayoutGroup, motion } from 'motion/react'
import { CalendarClock, Hourglass, Inbox, Keyboard, ListTodo, MessagesSquare, Sparkles, type LucideIcon } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { cn } from '@/lib/cn'
import { NETWORK_ORDER, NETWORKS } from '@/lib/networks'
import { turnOnAi } from '@/store/actions'
import { useConnections } from '@/store/connections'
import { useInbox } from '@/store/inbox'
import { countViews, useThreadViews } from '@/store/selectors'
import { useAi } from '@/store/ai'
import { usesClaude, useSettings } from '@/store/settings'
import { useUi, type View } from '@/store/ui'

const NAV: { id: View; label: string; icon: LucideIcon }[] = [
  { id: 'needs-reply', label: 'Needs reply', icon: Inbox },
  { id: 'all', label: 'All chats', icon: MessagesSquare },
  { id: 'waiting', label: 'Waiting on them', icon: Hourglass },
  { id: 'scheduled', label: 'Scheduled', icon: CalendarClock },
  { id: 'tasks', label: 'Tasks', icon: ListTodo },
]

export function Sidebar({ className }: { className?: string }) {
  const { view, networks, setView, toggleNetwork, clearNetworks } = useUi(
    useShallow((s) => ({
      view: s.view,
      networks: s.networks,
      setView: s.setView,
      toggleNetwork: s.toggleNetwork,
      clearNetworks: s.clearNetworks,
    })),
  )
  const { tasks, scheduled } = useInbox(useShallow((s) => ({ tasks: s.tasks, scheduled: s.scheduled })))
  const views = useThreadViews()
  const counts = useMemo(() => countViews(views, { networks, tasks, scheduled }), [views, networks, tasks, scheduled])
  // Only networks that have chats (or are filtered on) get a chip.
  const shownNetworks = useInbox(
    useShallow((s) => {
      const present = new Set(Object.values(s.threads).map((t) => t.network))
      return NETWORK_ORDER.filter((n) => present.has(n) || networks.includes(n))
    }),
  )
  // The sidebar can be mounted twice (column + drawer); keep each one's sliding pill separate.
  const layoutGroup = useId()

  return (
    <nav aria-label="Inbox views" className={cn('flex h-full min-h-0 w-full flex-col gap-6 overflow-y-auto py-1', className)}>
      <LayoutGroup id={layoutGroup}>
        <ul className="space-y-0.5">
          {NAV.map(({ id, label, icon: Icon }) => {
            const active = view === id
            const count = counts[id]
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => setView(id)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'relative isolate flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active ? 'font-medium text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="nav-pill"
                      aria-hidden
                      className="absolute inset-0 -z-10 rounded-xl bg-pill shadow-pill"
                      transition={{ type: 'spring', stiffness: 520, damping: 40, mass: 0.9 }}
                    />
                  )}
                  <Icon className={cn('size-4', active ? 'text-accent-ink' : 'text-faint')} aria-hidden />
                  <span className="flex-1 text-left">{label}</span>
                  {count > 0 &&
                    (id === 'needs-reply' ? (
                      <span className="grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-fg tabular-nums">
                        {count}
                      </span>
                    ) : (
                      <span className="text-xs text-faint tabular-nums">{count}</span>
                    ))}
                </button>
              </li>
            )
          })}
        </ul>
      </LayoutGroup>

      {shownNetworks.length > 0 && (
        <section aria-labelledby="networks-heading">
          <div className="flex items-center justify-between px-3">
            <h2 id="networks-heading" className="text-[11px] font-semibold tracking-wider text-faint uppercase">
              Networks
            </h2>
            {networks.length > 0 && (
              <button type="button" onClick={clearNetworks} className="text-xs text-muted hover:text-fg">
                Clear
              </button>
            )}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5 px-2">
            {shownNetworks.map((id) => {
              const active = networks.includes(id)
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleNetwork(id)}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'border-accent/30 bg-accent-soft text-accent-ink'
                      : 'border-line bg-surface text-muted hover:border-line-strong hover:text-fg',
                  )}
                >
                  <span className={cn('size-2 rounded-full', NETWORKS[id].dot)} aria-hidden />
                  {NETWORKS[id].name}
                </button>
              )
            })}
          </div>
        </section>
      )}

      <div className="mt-auto space-y-2 px-1">
        <AccountsStatus />
        <AiStatusCard />
        <button
          type="button"
          onClick={() => useUi.getState().openDialog('shortcuts')}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted hover:text-fg"
        >
          <Keyboard className="size-3.5" aria-hidden /> Keyboard shortcuts <Kbd className="ml-auto">?</Kbd>
        </button>
      </div>
    </nav>
  )
}

const ACCOUNT_STATE = {
  online: { label: 'Online', dot: 'bg-emerald-500' },
  connecting: { label: 'Syncing…', dot: 'bg-amber-400 animate-pulse' },
  error: { label: 'Needs attention', dot: 'bg-rose-500' },
} as const

/** Connected accounts at a glance; opens Settings → Accounts. */
function AccountsStatus() {
  const { telegram, matrix } = useConnections(useShallow((s) => ({ telegram: s.telegram, matrix: s.matrix })))
  const rows = [
    { id: 'telegram', label: 'Telegram bot', status: telegram },
    { id: 'matrix', label: 'Matrix', status: matrix },
  ].filter((r) => r.status)
  if (rows.length === 0) return null
  return (
    <button
      type="button"
      onClick={() => useUi.getState().openSettings('accounts')}
      className="w-full space-y-1.5 rounded-2xl px-3 py-2 text-left transition-colors hover:bg-surface-2"
      aria-label="Accounts"
    >
      {rows.map(({ id, label, status }) => (
        <span key={id} className="flex items-center gap-2 text-xs">
          <span className={cn('size-1.5 shrink-0 rounded-full', ACCOUNT_STATE[status!.state].dot)} aria-hidden />
          <span className="truncate font-medium text-fg">{label}</span>
          <span className="ml-auto shrink-0 text-faint">{ACCOUNT_STATE[status!.state].label}</span>
        </span>
      ))}
    </button>
  )
}

function AiStatusCard() {
  const { aiEnabled, selected, claude } = useSettings(
    useShallow((s) => ({ aiEnabled: s.aiEnabled, selected: s.aiThreadIds.length, claude: usesClaude(s) })),
  )
  const total = useInbox((s) => Object.keys(s.threads).length)
  const problem = useAi((s) => s.problem)

  if (!aiEnabled) {
    return (
      <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-card">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="size-4 text-accent-ink" aria-hidden /> AI assist is off
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Turn it on to sort by priority and get drafted replies. Only chats you choose are read.
        </p>
        <Button variant="primary" size="sm" className="mt-3 w-full" onClick={() => turnOnAi()}>
          Turn on AI
        </Button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => useUi.getState().openSettings('ai')}
      className="w-full rounded-2xl border border-line bg-surface p-3.5 text-left shadow-card transition-colors hover:border-line-strong"
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <span className={cn('size-2 rounded-full', problem ? 'bg-rose-500' : 'bg-emerald-500')} aria-hidden />
        {claude ? 'Claude' : 'Demo AI'} is on
      </p>
      <p className="mt-1 text-xs text-muted">
        {problem ? 'Needs attention' : `Reads ${Math.min(selected, total)} of ${total} chats`} ·{' '}
        <span className="text-accent-ink">Manage</span>
      </p>
    </button>
  )
}
