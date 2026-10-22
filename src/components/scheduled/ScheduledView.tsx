import { useEffect, useMemo } from 'react'
import { AlarmClock, CalendarClock } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { EmptyState } from '@/components/threads/EmptyStates'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Panel } from '@/components/ui/Panel'
import { formatWhen, toMs } from '@/lib/time'
import { openThread, unsnoozeThread } from '@/store/actions'
import { useClock } from '@/store/clock'
import { useInbox } from '@/store/inbox'
import { filterByNetwork, threadPicture, useThreadViews } from '@/store/selectors'
import { useUi } from '@/store/ui'

/** Replies queued with "Send later", and chats snoozed until later. */
export function ScheduledView() {
  const { scheduled, threads, contacts } = useInbox(
    useShallow((s) => ({ scheduled: s.scheduled, threads: s.threads, contacts: s.contacts })),
  )
  const networks = useUi((s) => s.networks)
  const now = useClock((s) => s.now)
  const views = useThreadViews()

  const sends = useMemo(
    () =>
      scheduled
        .filter((s) => threads[s.threadId] && (!networks.length || networks.includes(threads[s.threadId].network)))
        .sort((a, b) => toMs(a.sendAt) - toMs(b.sendAt)),
    [scheduled, threads, networks],
  )
  const snoozed = useMemo(
    () =>
      filterByNetwork(
        views.filter((v) => v.snoozed),
        networks,
      ).sort((a, b) => toMs(a.thread.snoozedUntil!) - toMs(b.thread.snoozedUntil!)),
    [views, networks],
  )

  const ids = useMemo(() => [...new Set([...sends.map((s) => s.threadId), ...snoozed.map((v) => v.id)])], [sends, snoozed])
  useEffect(() => useUi.getState().setNavThreadIds(ids), [ids])

  return (
    <Panel aria-label="Scheduled">
      <header className="border-b border-line px-4 pt-4 pb-3">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-base font-semibold tracking-tight">
            Scheduled <span className="ml-1.5 text-sm font-normal text-faint tabular-nums">{sends.length + snoozed.length}</span>
          </h1>
          <p className="text-xs text-faint">Sends and reminders coming up</p>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-3">
        {sends.length === 0 && snoozed.length === 0 && (
          <EmptyState icon={<CalendarClock className="size-6" />} title="Nothing scheduled">
            Use the clock in the composer to send a reply later, or snooze a chat until you're ready for it.
          </EmptyState>
        )}

        {sends.length > 0 && (
          <section>
            <h2 className="px-1 pb-2 text-[11px] font-semibold tracking-wider text-faint uppercase">Send later</h2>
            <ul className="space-y-2">
              {sends.map((s) => {
                const thread = threads[s.threadId]
                return (
                  <li key={s.id} className="rounded-xl border border-line p-3 animate-fade-in">
                    <button
                      type="button"
                      onClick={() => openThread(thread.id)}
                      className="flex w-full items-center gap-2.5 text-left"
                    >
                      <Avatar
                        name={thread.title}
                        seed={thread.id}
                        size="sm"
                        group={thread.kind === 'group'}
                        network={thread.network}
                        imageUrl={threadPicture(thread, contacts)}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{thread.title}</span>
                      <span className="shrink-0 text-xs font-medium text-accent-ink">
                        {formatWhen(s.sendAt, now, { withTime: true })}
                      </span>
                    </button>
                    <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-muted">{s.body}</p>
                    {s.error && <p className="mt-2 text-xs leading-relaxed text-rose-600 dark:text-rose-400">{s.error}</p>}
                    <div className="mt-2.5 flex gap-1.5">
                      <Button size="sm" onClick={() => void useInbox.getState().sendScheduledNow(s.id)}>
                        {s.error ? 'Send now anyway' : 'Send now'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void useInbox.getState().cancelScheduled(s.id)}>
                        Cancel
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {snoozed.length > 0 && (
          <section>
            <h2 className="px-1 pb-2 text-[11px] font-semibold tracking-wider text-faint uppercase">Snoozed</h2>
            <ul className="space-y-2">
              {snoozed.map((v) => (
                <li key={v.id} className="flex items-center gap-2.5 rounded-xl border border-line p-3 animate-fade-in">
                  <button type="button" onClick={() => openThread(v.id)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                    <Avatar
                      name={v.thread.title}
                      seed={v.id}
                      size="sm"
                      group={v.thread.kind === 'group'}
                      network={v.thread.network}
                      imageUrl={threadPicture(v.thread, contacts)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{v.thread.title}</span>
                      <span className="flex items-center gap-1 text-xs text-muted">
                        <AlarmClock className="size-3" aria-hidden /> Back {formatWhen(v.thread.snoozedUntil!, now, { withTime: true })}
                      </span>
                    </span>
                  </button>
                  <Button size="sm" variant="ghost" onClick={() => void unsnoozeThread(v.id)}>
                    Unsnooze
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Panel>
  )
}
