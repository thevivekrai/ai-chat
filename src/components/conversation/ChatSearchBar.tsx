import { useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronUp, History, Loader2, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { api } from '@/data/api'
import { matchesInChat } from '@/data/search'
import type { Message } from '@/data/types'
import { useInbox } from '@/store/inbox'
import { useUi, type ChatSearch } from '@/store/ui'

const NO_MESSAGES: Message[] = []

/** Searching for a word or phrase in the open chat: every match is marked, the current one framed. */
export function ChatSearchBar({ threadId }: { threadId: string }) {
  const search = useUi((s) => (s.chatSearch?.threadId === threadId ? s.chatSearch : null))
  return search ? <SearchBar search={search} /> : null
}

function SearchBar({ search }: { search: ChatSearch }) {
  const { threadId, query } = search
  const messages = useInbox((s) => s.messages[threadId] ?? NO_MESSAGES)
  const history = useInbox((s) => s.history[threadId])
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const matches = matchesInChat(messages, query)
  const index = search.current ? matches.indexOf(search.current) : -1
  const canGoFurther = !!query.trim() && api.capabilities(threadId).history && history?.hasMore !== false

  const set = (next: Partial<ChatSearch>) => useUi.getState().setChatSearch({ ...search, ...next })
  const close = () => useUi.getState().setChatSearch(null)
  // A new query starts at the latest match, as other chat apps do.
  const onQuery = (next: string) => set({ query: next, current: matchesInChat(messages, next).at(-1) ?? null })
  const older = () => index > 0 && set({ current: matches[index - 1] })
  const newer = () => index >= 0 && index < matches.length - 1 && set({ current: matches[index + 1] })

  /** Loads earlier pages until something new matches (a few at most). */
  const searchFurther = async () => {
    setBusy(true)
    try {
      for (let page = 0; page < 5; page++) {
        const before = useInbox.getState().messages[threadId]?.length ?? 0
        await useInbox.getState().loadOlder(threadId)
        const now = useInbox.getState().messages[threadId] ?? NO_MESSAGES
        const found = matchesInChat(now, query).filter((id) => !matches.includes(id))
        if (found.length) {
          set({ current: found.at(-1)! })
          return
        }
        if (now.length === before || useInbox.getState().history[threadId]?.hasMore === false) return
      }
    } finally {
      setBusy(false)
      input.current?.focus()
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) newer()
      else older()
    }
  }

  const count = !query.trim() ? '' : matches.length ? `${matches.length - index} of ${matches.length}` : 'No matches'
  return (
    <div role="search" className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-2 animate-fade-in sm:px-4">
      <Search className="size-4 shrink-0 text-faint" aria-hidden />
      <input
        ref={input}
        autoFocus
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search in this chat"
        aria-label="Search in this chat"
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
      />
      <span role="status" className="shrink-0 text-xs text-muted tabular-nums">
        {count}
      </span>
      {canGoFurther && (
        <Button size="sm" variant="ghost" onClick={() => void searchFurther()} disabled={busy} title="Search earlier messages">
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <History className="size-3.5" aria-hidden />}
          <span className="hidden sm:inline">Earlier</span>
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" aria-label="Older match (Enter)" title="Older match (Enter)" disabled={index <= 0} onClick={older}>
        <ChevronUp className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Newer match (Shift+Enter)"
        title="Newer match (Shift+Enter)"
        disabled={index < 0 || index >= matches.length - 1}
        onClick={newer}
      >
        <ChevronDown className="size-4" />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Close search (Esc)" title="Close search (Esc)" onClick={close}>
        <X className="size-4" />
      </Button>
    </div>
  )
}
