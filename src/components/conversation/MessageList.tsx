import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { AlertCircle, CalendarClock, Check, CheckCheck, Clock3, FileText } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import type { Contact, Message, MessageStatus } from '@/data/types'
import { ME_ID } from '@/data/types'
import { cn } from '@/lib/cn'
import { hashString } from '@/lib/format'
import { MINUTE, formatClock, formatDayLabel, formatWhen, toMs } from '@/lib/time'
import { useAi } from '@/store/ai'
import { useClock } from '@/store/clock'
import { useInbox } from '@/store/inbox'
import { canAiReadThread, useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import { RichText, type Highlight } from './RichText'

const NO_MESSAGES: Message[] = []

const NAME_COLORS = [
  'text-rose-600 dark:text-rose-400',
  'text-amber-700 dark:text-amber-400',
  'text-emerald-700 dark:text-emerald-400',
  'text-sky-700 dark:text-sky-400',
  'text-violet-600 dark:text-violet-400',
  'text-teal-700 dark:text-teal-400',
]

interface Group {
  key: string
  senderId: string
  fromMe: boolean
  messages: Message[]
}

interface Day {
  key: string
  label: string
  groups: Group[]
}

/** Messages by day, with consecutive messages from one sender (within 5 minutes) grouped. */
function buildDays(messages: Message[], now: number): Day[] {
  const days: Day[] = []
  for (const m of messages) {
    const key = new Date(m.sentAt).toDateString()
    let day = days[days.length - 1]
    if (day?.key !== key) {
      day = { key, label: formatDayLabel(m.sentAt, now), groups: [] }
      days.push(day)
    }
    const group = day.groups[day.groups.length - 1]
    const prev = group?.messages[group.messages.length - 1]
    if (group && prev && group.senderId === m.senderId && toMs(m.sentAt) - toMs(prev.sentAt) < 5 * MINUTE) {
      group.messages.push(m)
    } else {
      day.groups.push({ key: m.id, senderId: m.senderId, fromMe: m.senderId === ME_ID, messages: [m] })
    }
  }
  return days
}

export function MessageList({ threadId }: { threadId: string }) {
  const { thread, messages, contacts } = useInbox(
    useShallow((s) => ({ thread: s.threads[threadId], messages: s.messages[threadId] ?? NO_MESSAGES, contacts: s.contacts })),
  )
  const scheduled = useInbox(useShallow((s) => s.scheduled.filter((x) => x.threadId === threadId)))
  const aiAllowed = useSettings((s) => canAiReadThread(s, threadId))
  const tasks = useAi((s) => s.tasks[threadId]?.result)
  const flash = useUi((s) => s.flash)
  const now = useClock((s) => s.now)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Whether the reader is at the latest message; if so, stay there as the layout changes.
  const pinnedRef = useRef(true)

  const days = useMemo(() => buildDays(messages, now), [messages, now])
  const highlights = useMemo(() => {
    const map = new Map<string, Highlight[]>()
    if (!aiAllowed) return map
    for (const t of tasks ?? []) {
      if (!t.dueText) continue
      const title = t.dueAt ? `${t.title} · ${formatWhen(t.dueAt, now)}` : t.title
      map.set(t.sourceMessageId, [...(map.get(t.sourceMessageId) ?? []), { phrase: t.dueText, title }])
    }
    return map
  }, [tasks, aiAllowed, now])

  // Open at the latest message.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [threadId])

  // When the composer grows or the drafts tray opens, keep the latest message in view.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Follow new messages if the reader is near the bottom (or wrote it).
  const last = messages[messages.length - 1]
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !last) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240
    if (nearBottom || last.senderId === ME_ID) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [last, scheduled.length])

  // "Jump to message" from search, tasks or the AI panel.
  useEffect(() => {
    if (!flash) return
    const node = scrollRef.current?.querySelector(`[data-message-id="${CSS.escape(flash.messageId)}"]`)
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [flash])

  if (!thread) return null
  const isGroup = thread.kind === 'group'

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label={`Messages with ${thread.title}`}
      onScroll={(e) => {
        const el = e.currentTarget
        pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4 sm:px-5"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        {days.map((day) => (
          // Each day is its own section so its sticky label is pushed away by the next one.
          <section key={day.key} aria-label={day.label} className="flex flex-col gap-2">
            <div className="pointer-events-none sticky top-0 z-10 flex justify-center pt-3 pb-1">
              <span className="rounded-full border border-line bg-surface/90 px-2.5 py-0.5 text-[11px] font-medium text-muted shadow-xs backdrop-blur">
                {day.label}
              </span>
            </div>
            {day.groups.map((group) => (
              <MessageGroup
                key={group.key}
                messages={group.messages}
                fromMe={group.fromMe}
                sender={contacts[group.senderId]}
                showSender={isGroup && !group.fromMe}
                highlights={highlights}
                flash={flash}
              />
            ))}
          </section>
        ))}

        {scheduled.map((s) => (
          <div key={s.id} className="mt-1 flex justify-end animate-pop-in">
            <div className="max-w-[85%] rounded-2xl border border-dashed border-accent/40 bg-accent-soft/50 px-3.5 py-2.5 sm:max-w-[75%]">
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-accent-ink">
                <CalendarClock className="size-3.5" aria-hidden /> Scheduled · {formatWhen(s.sendAt, now, { withTime: true })}
              </p>
              <p className="mt-1 text-[14.5px] leading-relaxed break-words whitespace-pre-wrap text-fg">{s.body}</p>
              <div className="mt-2 flex justify-end gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => useInbox.getState().cancelScheduled(s.id)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => useInbox.getState().sendScheduledNow(s.id)}>
                  Send now
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

interface GroupProps {
  messages: Message[]
  fromMe: boolean
  sender: Contact | undefined
  showSender: boolean
  highlights: Map<string, Highlight[]>
  flash: { messageId: string; tick: number } | null
}

function MessageGroup({ messages, fromMe, sender, showSender, highlights, flash }: GroupProps) {
  const lastMessage = messages[messages.length - 1]
  return (
    <div className={cn('mt-1.5 flex items-end gap-2', fromMe ? 'justify-end' : 'justify-start')}>
      {showSender && <Avatar name={sender?.name ?? '?'} seed={sender?.id} size="sm" className="mb-5" />}
      <div className={cn('flex max-w-[85%] min-w-0 flex-col gap-1 sm:max-w-[75%]', fromMe ? 'items-end' : 'items-start')}>
        {showSender && (
          <span className={cn('px-1 text-xs font-medium', NAME_COLORS[hashString(sender?.id ?? '') % NAME_COLORS.length])}>
            {sender?.name ?? 'Unknown'}
          </span>
        )}
        {messages.map((m, i) => {
          const flashing = flash?.messageId === m.id
          return (
            <div
              key={flashing ? `${m.id}-${flash.tick}` : m.id}
              data-message-id={m.id}
              title={new Date(m.sentAt).toLocaleString()}
              className={cn(
                'w-fit max-w-full rounded-2xl px-3.5 py-2 text-[14.5px] leading-relaxed break-words whitespace-pre-wrap',
                fromMe ? 'bg-bubble-out text-white' : 'bg-bubble-in text-fg',
                i === messages.length - 1 && (fromMe ? 'rounded-br-md' : 'rounded-bl-md'),
                m.status === 'sending' && 'opacity-70',
                m.status === 'failed' && 'ring-2 ring-rose-500/60',
                flashing && 'animate-flash',
              )}
            >
              {m.attachments?.map((a) => (
                <div
                  key={a.name}
                  className={cn(
                    'mb-1.5 flex items-center gap-2.5 rounded-xl px-2.5 py-2',
                    fromMe ? 'bg-white/15' : 'bg-surface ring-1 ring-line',
                  )}
                >
                  <span
                    className={cn(
                      'grid size-9 shrink-0 place-items-center rounded-lg',
                      fromMe ? 'bg-white/20' : 'bg-accent-soft text-accent-ink',
                    )}
                  >
                    <FileText className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{a.name}</span>
                    <span className={cn('block text-[11px]', fromMe ? 'text-white/70' : 'text-muted')}>
                      {a.name.split('.').pop()?.toUpperCase()}
                      {a.size ? ` · ${a.size}` : ''}
                    </span>
                  </span>
                </div>
              ))}
              <RichText text={m.body} highlights={highlights.get(m.id)} onAccent={fromMe} />
            </div>
          )
        })}
        <span className="flex items-center gap-1 px-1 text-[11px] text-faint tabular-nums">
          {formatClock(lastMessage.sentAt)}
          {fromMe && <StatusIcon status={lastMessage.status} />}
        </span>
      </div>
    </div>
  )
}

function StatusIcon({ status }: { status?: MessageStatus }) {
  switch (status) {
    case 'sending':
      return <Clock3 className="size-3" aria-label="Sending" />
    case 'sent':
      return <Check className="size-3.5" aria-label="Sent" />
    case 'delivered':
      return <CheckCheck className="size-3.5" aria-label="Delivered" />
    case 'read':
      return <CheckCheck className="size-3.5 text-accent-ink" aria-label="Read" />
    case 'failed':
      return <AlertCircle className="size-3.5 text-rose-500" aria-label="Failed to send" />
    default:
      return null
  }
}
