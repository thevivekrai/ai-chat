import { useState } from 'react'
import { Pin } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { messagePreview } from '@/lib/format'
import { useInbox } from '@/store/inbox'
import { useUi } from '@/store/ui'

/**
 * The chat's pinned messages, newest first, above the conversation. A tap jumps to the one shown
 * and moves on to the next, as in WhatsApp.
 */
export function PinnedBar({ threadId }: { threadId: string }) {
  const pinned = useInbox(useShallow((s) => (s.messages[threadId] ?? []).filter((m) => m.pinned && !m.deleted).reverse()))
  const contacts = useInbox((s) => s.contacts)
  const [index, setIndex] = useState(0)
  if (!pinned.length) return null
  const current = pinned[index % pinned.length]
  return (
    <button
      type="button"
      onClick={() => {
        useUi.getState().flashMessage(current.id)
        setIndex((i) => (i + 1) % pinned.length)
      }}
      className="flex w-full shrink-0 items-center gap-2.5 border-b border-line bg-surface/60 px-4 py-2 text-left transition-colors hover:bg-surface-2/70"
    >
      <Pin className="size-4 shrink-0 text-accent-ink" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-semibold text-accent-ink">
          Pinned message{pinned.length > 1 ? ` · ${(index % pinned.length) + 1} of ${pinned.length}` : ''}
        </span>
        <span className="block truncate text-xs text-muted">{messagePreview({ ...current, senderId: 'x' }, contacts, false)}</span>
      </span>
    </button>
  )
}
