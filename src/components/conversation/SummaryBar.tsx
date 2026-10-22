import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Lock, Sparkles } from 'lucide-react'
import { AiFailed } from '@/components/ui/AiFailed'
import { Button } from '@/components/ui/Button'
import { SkeletonLines } from '@/components/ui/Skeleton'
import { LONG_THREAD_MESSAGES } from '@/config'
import { setThreadAiAccess } from '@/store/actions'
import { useAi } from '@/store/ai'
import { useInbox } from '@/store/inbox'
import { canAiReadThread, useSettings } from '@/store/settings'

/**
 * Long threads get a one-line summary automatically; group chats get a "Summarize" action that
 * expands into key points.
 */
export function SummaryBar({ threadId }: { threadId: string }) {
  const isGroup = useInbox((s) => s.threads[threadId]?.kind === 'group')
  const count = useInbox((s) => s.messages[threadId]?.length ?? 0)
  const allowed = useSettings((s) => canAiReadThread(s, threadId))
  const entry = useAi((s) => s.summary[threadId])
  const [expanded, setExpanded] = useState(false)

  const isLong = count >= LONG_THREAD_MESSAGES
  if (!isGroup && !isLong) return null

  if (!allowed) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2/50 px-4 py-2 text-xs text-muted">
        <Lock className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">
          {isLong ? `${count} messages.` : 'Group chat.'} Allow AI to read this chat to get a summary.
        </span>
        <button
          type="button"
          onClick={() => setThreadAiAccess(threadId, true)}
          className="ml-auto shrink-0 font-medium text-accent-ink hover:underline"
        >
          Allow
        </button>
      </div>
    )
  }

  const summary = entry?.result
  const showOneLine = isLong || expanded
  const summarize = () => {
    useAi.getState().ensureSummary(threadId)
    setExpanded((v) => !v)
  }

  return (
    <div className="shrink-0 border-b border-line bg-surface-2/50 px-4 py-2.5">
      <div className="mx-auto flex max-w-3xl items-start gap-2.5">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-accent-ink" aria-hidden />
        <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
          {!showOneLine ? (
            <p className="text-muted">Catch up on this group in a few lines.</p>
          ) : !summary && entry?.status === 'error' ? (
            <AiFailed message={entry.error} onRetry={() => useAi.getState().ensureSummary(threadId)} />
          ) : !summary ? (
            <SkeletonLines lines={1} className="pt-1.5" />
          ) : (
            <p className={entry?.status === 'loading' ? 'opacity-60' : undefined}>
              <span className="font-medium text-fg">Summary · </span>
              <span className="text-muted">{summary.oneLine}</span>
            </p>
          )}
          <AnimatePresence initial={false}>
            {expanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22 }}
                className="overflow-hidden"
              >
                {!summary && entry?.status === 'error' ? null : summary ? (
                  <ul className="mt-2 space-y-1.5 pb-0.5">
                    {summary.bullets.map((b) => (
                      <li key={b} className="flex gap-2 text-fg">
                        <span className="mt-[9px] size-1 shrink-0 rounded-full bg-accent" aria-hidden />
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <SkeletonLines lines={3} className="mt-3" />
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {isGroup && (
          <Button size="sm" variant={expanded ? 'ghost' : 'soft'} className="-my-1" onClick={summarize}>
            {expanded ? 'Hide' : 'Summarize'}
          </Button>
        )}
      </div>
    </div>
  )
}
