import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Ban,
  CalendarClock,
  Check,
  CheckCheck,
  Clock3,
  Copy,
  CornerUpLeft,
  Download,
  FileText,
  History,
  ImageIcon,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RotateCw,
  SmilePlus,
  Star,
  StarOff,
  Trash2,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Menu, type MenuItem } from '@/components/ui/Popover'
import { api } from '@/data/api'
import type { Attachment, ChatCapabilities, Contact, Message, MessageAction, MessageStatus, QuotedMessage, Reaction } from '@/data/types'
import { isPinned, ME_ID } from '@/data/types'
import { matchesInChat } from '@/data/search'
import { cn } from '@/lib/cn'
import { downloadUrl } from '@/lib/files'
import { isAnimatedSticker } from '@/lib/lottie'
import { hashString } from '@/lib/format'
import { MINUTE, formatClock, formatDayLabel, formatWhen, toMs } from '@/lib/time'
import { messageAction, startEdit, startReply, toggleReaction } from '@/store/actions'
import { useAi } from '@/store/ai'
import { useClock } from '@/store/clock'
import { useInbox } from '@/store/inbox'
import { canAiReadThread, useSettings } from '@/store/settings'
import { toast } from '@/store/toasts'
import { useUi } from '@/store/ui'
import { AudioPlayer } from './AudioPlayer'
import { LottieSticker } from './LottieSticker'
import { RichText, type Highlight } from './RichText'

const NO_MESSAGES: Message[] = []
const NO_ONE: string[] = []

/** Quick reactions: ones WhatsApp and Telegram both accept. */
const QUICK_REACTIONS = ['👍', '❤️', '🤣', '😱', '😢', '🙏']

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
  const { thread, messages, contacts, typing, history } = useInbox(
    useShallow((s) => ({
      thread: s.threads[threadId],
      messages: s.messages[threadId] ?? NO_MESSAGES,
      contacts: s.contacts,
      typing: s.typing[threadId] ?? NO_ONE,
      history: s.history[threadId],
    })),
  )
  const scheduled = useInbox(useShallow((s) => s.scheduled.filter((x) => x.threadId === threadId)))
  const aiAllowed = useSettings((s) => canAiReadThread(s, threadId))
  const tasks = useAi((s) => s.tasks[threadId]?.result)
  const flash = useUi((s) => s.flash)
  const now = useClock((s) => s.now)
  const capabilities = useMemo(() => api.capabilities(threadId), [threadId])
  const scrollRef = useRef<HTMLDivElement>(null)
  // Whether the reader is at the latest message; if so, stay there as the layout changes.
  const pinnedRef = useRef(true)
  // While older messages are added above, keep what's on screen where it is.
  const keepFromBottomRef = useRef<number | null>(null)
  // On touch screens there's no hover: tapping a message shows its actions.
  const [activeId, setActiveId] = useState<string | null>(null)
  // The message whose reaction picker is open, if any.
  const [pickerId, setPickerId] = useState<string | null>(null)
  // The message whose menu (edit, pin, star, delete…) is open, if any.
  const [menuId, setMenuId] = useState<string | null>(null)
  const search = useUi((s) => (s.chatSearch?.threadId === threadId ? s.chatSearch : null))

  const days = useMemo(() => buildDays(messages, now), [messages, now])
  const query = search?.query.trim() ?? ''
  const highlights = useMemo(() => {
    const map = new Map<string, Highlight[]>()
    const add = (id: string, h: Highlight) => map.set(id, [...(map.get(id) ?? []), h])
    if (aiAllowed) {
      for (const t of tasks ?? []) {
        if (!t.dueText) continue
        const title = t.dueAt ? `${t.title} · ${formatWhen(t.dueAt, now)}` : t.title
        add(t.sourceMessageId, { phrase: t.dueText, title, kind: 'date' })
      }
    }
    // What's searched for in this chat, marked wherever it appears.
    if (query) {
      for (const id of matchesInChat(messages, query)) add(id, { phrase: query, title: 'Search', kind: 'search' })
    }
    return map
  }, [tasks, aiAllowed, now, query, messages])

  // Open at the latest message.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [threadId])

  // Older messages were added above: put the reader back where they were.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || keepFromBottomRef.current === null || history?.loading) return
    el.scrollTop = el.scrollHeight - keepFromBottomRef.current
    keepFromBottomRef.current = null
  }, [messages, history?.loading])

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

  // Follow new messages if the reader is near the bottom (or wrote it), and the typing bubble.
  const last = messages[messages.length - 1]
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !last) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240
    if (nearBottom || last.senderId === ME_ID) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [last, scheduled.length, typing.length])

  // The in-chat search's current match, brought into view.
  const searchCurrent = search?.current
  useEffect(() => {
    if (!searchCurrent) return
    const node = scrollRef.current?.querySelector(`[data-message-id="${CSS.escape(searchCurrent)}"]`)
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [searchCurrent])

  // "Jump to message" from search, tasks, the AI panel or a quoted reply.
  useEffect(() => {
    if (!flash) return
    const node = scrollRef.current?.querySelector(`[data-message-id="${CSS.escape(flash.messageId)}"]`)
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [flash])

  if (!thread) return null
  const isGroup = thread.kind === 'group'
  const canLoadOlder = capabilities.history && history?.hasMore !== false && messages.length > 0

  const loadOlder = () => {
    const el = scrollRef.current
    if (el) keepFromBottomRef.current = el.scrollHeight - el.scrollTop
    void useInbox.getState().loadOlder(threadId)
  }

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label={`Messages with ${thread.title}`}
      onScroll={(e) => {
        const el = e.currentTarget
        pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        // Reaching the top fetches the page before it, as the networks' own apps do.
        if (el.scrollTop < 60 && canLoadOlder && !history?.loading) loadOlder()
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4 sm:px-5"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        {canLoadOlder && (
          <div className="flex flex-col items-center gap-1 pt-3">
            <Button size="sm" variant="ghost" onClick={loadOlder} disabled={history?.loading}>
              {history?.loading ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <History className="size-3.5" aria-hidden />
              )}
              Load earlier messages
            </Button>
            {history?.error && <p className="text-xs text-rose-600 dark:text-rose-400">{history.error}</p>}
          </div>
        )}

        {days.map((day) => (
          // Each day is its own section so its sticky label is pushed away by the next one.
          <section key={day.key} aria-label={day.label} className="flex flex-col gap-2">
            <div className="pointer-events-none sticky top-0 z-10 flex justify-center pt-3 pb-1">
              <span className="glass-thick rounded-full px-2.5 py-0.5 text-[11px] font-medium text-muted shadow-card">
                {day.label}
              </span>
            </div>
            {day.groups.map((group) => (
              <MessageGroup
                key={group.key}
                threadId={threadId}
                messages={group.messages}
                fromMe={group.fromMe}
                sender={contacts[group.senderId]}
                contacts={contacts}
                showSender={isGroup && !group.fromMe}
                highlights={highlights}
                flash={flash}
                capabilities={capabilities}
                activeId={activeId}
                onActivate={setActiveId}
                pickerId={pickerId}
                onPicker={setPickerId}
                menuId={menuId}
                onMenu={setMenuId}
                searchMatch={search?.current ?? null}
              />
            ))}
          </section>
        ))}

        {typing.length > 0 && <TypingBubble names={typing.map((id) => contacts[id]?.name ?? 'Someone')} group={isGroup} />}

        {scheduled.map((s) => (
          <div key={s.id} className="mt-1 flex justify-end animate-pop-in">
            <div className="max-w-[85%] rounded-2xl border border-dashed border-accent/40 bg-accent-soft/50 px-3.5 py-2.5 sm:max-w-[75%]">
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-accent-ink">
                <CalendarClock className="size-3.5" aria-hidden /> Scheduled · {formatWhen(s.sendAt, now, { withTime: true })}
              </p>
              <p className="mt-1 text-[14.5px] leading-relaxed break-words whitespace-pre-wrap text-fg">{s.body}</p>
              {s.error && <p className="mt-1.5 text-xs text-rose-600 dark:text-rose-400">{s.error}</p>}
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
  threadId: string
  messages: Message[]
  fromMe: boolean
  sender: Contact | undefined
  contacts: Record<string, Contact>
  showSender: boolean
  highlights: Map<string, Highlight[]>
  flash: { messageId: string; tick: number } | null
  capabilities: ChatCapabilities
  activeId: string | null
  onActivate(id: string | null): void
  pickerId: string | null
  onPicker(id: string | null): void
  menuId: string | null
  onMenu(id: string | null): void
  /** The current match of the in-chat search. */
  searchMatch: string | null
}

function MessageGroup({
  threadId,
  messages,
  fromMe,
  sender,
  contacts,
  showSender,
  highlights,
  flash,
  capabilities,
  activeId,
  onActivate,
  pickerId,
  onPicker,
  menuId,
  onMenu,
  searchMatch,
}: GroupProps) {
  const lastMessage = messages[messages.length - 1]
  return (
    <div className={cn('mt-1.5 flex items-end gap-2', fromMe ? 'justify-end' : 'justify-start')}>
      {showSender && (
        <Avatar name={sender?.name ?? '?'} seed={sender?.id} imageUrl={sender?.avatarUrl} size="sm" className="mb-5" />
      )}
      <div className={cn('flex max-w-[85%] min-w-0 flex-col gap-1 sm:max-w-[75%]', fromMe ? 'items-end' : 'items-start')}>
        {showSender && (
          <span className={cn('px-1 text-xs font-medium', NAME_COLORS[hashString(sender?.id ?? '') % NAME_COLORS.length])}>
            {sender?.name ?? 'Unknown'}
          </span>
        )}
        {messages.map((m, i) => {
          const flashing = flash?.messageId === m.id
          const settled = m.status !== 'sending' && m.status !== 'failed' && !m.id.startsWith('pending-')
          const bare = isStickerOnly(m) && !m.deleted
          const actions =
            settled && (capabilities.reply || capabilities.react || capabilities.delete || capabilities.pin || capabilities.star)
          return (
            <Fragment key={m.id}>
              <div className={cn('group/msg flex max-w-full items-center gap-1', fromMe ? 'flex-row-reverse' : 'flex-row')}>
                <div
                  key={flashing ? `${m.id}-${flash.tick}` : m.id}
                  data-message-id={m.id}
                  title={new Date(m.sentAt).toLocaleString()}
                  onClick={(e) => {
                    // Taps on links and quotes do their own thing.
                    if ((e.target as HTMLElement).closest('a, button')) return
                    onActivate(activeId === m.id ? null : m.id)
                  }}
                  className={cn(
                    bare
                      ? 'w-fit max-w-full rounded-2xl'
                      : cn(
                          'w-fit max-w-full min-w-0 rounded-2xl px-3.5 py-2 text-[14.5px] leading-relaxed break-words whitespace-pre-wrap',
                          fromMe ? 'accent-gloss shadow-bubble-out' : 'bg-bubble-in text-fg shadow-bubble',
                          i === messages.length - 1 && (fromMe ? 'rounded-br-md' : 'rounded-bl-md'),
                        ),
                    m.status === 'sending' && 'opacity-70',
                    m.status === 'failed' && 'ring-2 ring-rose-500/60',
                    searchMatch === m.id && 'ring-2 ring-amber-400 ring-offset-2 ring-offset-transparent',
                    flashing && 'animate-flash',
                  )}
                >
                  {m.deleted ? (
                    <span className={cn('inline-flex items-center gap-1.5 italic', fromMe ? 'text-white/80' : 'text-muted')}>
                      <Ban className="size-3.5 shrink-0" aria-hidden />
                      {fromMe ? 'You deleted this message' : 'This message was deleted'}
                    </span>
                  ) : (
                    <>
                      {m.replyTo && <Quote quote={m.replyTo} contacts={contacts} onAccent={fromMe} />}
                      <Attachments message={m} fromMe={fromMe} />
                      <RichText text={m.body} highlights={highlights.get(m.id)} onAccent={fromMe} />
                    </>
                  )}
                  <MessageMarks message={m} fromMe={fromMe} bare={bare} />
                </div>
                {actions && (
                  <MessageActions
                    threadId={threadId}
                    message={m}
                    fromMe={fromMe}
                    capabilities={capabilities}
                    shown={activeId === m.id || pickerId === m.id || menuId === m.id}
                    pickerOpen={pickerId === m.id}
                    onPicker={(open) => onPicker(open ? m.id : null)}
                    menuOpen={menuId === m.id}
                    onMenu={(open) => onMenu(open ? m.id : null)}
                  />
                )}
              </div>
              {pickerId === m.id && (
                <ReactionPicker
                  current={m.reactions?.find((r) => r.mine)?.emoji ?? null}
                  onPick={(emoji) => {
                    onPicker(null)
                    void toggleReaction(threadId, m.id, emoji)
                  }}
                  onClose={() => onPicker(null)}
                />
              )}
              {m.reactions && m.reactions.length > 0 && (
                <Reactions
                  reactions={m.reactions}
                  canReact={capabilities.react}
                  onToggle={(emoji) => void toggleReaction(threadId, m.id, emoji)}
                />
              )}
              {m.status === 'failed' && (
                <p role="alert" className="max-w-full px-1 text-right text-[11px] leading-snug text-rose-600 dark:text-rose-400">
                  Not sent{m.error ? `: ${m.error}` : ''}{' '}
                  <button
                    type="button"
                    className="font-medium whitespace-nowrap underline-offset-2 hover:underline"
                    onClick={() => void useInbox.getState().retryMessage(m.threadId, m.id)}
                  >
                    Try again
                  </button>
                </p>
              )}
            </Fragment>
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

/** The message a reply quotes. Clicking it jumps to the original, when it's loaded. */
function Quote({ quote, contacts, onAccent }: { quote: QuotedMessage; contacts: Record<string, Contact>; onAccent: boolean }) {
  const name = quote.senderId === ME_ID ? 'You' : (contacts[quote.senderId]?.name ?? 'Someone')
  return (
    <button
      type="button"
      onClick={() => useUi.getState().flashMessage(quote.id)}
      className={cn(
        '-mx-1 mb-1.5 block w-[calc(100%+0.5rem)] min-w-40 rounded-lg border-l-[3px] px-2.5 py-1.5 text-left text-[12.5px] leading-snug whitespace-normal',
        onAccent ? 'border-white/80 bg-white/15 hover:bg-white/20' : 'border-accent bg-surface-2 hover:bg-pill',
      )}
    >
      <span className={cn('block truncate font-semibold', onAccent ? 'text-white' : 'text-accent-ink')}>{name}</span>
      <span className={cn('line-clamp-2', onAccent ? 'text-white/80' : 'text-muted')}>{quote.body || 'Message'}</span>
    </button>
  )
}

/** A message that's only a sticker shows on its own, as in WhatsApp, rather than in a bubble. */
const isStickerOnly = (m: Message) => !m.body && !m.replyTo && m.attachments?.length === 1 && m.attachments[0].kind === 'sticker'

function Attachments({ message, fromMe }: { message: Message; fromMe: boolean }) {
  return message.attachments?.map((a, index) => (
    <AttachmentView key={`${a.name}-${index}`} attachment={a} fromMe={fromMe} sending={message.status === 'sending'} />
  ))
}

/**
 * A photo, shown in the chat with a button to save it; or a file, as a card that downloads it.
 * Linked chats' files come from WhatsApp or Telegram as they're opened, so one that can't be
 * fetched right now shows as a card instead of a broken image.
 */
function AttachmentView({ attachment: a, fromMe, sending }: { attachment: Attachment; fromMe: boolean; sending: boolean }) {
  const [broken, setBroken] = useState(false)
  const [attempt, setAttempt] = useState(0)
  if (a.kind === 'sticker') {
    // WebP images; WebM videos (Telegram's video stickers) and Lottie animations play on a loop.
    if (a.url && !broken) {
      const look = 'block size-32 object-contain drop-shadow-sm'
      if (isAnimatedSticker(a.mime)) return <LottieSticker url={a.url} name={a.name} onFail={() => setBroken(true)} className={look} />
      return a.mime === 'video/webm' ? (
        <video src={a.url} autoPlay loop muted playsInline aria-label={a.name} onError={() => setBroken(true)} className={look} />
      ) : (
        <img src={a.url} alt={a.name} loading="lazy" onError={() => setBroken(true)} className={look} />
      )
    }
    return (
      <span className={cn('inline-block rounded-2xl px-3.5 py-2 text-[14.5px]', fromMe ? 'accent-gloss' : 'bg-bubble-in text-fg shadow-bubble')}>
        {a.name}
      </span>
    )
  }
  if (a.kind === 'audio' && a.url && !sending) return <AudioPlayer attachment={a} fromMe={fromMe} />
  if (a.kind === 'image' && a.url && !broken) {
    return (
      <div className="group/photo relative -mx-1.5 -mt-0.5 mb-1.5">
        <a href={a.url} target="_blank" rel="noreferrer" className="block" aria-label="Open the photo">
          <img
            // A new address for each try, so the browser doesn't reuse the failed one.
            src={attempt ? `${a.url}?try=${attempt}` : a.url}
            alt={a.name}
            loading="lazy"
            onError={() => setBroken(true)}
            className={cn('max-h-72 min-h-16 w-auto min-w-24 max-w-full rounded-xl bg-black/5 object-cover', sending && 'opacity-70')}
          />
        </a>
        {!sending && (
          <a
            href={downloadUrl(a.url)}
            download
            aria-label="Save the photo"
            title="Save"
            className="absolute top-2 right-2 grid size-8 place-items-center rounded-full bg-black/55 text-white opacity-0 shadow-card transition-opacity group-hover/photo:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <Download className="size-4" aria-hidden />
          </a>
        )}
      </div>
    )
  }
  const link = a.url && !sending ? downloadUrl(a.url) : undefined
  // A photo that couldn't be fetched (WhatsApp reconnecting, say) can be tried again.
  if (a.kind === 'image' && broken && link) {
    return (
      <div className={cn('mb-1.5 flex min-w-48 items-center gap-2.5 rounded-xl px-2.5 py-2', fromMe ? 'bg-white/15' : 'bg-surface ring-1 ring-line')}>
        <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', fromMe ? 'bg-white/20' : 'bg-accent-soft text-accent-ink')}>
          <ImageIcon className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{a.name}</span>
          <span className={cn('block text-[11px]', fromMe ? 'text-white/70' : 'text-muted')}>Couldn't be shown right now</span>
        </span>
        <button
          type="button"
          onClick={() => {
            setAttempt((n) => n + 1)
            setBroken(false)
          }}
          aria-label="Try showing the photo again"
          title="Try again"
          className={cn('grid size-7 place-items-center rounded-full', fromMe ? 'hover:bg-white/20' : 'text-muted hover:bg-surface-2')}
        >
          <RotateCw className="size-4" aria-hidden />
        </button>
        <a href={link} download={a.name} aria-label={`Download ${a.name}`} title="Download" className={cn('grid size-7 place-items-center rounded-full', fromMe ? 'hover:bg-white/20' : 'text-muted hover:bg-surface-2')}>
          <Download className="size-4" aria-hidden />
        </a>
      </div>
    )
  }
  const kindLabel =
    a.kind === 'image' ? 'Photo' : a.kind === 'audio' ? 'Audio' : a.name.includes('.') ? a.name.split('.').pop()?.toUpperCase() : 'File'
  const body = (
    <>
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', fromMe ? 'bg-white/20' : 'bg-accent-soft text-accent-ink')}>
        {a.kind === 'image' ? <ImageIcon className="size-4" aria-hidden /> : <FileText className="size-4" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{a.name}</span>
        <span className={cn('block text-[11px]', fromMe ? 'text-white/70' : 'text-muted')}>
          {broken ? "Couldn't be shown right now" : kindLabel}
          {a.size ? ` · ${a.size}` : ''}
        </span>
      </span>
      {link && <Download className={cn('size-4 shrink-0', fromMe ? 'text-white/80' : 'text-muted')} aria-hidden />}
    </>
  )
  const look = cn(
    'mb-1.5 flex min-w-48 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left',
    fromMe ? 'bg-white/15' : 'bg-surface ring-1 ring-line',
    link && (fromMe ? 'transition-colors hover:bg-white/25' : 'transition-colors hover:bg-surface-2'),
  )
  return link ? (
    <a href={link} download={a.name} title={`Download ${a.name}`} className={look}>
      {body}
    </a>
  ) : (
    <div className={look}>{body}</div>
  )
}

/** Pinned, starred, edited: small marks at the end of a message. */
function MessageMarks({ message: m, fromMe, bare }: { message: Message; fromMe: boolean; bare: boolean }) {
  const edited = !!m.editedAt && !m.deleted
  const pinned = isPinned(m)
  if (!edited && !pinned && !m.starred) return null
  return (
    <span
      className={cn(
        'ml-1.5 inline-flex translate-y-px items-center gap-1 align-baseline text-[10.5px] leading-none whitespace-nowrap',
        bare ? 'mt-1 flex text-faint' : fromMe ? 'text-white/70' : 'text-faint',
      )}
    >
      {pinned && <Pin className="size-3" aria-label="Pinned" />}
      {m.starred && <Star className="size-3 fill-current" aria-label="Starred" />}
      {edited && <span title={new Date(m.editedAt!).toLocaleString()}>edited</span>}
    </span>
  )
}

/** React and reply, next to a message: on hover, on keyboard focus, or after a tap. */
function MessageActions({
  threadId,
  message,
  fromMe,
  capabilities,
  shown,
  pickerOpen,
  onPicker,
  menuOpen,
  onMenu,
}: {
  threadId: string
  message: Message
  fromMe: boolean
  capabilities: ChatCapabilities
  shown: boolean
  pickerOpen: boolean
  onPicker(open: boolean): void
  menuOpen: boolean
  onMenu(open: boolean): void
}) {
  const items = messageMenu(threadId, message, fromMe, capabilities)
  const button =
    'grid size-7 place-items-center rounded-full text-faint transition-colors hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-0.5 transition-opacity',
        shown ? 'opacity-100' : 'opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100',
      )}
    >
      {capabilities.react && (
        <button
          type="button"
          aria-label="React"
          title="React"
          aria-expanded={pickerOpen}
          // Keeps the picker's outside-press handler from closing it just before this reopens it.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onPicker(!pickerOpen)}
          className={cn(button, pickerOpen && 'bg-surface-2 text-fg')}
        >
          <SmilePlus className="size-4" aria-hidden />
        </button>
      )}
      {capabilities.reply && !message.deleted && (
        <button type="button" aria-label="Reply" title="Reply" onClick={() => startReply(threadId, message.id)} className={button}>
          <CornerUpLeft className="size-4" aria-hidden />
        </button>
      )}
      {items.length > 0 && (
        <Menu
          items={items}
          open={menuOpen}
          onOpenChange={onMenu}
          // Up or down, whichever has room in the chat.
          side="auto"
          align={fromMe ? 'end' : 'start'}
          panelClassName="min-w-52"
          renderTrigger={(props) => (
            <button {...props} type="button" aria-label="More" title="More" className={cn(button, menuOpen && 'bg-surface-2 text-fg')}>
              <MoreHorizontal className="size-4" aria-hidden />
            </button>
          )}
        />
      )}
    </div>
  )
}

/** What can be done to a message from its menu: what the network allows, and makes sense for it. */
function messageMenu(threadId: string, m: Message, fromMe: boolean, can: ChatCapabilities): MenuItem[] {
  const items: MenuItem[] = []
  const act = (action: MessageAction) => () => void messageAction(threadId, m.id, action)
  if (m.body && !m.deleted) {
    items.push({
      id: 'copy',
      label: 'Copy text',
      icon: Copy,
      onSelect: () => void navigator.clipboard?.writeText(m.body).then(() => toast({ title: 'Copied', group: 'message-action' })),
    })
  }
  if (can.edit && fromMe && m.body && !m.attachments?.length && !m.deleted) {
    items.push({ id: 'edit', label: 'Edit', icon: Pencil, onSelect: () => startEdit(threadId, m.id) })
  }
  if (can.pin && !m.deleted) {
    const pinned = isPinned(m)
    items.push({ id: 'pin', label: pinned ? 'Unpin' : 'Pin', icon: pinned ? PinOff : Pin, onSelect: act({ type: 'pin', pinned: !pinned }) })
  }
  if (can.star && !m.deleted) {
    items.push({ id: 'star', label: m.starred ? 'Unstar' : 'Star', icon: m.starred ? StarOff : Star, onSelect: act({ type: 'star', starred: !m.starred }) })
  }
  if (can.delete) {
    items.push({
      id: 'delete-me',
      label: 'Delete for me',
      icon: Trash2,
      danger: true,
      onSelect: () => {
        if (window.confirm('Delete this message for you? It stays for everyone else.')) act({ type: 'delete', forEveryone: false })()
      },
    })
    if (fromMe && !m.deleted) {
      items.push({
        id: 'delete-all',
        label: 'Delete for everyone',
        icon: Trash2,
        danger: true,
        onSelect: () => {
          if (window.confirm('Delete this message for everyone in the chat?')) act({ type: 'delete', forEveryone: true })()
        },
      })
    }
  }
  return items
}

/**
 * Quick reactions, under the message: in the flow of the conversation, so it never runs off a
 * narrow screen. Closes on a pick, a press elsewhere, or Escape.
 */
function ReactionPicker({
  current,
  onPick,
  onClose,
}: {
  current: string | null
  onPick(emoji: string): void
  onClose(): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    ref.current?.querySelector('button')?.focus()
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close.current()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close.current()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])
  return (
    <div
      ref={ref}
      role="group"
      aria-label="Reactions"
      className="glass-thick glass-edge flex max-w-full gap-0.5 overflow-x-auto rounded-full p-1 shadow-pop animate-pop-in"
    >
      {QUICK_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          aria-pressed={current === emoji}
          aria-label={current === emoji ? `Remove ${emoji}` : `React ${emoji}`}
          onClick={() => onPick(emoji)}
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-full text-xl transition-transform hover:scale-125 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            current === emoji && 'bg-accent-soft',
          )}
        >
          {emoji}
        </button>
      ))}
    </div>
  )
}

function Reactions({ reactions, canReact, onToggle }: { reactions: Reaction[]; canReact: boolean; onToggle(emoji: string): void }) {
  return (
    <div className="-mt-1.5 flex flex-wrap gap-1 px-1">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          disabled={!canReact}
          aria-pressed={r.mine}
          aria-label={`${r.emoji} ${r.count}${r.mine ? ', including you' : ''}`}
          onClick={() => onToggle(r.emoji)}
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-full border px-1.5 text-[13px] shadow-card transition-colors disabled:cursor-default',
            r.mine ? 'border-accent/40 bg-accent-soft text-accent-ink' : 'border-line bg-surface text-muted enabled:hover:border-line-strong',
          )}
        >
          <span aria-hidden>{r.emoji}</span>
          {r.count > 1 && <span className="text-[11px] font-medium tabular-nums">{r.count}</span>}
        </button>
      ))}
    </div>
  )
}

function TypingBubble({ names, group }: { names: string[]; group: boolean }) {
  const who = names.length === 1 ? names[0] : `${names.length} people`
  return (
    <div className="mt-1.5 flex items-end gap-2 animate-pop-in" role="status" aria-label={`${who} is typing`}>
      <div className="flex flex-col items-start gap-1">
        {group && <span className="px-1 text-xs text-muted">{who}</span>}
        <div className="flex h-9 items-center gap-1 rounded-2xl rounded-bl-md bg-bubble-in px-3.5 shadow-bubble">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              aria-hidden
              className="size-1.5 animate-typing rounded-full bg-muted"
              style={{ animationDelay: `${i * 160}ms` }}
            />
          ))}
        </div>
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
