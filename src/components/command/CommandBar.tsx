import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  Archive,
  ArrowRight,
  AtSign,
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
  UserPlus,
  X,
  Star,
  Sun,
  VenetianMask,
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
import { api, type PersonResult } from '@/data/api'
import type { Message, SearchHit, Thread } from '@/data/types'
import { ME_ID } from '@/data/types'
import { cn } from '@/lib/cn'
import { NETWORKS } from '@/lib/networks'
import { formatAgo } from '@/lib/time'
import { openThread, setIncognito, simulateIncoming, startChatWith, turnOnAi } from '@/store/actions'
import { describeAiError } from '@/store/ai'
import { asksAboutTasks, buildAnswerSources, buildScopedSources, openTasks } from '@/store/aiInput'
import { useClock } from '@/store/clock'
import { useConnections } from '@/store/connections'
import { useInbox } from '@/store/inbox'
import { recoveryKeyWaiting, useSession } from '@/store/session'
import { useIncognito } from '@/store/privacy'
import { threadPicture } from '@/store/selectors'
import { canAiReadThread, useSettings } from '@/store/settings'
import { toast } from '@/store/toasts'
import { useUi, type View } from '@/store/ui'

const SUGGESTED_QUESTIONS = ['What are my tasks for today?', 'Have I ordered anything?', 'When is my flight?']

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

/** A chat being picked for the AI: "@" and what follows it, at the end of what's typed. */
const MENTION = /(?:^|\s)@([^\s@]*)$/

/** Chats the question names, by the first name of their title ("…with Ravi and Neha"). */
function namedChats(query: string, threads: Record<string, Thread>): Thread[] {
  const words = new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
  return Object.values(threads)
    .filter((t) => {
      const first = t.title.toLowerCase().match(/[\p{L}\p{N}]{3,}/u)?.[0]
      return !!first && words.has(first)
    })
    .slice(0, 3)
}

export function CommandBar() {
  const keyWaiting = useSession(recoveryKeyWaiting)
  const open = useUi((s) => s.dialog === 'command') && !keyWaiting
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
  // Chats picked for the AI: a question is then about these and nothing else.
  const [scope, setScope] = useState<string[]>([])
  const [scopedAnswer, setScopedAnswer] = useState<{ key: string; state: AnswerState } | null>(null)
  const [people, setPeople] = useState<{ query: string; found: PersonResult[] }>({ query: '', found: [] })
  const signedIn = useSession((s) => s.status === 'signed-in')

  const { aiEnabled, aiThreadIds, theme } = useSettings(
    useShallow((s) => ({ aiEnabled: s.aiEnabled, aiThreadIds: s.aiThreadIds, theme: s.theme })),
  )
  const { threads, messages, contacts } = useInbox(
    useShallow((s) => ({ threads: s.threads, messages: s.messages, contacts: s.contacts })),
  )
  const now = useClock((s) => s.now)

  const mention = MENTION.exec(query)
  const q = (mention ? query.slice(0, mention.index) : query).trim()
  // Picking chats, or asking about picked ones: the question waits for Enter, so it's clear what
  // the AI will read before it reads anything.
  const scoped = scope.length > 0 || !!mention
  const searchable = q.length >= 2 && !scoped
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
      const inbox = useInbox.getState()
      // Questions about tasks get the open tasks (with their due dates) as well as what search found.
      const tasks = asksAboutTasks(q) ? openTasks(inbox.tasks, inbox.threads, canRead) : []
      const sources = buildAnswerSources(found, inbox, canRead)
      const skipped = new Set(found.filter((h) => !canRead(h.threadId)).map((h) => h.threadId)).size
      setAnswer({ query: q, state: { status: 'loading' } })
      try {
        const result = await answerQuestion(q, sources, tasks)
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

  useEffect(() => {
    if (!signedIn || scoped || q.length < 2) return
    let cancelled = false
    const timer = setTimeout(() => {
      api
        .findPeople(q)
        .then((found) => !cancelled && setPeople({ query: q, found }))
        .catch(() => undefined)
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [q, signedIn, scoped])

  // People: contacts here first (the phone's saved contacts among them), then anyone the linked
  // accounts found — each once, those with a chat said so.
  const personResults = useMemo<PersonResult[]>(() => {
    if (scoped || q.length < 2) return []
    const needle = q.toLowerCase()
    const local = Object.values(contacts)
      .filter((c) => !c.id.endsWith('@g.us') && (c.name.toLowerCase().includes(needle) || (c.handle ?? '').toLowerCase().includes(needle)))
      .map((contact) => ({ contact, hasChat: !!threads[contact.id] }))
    const remote = people.query === q ? people.found.map((p) => ({ ...p, hasChat: p.hasChat || !!threads[p.contact.id] })) : []
    const seen = new Set<string>()
    return [...local, ...remote].filter((p) => !seen.has(p.contact.id) && seen.add(p.contact.id)).slice(0, 5)
  }, [q, scoped, contacts, threads, people])

  // Most recent first, by each chat's latest message.
  const lastAtOf = useMemo(() => {
    const at = new Map(Object.entries(messages).map(([id, list]) => [id, list.length ? Date.parse(list[list.length - 1]!.sentAt) : 0]))
    return (t: Thread) => at.get(t.id) ?? 0
  }, [messages])

  // Chats to pick for the AI: those whose name has what follows "@".
  const mentionToken = mention?.[1]?.toLowerCase() ?? null
  const pickable = useMemo(() => {
    if (mentionToken === null) return []
    return Object.values(threads)
      .filter((t) => !scope.includes(t.id) && t.title.toLowerCase().includes(mentionToken))
      .sort((a, b) => lastAtOf(b) - lastAtOf(a))
      .slice(0, 6)
  }, [mentionToken, threads, scope, lastAtOf])
  const named = useMemo(() => (scope.length || mention || q.split(/\s+/).length < 2 ? [] : namedChats(q, threads)), [q, scope, mention, threads])

  const pick = (threadId: string) => {
    setScope((s) => [...s, threadId])
    setQuery((text) => text.replace(MENTION, (m) => (m.startsWith(' ') ? ' ' : '')).trimEnd() + ' ')
    setCursor(0)
  }
  const scopeKey = `${q}|${scope.join(',')}`
  const scopedState = scopedAnswer?.key === scopeKey ? scopedAnswer.state : { status: 'idle' as const }
  const askScoped = async () => {
    const question = q || 'Summarise these chats: what was said, what was decided, and anything asked of me.'
    const canRead = (id: string) => canAiReadThread({ aiEnabled, aiThreadIds }, id)
    const sources = buildScopedSources(scope, useInbox.getState(), canRead)
    const skipped = scope.filter((id) => !canRead(id)).length
    setScopedAnswer({ key: scopeKey, state: { status: 'loading' } })
    try {
      const result = await answerQuestion(question, sources, [])
      setScopedAnswer({ key: scopeKey, state: { status: 'ready', result, skipped } })
    } catch (error) {
      setScopedAnswer({ key: scopeKey, state: { status: 'error', message: describeAiError(error) } })
    }
  }

  const demoShown = useConnections((s) => s.demo)
  const incognito = useIncognito()
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
      go('starred', 'Starred', Star),
      go('archived', 'Archived', Archive),
      {
        id: 'incognito',
        label: incognito ? 'Turn off Incognito mode' : 'Turn on Incognito mode',
        icon: VenetianMask,
        run: () => void setIncognito(!incognito).catch((error: unknown) => toast({ title: "Couldn't change Incognito mode", description: error instanceof Error ? error.message : undefined })),
      },
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
  }, [q, theme, demoShown, incognito])

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
  const suggestions = q || scoped ? [] : SUGGESTED_QUESTIONS
  const runCommand = (c: Command) => {
    close()
    c.run()
  }
  const openResult = (r: Result) => {
    close()
    openThread(r.thread.id, r.message.id)
  }
  const openPerson = (p: PersonResult) => {
    close()
    if (p.hasChat) openThread(p.contact.id)
    else void startChatWith(p.contact.id)
  }
  const askRow = scope.length > 0 && !mention ? [() => void askScoped()] : []
  const namedRow = named.length ? [() => setScope(named.map((t) => t.id))] : []
  const entries: (() => void)[] = [
    ...askRow,
    ...pickable.map((t) => () => pick(t.id)),
    ...namedRow,
    ...suggestions.map((s) => () => setQuery(s)),
    ...personResults.map((p) => () => openPerson(p)),
    ...commands.map((c) => () => runCommand(c)),
    ...results.map((r) => () => openResult(r)),
  ]
  const activeIndex = Math.min(cursor, entries.length - 1)
  const pickStart = askRow.length
  const namedStart = pickStart + pickable.length
  const suggestionsStart = namedStart + namedRow.length
  const peopleStart = suggestionsStart + suggestions.length
  const commandsStart = peopleStart + personResults.length
  const resultsStart = commandsStart + commands.length

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Backspace at the very start takes back the last chat picked.
    if (e.key === 'Backspace' && !query && scope.length) {
      setScope((s) => s.slice(0, -1))
      return
    }
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
          placeholder={scope.length ? 'Ask about these chats…' : 'Ask anything, search every chat, or type @ to pick chats…'}
          aria-label="Search or ask"
          className="h-14 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
        />
        <Kbd>Esc</Kbd>
      </div>

      {scope.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2" aria-label="Chats the AI will read">
          <span className="text-xs font-medium text-muted">Asking about</span>
          {scope.map((id) => (
            <span key={id} className="inline-flex h-6 items-center gap-1 rounded-full bg-accent-soft pr-1 pl-2 text-xs font-medium text-accent-ink">
              {threads[id]?.title ?? 'Chat'}
              <button
                type="button"
                aria-label={`Leave out ${threads[id]?.title ?? 'this chat'}`}
                className="grid size-4 place-items-center rounded-full hover:bg-accent/20"
                onClick={() => setScope((s) => s.filter((x) => x !== id))}
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
          <span className="ml-auto text-[11px] text-faint">Only these chats are read</span>
        </div>
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
        {askRow.length > 0 && (
          <>
            <Group title="Ask the AI">
              <Row {...rowProps(0, () => void askScoped())} icon={<Sparkles className="size-4 text-accent-ink" />} hint={<Kbd>↵</Kbd>}>
                {q ? `“${q}”` : 'Summarise them'} — about {scope.length} chat{scope.length === 1 ? '' : 's'}
              </Row>
            </Group>
            {scopedState.status !== 'idle' && <AnswerCard state={scopedState} aiEnabled={aiEnabled} empty={false} />}
          </>
        )}

        {mention && (
          <Group title="Pick chats for the AI">
            {pickable.map((t, i) => (
              <Row
                key={t.id}
                {...rowProps(pickStart + i, () => pick(t.id))}
                icon={<Avatar name={t.title} seed={t.id} size="sm" group={t.kind === 'group'} imageUrl={threadPicture(t, contacts)} />}
              >
                <span className="flex items-center gap-1.5">
                  <NetworkIcon network={t.network} />
                  {t.title}
                </span>
              </Row>
            ))}
            {pickable.length === 0 && <p className="px-3 py-2 text-sm text-muted">No chat by that name.</p>}
          </Group>
        )}

        {named.length > 0 && (
          <Group title="Only these chats?">
            <Row {...rowProps(namedStart, () => setScope(named.map((t) => t.id)))} icon={<AtSign className="size-4 text-accent-ink" />}>
              Ask only about {named.map((t) => t.title).join(', ')}
            </Row>
          </Group>
        )}

        {suggestions.length > 0 && (
          <Group title="Try asking">
            {suggestions.map((s, i) => (
              <Row key={s} {...rowProps(suggestionsStart + i, () => setQuery(s))} icon={<Sparkles className="size-4 text-accent-ink" />}>
                {s}
              </Row>
            ))}
          </Group>
        )}

        {searchable && (
          <AnswerCard state={answerState} aiEnabled={aiEnabled} empty={!searching && hits.length === 0} />
        )}

        {personResults.length > 0 && (
          <Group title="People">
            {personResults.map((p, i) => (
              <Row
                key={p.contact.id}
                {...rowProps(peopleStart + i, () => openPerson(p))}
                icon={<Avatar name={p.contact.name} seed={p.contact.id} size="sm" imageUrl={p.contact.avatarUrl} />}
                hint={
                  p.hasChat ? (
                    <span className="text-xs text-faint">Open</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-accent-ink">
                      <UserPlus className="size-3.5" aria-hidden /> Start chat
                    </span>
                  )
                }
              >
                <span className="flex items-center gap-1.5">
                  <NetworkIcon network={p.contact.network} />
                  <span className="truncate">{p.contact.name}</span>
                  {p.contact.handle && <span className="truncate text-xs text-faint">{p.contact.handle}</span>}
                </span>
              </Row>
            ))}
          </Group>
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
