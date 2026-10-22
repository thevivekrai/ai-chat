import { useEffect } from 'react'
import { motion } from 'motion/react'
import { Lock, RefreshCw, Sparkles, X } from 'lucide-react'
import { TONES, type Tone } from '@/ai'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { SkeletonLines } from '@/components/ui/Skeleton'
import { isTypingTarget } from '@/lib/dom'
import { applyDraft, setThreadAiAccess } from '@/store/actions'
import { useAi, type AiEntry } from '@/store/ai'
import { settledLastMessageId, useInbox } from '@/store/inbox'
import { canAiReadThread, useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import { WithBlanks } from './RichText'

const TONE_LABEL: Record<Tone, string> = { short: 'Short', friendly: 'Friendly', professional: 'Professional' }

/** Three suggested replies. Picking one only fills the composer; nothing is ever sent automatically. */
export function DraftTray({ threadId }: { threadId: string }) {
  const allowed = useSettings((s) => canAiReadThread(s, threadId))
  const drafts = useAi((s) => s.drafts[threadId])
  const lastKey = useInbox((s) => settledLastMessageId(s.messages[threadId]))
  const close = () => useUi.getState().setDraftsOpen(false)

  // Start drafting as soon as AI may read the chat, and redraft if a new message arrives.
  useEffect(() => {
    if (allowed) useAi.getState().requestDrafts(threadId)
  }, [allowed, threadId, lastKey])

  // 1 / 2 / 3 pick a draft when the cursor isn't in a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      const tone = TONES[['1', '2', '3'].indexOf(e.key)]
      const entry = tone && drafts?.items[tone]
      if (entry?.status === 'ready' && entry.result) {
        e.preventDefault()
        applyDraft(threadId, entry.result)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drafts, threadId])

  const busy = !!drafts && Object.values(drafts.items).some((i) => i.status === 'loading')

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      className="shrink-0 overflow-hidden border-t border-line bg-surface-2/60"
    >
      <div className="max-h-[46dvh] overflow-y-auto px-3 pt-3 pb-3 sm:px-4">
        <div className="mb-2.5 flex items-center gap-2">
          <Sparkles className="size-4 text-accent-ink" aria-hidden />
          <h3 className="text-[13px] font-medium whitespace-nowrap">Suggested replies</h3>
          <span className="hidden truncate text-xs text-faint @2xl:inline">
            · pick one to edit — nothing is sent until you press Send
          </span>
          <div className="ml-auto flex items-center gap-1">
            {allowed && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => useAi.getState().requestDrafts(threadId, { regenerate: true })}
              >
                <RefreshCw className="size-3.5" aria-hidden /> Regenerate
              </Button>
            )}
            <Button size="icon-sm" variant="ghost" aria-label="Close suggestions (Esc)" onClick={close}>
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {allowed ? (
          <div className="grid gap-2 @2xl:grid-cols-3">
            {TONES.map((tone, i) => (
              <DraftCard
                key={`${tone}-${drafts?.variant ?? 0}`}
                tone={tone}
                index={i}
                entry={drafts?.items[tone]}
                onPick={(text) => applyDraft(threadId, text)}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-3 rounded-xl border border-line bg-surface p-4 sm:flex-row sm:items-center">
            <Lock className="size-5 shrink-0 text-muted" aria-hidden />
            <p className="flex-1 text-[13px] leading-relaxed text-muted">
              AI can't read this chat yet. Allow it to get three drafts in different tones. Only this chat is read.
            </p>
            <Button variant="primary" size="sm" onClick={() => setThreadAiAccess(threadId, true)}>
              Allow AI for this chat
            </Button>
          </div>
        )}
      </div>
    </motion.div>
  )
}

function DraftCard({
  tone,
  index,
  entry,
  onPick,
}: {
  tone: Tone
  index: number
  entry: AiEntry<string> | undefined
  onPick(text: string): void
}) {
  const ready = entry?.status === 'ready' && !!entry.result
  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06, duration: 0.22 }}
      disabled={!ready}
      onClick={() => entry?.result && onPick(entry.result)}
      className="group flex min-h-20 flex-col rounded-xl border border-line bg-surface p-3 text-left shadow-xs transition-[border-color,box-shadow,transform] duration-150 outline-none hover:-translate-y-px hover:border-accent/40 hover:shadow-card focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:translate-y-0 @2xl:min-h-28"
    >
      <span className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-wider text-faint uppercase">{TONE_LABEL[tone]}</span>
        <Kbd>{index + 1}</Kbd>
      </span>
      {ready ? (
        <span className="text-[13px] leading-relaxed text-fg">
          <WithBlanks text={entry.result!} />
        </span>
      ) : entry?.status === 'error' ? (
        <span className="text-[13px] text-muted">{entry.error ?? "Couldn't draft this one."} Try Regenerate.</span>
      ) : (
        <SkeletonLines lines={3} className="pt-1" />
      )}
      {ready && (
        <span className="mt-auto hidden pt-2 text-xs font-medium text-accent-ink opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 @2xl:block">
          Use this draft →
        </span>
      )}
    </motion.button>
  )
}
