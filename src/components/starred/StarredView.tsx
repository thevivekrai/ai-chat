import { useEffect, useMemo } from 'react'
import { Star } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { EmptyState } from '@/components/threads/EmptyStates'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Panel } from '@/components/ui/Panel'
import { ME_ID } from '@/data/types'
import { messagePreview } from '@/lib/format'
import { formatWhen } from '@/lib/time'
import { messageAction, openThread } from '@/store/actions'
import { useClock } from '@/store/clock'
import { useInbox } from '@/store/inbox'
import { starredMessages, threadPicture } from '@/store/selectors'
import { useUi } from '@/store/ui'

/** Messages starred in any chat, newest first: each opens its chat at the message. */
export function StarredView() {
  const { messages, threads, contacts } = useInbox(
    useShallow((s) => ({ messages: s.messages, threads: s.threads, contacts: s.contacts })),
  )
  const networks = useUi((s) => s.networks)
  const now = useClock((s) => s.now)
  const starred = useMemo(() => starredMessages(messages, threads, networks), [messages, threads, networks])

  const ids = useMemo(() => [...new Set(starred.map((m) => m.threadId))], [starred])
  useEffect(() => useUi.getState().setNavThreadIds(ids), [ids])

  return (
    <Panel aria-label="Starred">
      <header className="border-b border-line px-4 pt-4 pb-3">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-base font-semibold tracking-tight">
            Starred <span className="ml-1.5 text-sm font-normal text-faint tabular-nums">{starred.length}</span>
          </h1>
          <p className="text-xs text-faint">Messages to find again</p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        {starred.length === 0 ? (
          <EmptyState icon={<Star className="size-6" />} title="No starred messages">
            Star a message from its menu (⋯) to keep it here, whichever chat it's in.
          </EmptyState>
        ) : (
          <ul className="space-y-2">
            {starred.map((m) => {
              const thread = threads[m.threadId]
              // In a one-to-one chat the chat's name already says who wrote it, unless it was me.
              const sender = m.senderId === ME_ID ? 'You' : thread.kind === 'group' ? (contacts[m.senderId]?.name ?? null) : null
              return (
                <li key={m.id} className="rounded-xl border border-line p-3 animate-fade-in">
                  <button type="button" onClick={() => openThread(thread.id, m.id)} className="flex w-full items-center gap-2.5 text-left">
                    <Avatar
                      name={thread.title}
                      seed={thread.id}
                      size="sm"
                      group={thread.kind === 'group'}
                      network={thread.network}
                      imageUrl={threadPicture(thread, contacts)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{thread.title}</span>
                      {sender && <span className="block truncate text-xs text-muted">{sender}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-faint">{formatWhen(m.sentAt, now)}</span>
                  </button>
                  <p className="mt-2 line-clamp-3 text-[13px] leading-relaxed text-fg">
                    {messagePreview({ ...m, senderId: 'x' }, contacts, false)}
                  </p>
                  <div className="mt-2 flex gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => void messageAction(thread.id, m.id, { type: 'star', starred: false })}>
                      <Star className="size-3.5" aria-hidden /> Unstar
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Panel>
  )
}
