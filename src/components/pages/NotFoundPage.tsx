import { useState, type FormEvent } from 'react'
import { Compass, Search } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { go } from '@/routing/router'
import { useRouter } from '@/routing/router'
import { useUi } from '@/store/ui'
import { PublicPage } from './PublicPage'

const PLACES = [
  { path: '/', label: 'Needs reply' },
  { path: '/chat', label: 'All chats' },
  { path: '/tasks', label: 'Tasks' },
  { path: '/settings/accounts', label: 'Settings' },
  { path: '/help', label: 'Help' },
]

/** A wrong address: says so, and offers the ways out. */
export function NotFoundPage() {
  const missing = useRouter((s) => s.missing)
  const [query, setQuery] = useState('')

  const search = (e: FormEvent) => {
    e.preventDefault()
    useUi.getState().setListQuery(query)
    go('/chat')
  }

  return (
    <PublicPage title="That page isn’t here" lead={missing ? `Nothing lives at ${missing}.` : 'Nothing lives at that address.'}>
      <form onSubmit={search} className="flex gap-2">
        <label className="sr-only" htmlFor="not-found-search">
          Search your chats
        </label>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <input
            id="not-found-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your chats"
            className="h-10 w-full rounded-xl border border-line bg-surface pl-9 pr-3 text-sm outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-accent/40 focus:ring-4 focus:ring-accent/10"
          />
        </div>
        <Button type="submit" variant="primary" size="sm">
          Search
        </Button>
      </form>

      <div className="space-y-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Compass className="size-4 text-muted" aria-hidden /> Or go to
        </h2>
        <ul className="flex flex-wrap gap-2">
          {PLACES.map(({ path, label }) => (
            <li key={path}>
              <a
                href={path}
                onClick={(e) => {
                  e.preventDefault()
                  go(path)
                }}
                className="inline-flex h-9 items-center rounded-xl border border-line bg-surface-2 px-3 text-sm font-medium transition-colors hover:bg-surface"
              >
                {label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </PublicPage>
  )
}
