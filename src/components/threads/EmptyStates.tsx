import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { CheckCheck, Hourglass, SearchX, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useUi } from '@/store/ui'

export function EmptyState({
  icon,
  title,
  children,
  actions,
}: {
  icon: ReactNode
  title: string
  children?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center animate-fade-in">
      <div className="mb-4 grid size-14 place-items-center rounded-2xl bg-surface-2 text-muted ring-1 ring-line">{icon}</div>
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {children && <div className="mt-1.5 max-w-72 text-sm leading-relaxed text-muted">{children}</div>}
      {actions && <div className="mt-5 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  )
}

/** The reward for an empty queue. */
export function AllCaughtUp({ waitingCount }: { waitingCount: number }) {
  const setView = useUi((s) => s.setView)
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <motion.div
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 18 }}
        className="relative mb-5 grid size-20 place-items-center rounded-full bg-accent-soft"
      >
        <CheckCheck className="size-9 text-accent-ink" strokeWidth={2.2} aria-hidden />
        {[
          { x: -38, y: -26, d: 0.15 },
          { x: 40, y: -18, d: 0.25 },
          { x: 30, y: 34, d: 0.35 },
        ].map((s, i) => (
          <motion.span
            key={i}
            className="absolute text-accent-ink"
            initial={{ opacity: 0, scale: 0, x: 0, y: 0 }}
            animate={{ opacity: [0, 1, 0.8], scale: 1, x: s.x, y: s.y }}
            transition={{ delay: s.d, duration: 0.6 }}
          >
            <Sparkles className="size-4" aria-hidden />
          </motion.span>
        ))}
      </motion.div>
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
        <h2 className="text-lg font-semibold tracking-tight">You're all caught up</h2>
        <p className="mx-auto mt-1.5 max-w-64 text-sm leading-relaxed text-muted">
          Nobody is waiting on you right now. Enjoy the quiet ☕
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {waitingCount > 0 && (
            <Button size="sm" onClick={() => setView('waiting')}>
              <Hourglass className="size-3.5" aria-hidden /> Waiting on them ({waitingCount})
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setView('all')}>
            Browse all chats
          </Button>
        </div>
      </motion.div>
    </div>
  )
}

export function NoMatches({ query, onClear }: { query: string; onClear(): void }) {
  return (
    <EmptyState
      icon={<SearchX className="size-6" />}
      title="No chats match"
      actions={
        <Button size="sm" onClick={onClear}>
          Clear search
        </Button>
      }
    >
      Nothing here matches “{query}”. Try <span className="font-medium text-fg">⌘K</span> to search every message.
    </EmptyState>
  )
}
