import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AlertTriangle, CalendarClock, SendHorizontal, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Menu } from '@/components/ui/Popover'
import { useTickEffect } from '@/hooks/useTickEffect'
import { cn } from '@/lib/cn'
import { findPlaceholders, placeholderPattern, shortName } from '@/lib/format'
import { NETWORKS } from '@/lib/networks'
import { sendLaterOptions } from '@/lib/schedule'
import { formatShortWhen } from '@/lib/time'
import { scheduleReply, sendReply, toggleDrafts } from '@/store/actions'
import { useClock } from '@/store/clock'
import { useInbox } from '@/store/inbox'
import { useUi } from '@/store/ui'

const MAX_HEIGHT = 200

/** Selects the next [placeholder] after the cursor, wrapping around. Returns false if there is none. */
function selectNextBlank(el: HTMLTextAreaElement): boolean {
  const matches = [...el.value.matchAll(placeholderPattern())]
  if (matches.length === 0) return false
  const after = matches.find((m) => (m.index ?? 0) >= el.selectionEnd) ?? matches[0]
  const start = after.index ?? 0
  el.setSelectionRange(start, start + after[0].length)
  return true
}

export function Composer({ threadId }: { threadId: string }) {
  const thread = useInbox((s) => s.threads[threadId])
  // Address the person in a 1:1 chat ("Message Kavya…"), the chat itself in a group.
  const recipient = useInbox((s) => {
    const t = s.threads[threadId]
    const person = t?.kind === 'direct' ? s.contacts[t.participantIds[0]] : undefined
    return person ? shortName(person.name) : (t?.title ?? '')
  })
  const text = useUi((s) => s.composer[threadId] ?? '')
  const draftsOpen = useUi((s) => s.draftsOpen)
  const focusTick = useUi((s) => s.composerFocusTick)
  const now = useClock((s) => s.now)
  const ref = useRef<HTMLTextAreaElement>(null)
  // Asking once before sending a reply that still has a [blank] in it.
  const [confirmingBlanks, setConfirmingBlanks] = useState(false)
  const blanks = findPlaceholders(text)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  // Focus requests (Enter shortcut, or a draft was just inserted): select the first blank if any.
  useTickEffect(focusTick, () => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    selectNextBlank(el)
  })

  if (!thread) return null
  const setText = (value: string) => {
    setConfirmingBlanks(false)
    useUi.getState().setComposer(threadId, value)
  }

  const send = () => {
    if (!text.trim()) return
    if (blanks.length && !confirmingBlanks) {
      setConfirmingBlanks(true)
      return
    }
    setConfirmingBlanks(false)
    void sendReply(threadId, text)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    } else if (e.key === 'Tab' && !e.shiftKey && selectNextBlank(e.currentTarget)) {
      e.preventDefault()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (useUi.getState().draftsOpen) useUi.getState().setDraftsOpen(false)
      else e.currentTarget.blur()
    }
  }

  const options = sendLaterOptions(now)
  const hasText = !!text.trim()

  return (
    <div className="shrink-0 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4">
      {confirmingBlanks && (
        <p role="alert" className="mb-2 flex items-center gap-1.5 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          Fill in {blanks.join(', ')} first — or press Enter again to send as is.
        </p>
      )}
      <div
        className={cn(
          'flex items-end gap-1.5 rounded-3xl border bg-surface py-1.5 pr-1.5 pl-4 shadow-card transition-[border-color,box-shadow]',
          'border-line focus-within:border-accent/40 focus-within:ring-4 focus-within:ring-accent/10',
        )}
      >
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Message ${recipient} on ${NETWORKS[thread.network].name}…`}
          aria-label="Message"
          className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[14.5px] leading-relaxed outline-none placeholder:text-faint"
        />
        <Menu
          title="Send later"
          side="top"
          panelClassName="min-w-64"
          items={options.map((o) => ({
            id: o.id,
            label: o.label,
            hint: formatShortWhen(o.at.getTime(), now),
            icon: CalendarClock,
            onSelect: () => void scheduleReply(threadId, text, o.at),
          }))}
          renderTrigger={(props) => (
            <Button {...props} variant="ghost" size="icon-sm" aria-label="Send later" disabled={!hasText} title="Send later">
              <CalendarClock className="size-[18px]" />
            </Button>
          )}
        />
        <Button variant="primary" size="icon-sm" aria-label="Send" title="Send (Enter)" disabled={!hasText} onClick={send}>
          <SendHorizontal className="size-4" />
        </Button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button
          variant={draftsOpen ? 'soft' : 'ghost'}
          size="sm"
          aria-expanded={draftsOpen}
          onClick={() => toggleDrafts(threadId)}
          className="text-accent-ink"
        >
          <Sparkles className="size-3.5" aria-hidden /> Draft replies <Kbd className="hidden sm:inline-flex">R</Kbd>
        </Button>
        <p className="ml-auto hidden truncate text-xs text-faint sm:block">
          {blanks.length ? (
            <>
              <Kbd>Tab</Kbd> jumps to the next blank
            </>
          ) : (
            'Enter to send · Shift+Enter for a new line'
          )}
        </p>
      </div>
    </div>
  )
}
