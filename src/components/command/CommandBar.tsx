import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  ArrowRight,
  CalendarClock,
  CornerDownLeft,
  Hourglass,
  Inbox,
  Keyboard,
  ListTodo,
  Lock,
  MessagesSquare,
  Moon,
  Search,
  Settings,
  Sparkles,
  Sun,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { answerQuestion, type SearchAnswer } from '@/ai'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Modal } from '@/components/ui/Modal'
import { NetworkIcon } from '@/components/ui/NetworkIcon'
import { SkeletonLines } from '@/components/ui/Skeleton'
import { api } from '@/data/api'
import type { Message, SearchHit, Thread } from '@/data/types'
import { ME_ID } from '@/data/types'
import { cn } from '@/lib/cn'
import { NETWORKS } from '@/lib/networks'
import { formatAgo } from '@/lib/time'
import { openThread, simulateIncoming, turnOnAi } from '@/store/actions'
import { describeAiError } from '@/store/ai'
import { buildAnswerSources } from '@/store/aiInput'
import { useClock } from '@/store/clock'
import { useConnections } from '@/store/connections'
import { useInbox } from '@/store/inbox'
import { threadPicture } from '@/store/selectors'
import { canAiReadThread, useSettings } from '@/store/settings'
import { useUi, type View } from '@/store/ui'

const SUGGESTED_QUESTIONS = [
  'What did the supplier quote me?',
  'Which orders are people waiting on?',
  'When is the trek and what do I owe?',
  'When is the invoice due?',
]

interface Command {
  id: string
  label: string
  icon: LucideIcon
  hint?: string
  run(): void
}

type AnswerState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; result: SearchAnswer; skipped: number }
  | { status: 'error'; message: string }

interface Result {
  hit: SearchHit
  cited: boolean
  message: Message
  thread: Thread
}

const NO_HITS: SearchHit[] = []
const NO_IDS: string[] = []

export function CommandBar() {
  const open = useUi((s) => s.dialog === 'command')
  const close = () => useUi.getState().closeDialog()
  return (
    <Modal open={open} onClose={close} label="Search and ask" placement="top" className="max-w-2xl">
      <CommandBody close={close} />
    </Modal>
  )
}

function CommandBody({ close }: { close(): void }) {
  const [query, setQuery] = useState('')
  // Results are stored with the query they belong to, so stale ones are simply ignored.
  const [search, setSearch] = useState<{ query: string; hits: SearchHit[] }>({ query: '', hits: [] })
  const [answer, setAnswer] = useState<{ query: string; state: AnswerState }>({ query: '', state: { status: 'idle' } })
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const { aiEnabled, aiThreadIds, theme } = useSettings(
    useShallow((s) => ({ aiEnabled: s.aiEnabled, aiThreadIds: s.aiThreadIds, theme: s.theme })),
  )
  const { threads, messages, contacts } = useInbox(
    useShallow((s) => ({ threads: s.threads, messages: s.messages, contacts: s.contacts })),
  )
  const now = useClock((s) => s.now)

  const q = query.trim()
  const searchable = q.length >= 2
  const searching = searchable && search.query !== q
  const hits = searchable && search.query === q ? search.hits : NO_HITS
  const answerState: AnswerState = !searchable
    ? { status: 'idle' }
    : answer.query === q
      ? answer.state
      : aiEnabled
        ? { status: 'loading' }
        : { status: 'idle' }

  // Search as you type; ask the (mock) model once the query settles.
  useEffect(() => {
    if (q.length < 2) return
    let cancelled = false
    const timer = setTimeout(async () => {
      const found = await api.searchMessages(q, { limit: 20 })
      if (cancelled) return
      setSearch({ query: q, hits: found })
      if (!aiEnabled) return

      const canRead = (id: string) => canAiReadThread({ aiEnabled, aiThreadIds }, id)
      const sources = buildAnswerSources(found, useInbox.getState(), canRead)
      const skipped = new Set(found.filter((h) => !canRead(h.threadId)).map((h) => h.threadId)).size
      setAnswer({ query: q, state: { status: 'loading' } })
      try {
        const result = await answerQuestion(q, sources)
        if (!cancelled) setAnswer({ query: q, state: { status: 'ready', result, skipped } })
      } catch (error) {
        if (!cancelled) setAnswer({ query: q, state: { status: 'error', message: describeAiError(error) } })
      }
    }, 220)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [q, aiEnabled, aiThreadIds])

  const demoShown = useConnections((s) => s.demo)
  const commands = useMemo<Command[]>(() => {
    const go = (view: View, label: string, icon: LucideIcon): Command => ({
      id: `go-${view}`,
      label: `Go to ${label}`,
      icon,
      run: () => useUi.getState().setView(view),
    })
    const all: Command[] = [
      go('needs-reply', 'Needs reply', Inbox),
      go('all', 'All chats', MessagesSquare),
      go('waiting', 'Waiting on them', Hourglass),
      go('scheduled', 'Scheduled', CalendarClock),
      go('tasks', 'Tasks', ListTodo),
      {
        id: 'theme',
        label: theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
        icon: theme === 'dark' ? Sun : Moon,
        run: () => useSettings.getState().setTheme(theme === 'dark' ? 'light' : 'dark'),
      },
      { id: 'settings', label: 'Open settings', icon: Settings, run: () => useUi.getState().openDialog('settings') },
      {
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        icon: Keyboard,
        hint: '?',
        run: () => useUi.getState().openDialog('shortcuts'),
      },
      ...(demoShown
        ? [{ id: 'simulate', label: 'Simulate an incoming message', icon: Zap, run: () => void simulateIncoming() }]
        : []),
    ]
    if (!q) return all
    const needle = q.toLowerCase()
    return all.filter((c) => c.label.toLowerCase().includes(needle)).slice(0, 3)
  }, [q, theme, demoShown])

  // Cited messages first, then the rest of the matches.
  const citedIds = answerState.status === 'ready' ? answerState.result.citedMessageIds : NO_IDS
  const results = useMemo(() => {
    const byId = new Map(hits.map((h) => [h.messageId, h]))
    const all = Object.values(messages).flat()
    const ordered: Result[] = []
    const add = (id: string, cited: boolean) => {
      const message = all.find((m) => m.id === id)
      const thread = message && threads[message.threadId]
      if (!message || !thread) return
      ordered.push({ hit: byId.get(id) ?? { messageId: id, threadId: thread.id, score: 0, matchedWords: [] }, cited, message, thread })
    }
    citedIds.forEach((id) => add(id, true))
    hits.forEach((h) => !citedIds.includes(h.messageId) && add(h.messageId, false))
    return ordered
  }, [hits, citedIds, messages, threads])

  // Everything selectable, in display order, for arrow keys and Enter.
  const suggestions = q ? [] : SUGGESTED_QUESTIONS
  const runCommand = (c: Command) => {
    close()
    c.run()
  }
  const openResult = (r: Result) => {
    close()
    openThread(r.thread.id, r.message.id)
  }
  const entries: (() => void)[] = [
    ...suggestions.map((s) => () => setQuery(s)),
    ...commands.map((c) => () => runCommand(c)),
    ...results.map((r) => () => openResult(r)),
  ]
  const activeIndex = Math.min(cursor, entries.length - 1)
  const commandsStart = suggestions.length
  const resultsStart = commandsStart + commands.length

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!entries.length) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setCursor((activeIndex + step + entries.length) % entries.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      entries[activeIndex]?.()
    }
  }

  const rowProps = (index: number, run: () => void) => ({
    active: index === activeIndex,
    onHover: () => index !== activeIndex && setCursor(index),
    onClick: run,
  })

  return (
    <div className="flex max-h-[80dvh] flex-col">
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Search className="size-5 shrink-0 text-faint" aria-hidden />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          onKeyDown={onKeyDown}
          placeholder="Ask anything or search every chat…"
          aria-label="Search or ask"
          className="h-14 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
        />
        <Kbd>Esc</Kbd>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
        {suggestions.length > 0 && (
          <Group title="Try asking">
            {suggestions.map((s, i) => (
              <Row key={s} {...rowProps(i, () => setQuery(s))} icon={<Sparkles className="size-4 text-accent-ink" />}>
                {s}
              </Row>
            ))}
          </Group>
        )}

        {searchable && (
          <AnswerCard state={answerState} aiEnabled={aiEnabled} empty={!searching && hits.length === 0} />
        )}

        {commands.length > 0 && (
          <Group title={q ? 'Commands' : 'Go to'}>
            {commands.map((c, i) => (
              <Row
                key={c.id}
                {...rowProps(commandsStart + i, () => runCommand(c))}
                icon={<c.icon className="size-4 text-muted" />}
                hint={c.hint && <Kbd>{c.hint}</Kbd>}
              >
                {c.label}
              </Row>
            ))}
          </Group>
        )}

        {results.length > 0 && (
          <Group title={citedIds.length ? 'Sources and matches' : 'Matching messages'}>
            {results.map((r, i) => {
              const { hit, cited, message, thread } = r
              const sender = message.senderId === ME_ID ? 'You' : (contacts[message.senderId]?.name ?? 'Someone')
              return (
                <Row
                  key={hit.messageId}
                  {...rowProps(resultsStart + i, () => openResult(r))}
                  icon={
                    <Avatar
                      name={thread.title}
                      seed={thread.id}
                      size="sm"
                      group={thread.kind === 'group'}
                      imageUrl={threadPicture(thread, contacts)}
                    />
                  }
                  tall
                >
                  <span className="flex items-center gap-1.5 text-xs text-muted">
                    <NetworkIcon network={thread.network} />
                    <span className="truncate font-medium text-fg">{thread.title}</span>
                    <span className="shrink-0">· {NETWORKS[thread.network].name}</span>
                    <span className="shrink-0">· {formatAgo(message.sentAt, now)}</span>
                    {cited && (
                      <span className="ml-1 shrink-0 rounded-full bg-accent-soft px-1.5 py-px text-[10px] font-semibold text-accent-ink">
                        Source
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-[13px] leading-relaxed text-fg">
                    {thread.kind === 'group' && <span className="text-muted">{sender}: </span>}
                    <Highlighted text={message.body} words={hit.matchedWords} />
                  </span>
                </Row>
              )
            })}
          </Group>
        )}

        {searchable && !searching && hits.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted">No messages match “{q}”.</p>
        )}
      </div>

      <footer className="flex items-center gap-4 border-t border-line px-4 py-2 text-xs text-faint">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> navigate
        </span>
        <span className="flex items-center gap-1">
          <Kbd>
            <CornerDownLeft className="size-3" aria-label="Enter" />
          </Kbd>{' '}
          open
        </span>
        <span className="ml-auto hidden items-center gap-1 sm:flex">
          <Lock className="size-3" aria-hidden /> Answers only use chats AI may read
        </span>
      </footer>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-2">
      <p className="px-3 pt-2 pb-1.5 text-[11px] font-semibold tracking-wider text-faint uppercase">{title}</p>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

interface RowProps {
  children: ReactNode
  icon: ReactNode
  hint?: ReactNode
  tall?: boolean
  active: boolean
  onHover(): void
  onClick(): void
}

function Row({ children, icon, hint, tall, active, onHover, onClick }: RowProps) {
  return (
    <button
      type="button"
      data-active={active}
      onMouseMove={onHover}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg px-3 text-left text-sm outline-none',
        tall ? 'py-2.5' : 'h-10',
        active && 'bg-surface-2',
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">{children}</span>
      {hint}
      {active && <ArrowRight className="size-4 shrink-0 text-faint" aria-hidden />}
    </button>
  )
}

function AnswerCard({ state, aiEnabled, empty }: { state: AnswerState; aiEnabled: boolean; empty: boolean }) {
  if (!aiEnabled) {
    return (
      <div className="m-1 mb-3 flex items-center gap-3 rounded-xl border border-dashed border-line-strong p-3.5">
        <Sparkles className="size-4 shrink-0 text-accent-ink" aria-hidden />
        <p className="flex-1 text-[13px] text-muted">Turn on AI to get a direct answer above your search results.</p>
        <Button size="sm" variant="soft" onClick={() => turnOnAi()}>
          Turn on AI
        </Button>
      </div>
    )
  }
  if (state.status === 'idle' || (empty && state.status !== 'ready')) return null

  return (
    <div className="m-1 mb-3 rounded-xl border border-accent/20 bg-accent-soft/50 p-4 animate-fade-in">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-accent-ink uppercase">
        <Sparkles className="size-3.5" aria-hidden /> AI answer
      </p>
      {state.status === 'ready' ? (
        <>
          <p className="text-[14.5px] leading-relaxed text-fg">
            <Bold text={state.result.answer} />
          </p>
          {state.skipped > 0 && (
            <p className="mt-2 text-xs text-muted">
              {state.skipped} matching chat{state.skipped === 1 ? ' was' : 's were'} not shown to AI (not selected in
              Settings).
            </p>
          )}
        </>
      ) : state.status === 'error' ? (
        <p className="text-[13px] text-muted">Couldn't answer that right now. {state.message}</p>
      ) : (
        <SkeletonLines lines={2} />
      )}
    </div>
  )
}

/** Renders **bold** spans from the model's answer. */
function Bold({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
        part.startsWith('**') && part.endsWith('**') ? (
          <strong key={i} className="font-semibold">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  )
}

function Highlighted({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>
  const pattern = new RegExp(`\\b(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi')
  return (
    <>
      {text.split(pattern).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-amber-500/20 px-0.5 text-fg">
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  )
}
