import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronLeft, ChevronRight, Clock, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { cn } from '@/lib/cn'
import { useClock } from '@/store/clock'

/**
 * Choosing an exact date and time: a month to pick the day from, and the time to the minute.
 * Used by "Send later" and "Snooze" when none of the ready-made times will do.
 *
 * Fully keyboard-operable: the arrow keys move the day (a week up or down), Page Up/Down a month,
 * Home/End the week's start and end; the time is a native field, which screen readers know.
 */
export function DateTimeDialog({
  open,
  title,
  confirmLabel,
  initial,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  confirmLabel: string
  /** Where it starts: a sensible next time the caller chooses. */
  initial: Date
  onConfirm(at: Date): void
  onClose(): void
}) {
  return (
    <Modal open={open} onClose={onClose} label={title} className="max-w-sm">
      {/* Mounted only while open, so each opening starts from `initial`. */}
      {open && <Picker title={title} confirmLabel={confirmLabel} initial={initial} onConfirm={onConfirm} onClose={onClose} />}
    </Modal>
  )
}

const pad = (n: number) => String(n).padStart(2, '0')
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const QUICK_TIMES = ['09:00', '12:00', '15:00', '18:00', '21:00']
/** How far ahead it lets you go: past a year, it's probably a slip. */
const MAX_AHEAD_DAYS = 366

function Picker({
  title,
  confirmLabel,
  initial,
  onConfirm,
  onClose,
}: {
  title: string
  confirmLabel: string
  initial: Date
  onConfirm(at: Date): void
  onClose(): void
}) {
  const [day, setDay] = useState(() => startOfDay(initial))
  const [month, setMonth] = useState(() => new Date(initial.getFullYear(), initial.getMonth(), 1))
  const [time, setTime] = useState(`${pad(initial.getHours())}:${pad(initial.getMinutes())}`)
  const grid = useRef<HTMLDivElement>(null)

  // The app's clock, which ticks on: a choice that slips into the past while open says so.
  const now = useClock((s) => s.now)
  const today = startOfDay(new Date(now))
  const last = addDays(today, MAX_AHEAD_DAYS)
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  // The browser's own locale. (navigator.language can be a tag Intl refuses, like "en-US@posix".)
  const locale = undefined

  const [hours, minutes] = time.split(':').map(Number) as [number, number]
  const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours || 0, minutes || 0)
  const past = !time || at.getTime() <= now

  // The month's days, from the Monday on or before the 1st, six weeks of them.
  const days = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1)
    const lead = (first.getDay() + 6) % 7
    return Array.from({ length: 42 }, (_, i) => addDays(first, i - lead))
  }, [month])
  const weekdays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(new Date(2024, 0, 1 + i))),
    [locale],
  )

  const choose = (next: Date) => {
    const clamped = next < today ? today : next > last ? last : next
    setDay(clamped)
    if (clamped.getMonth() !== month.getMonth() || clamped.getFullYear() !== month.getFullYear()) {
      setMonth(new Date(clamped.getFullYear(), clamped.getMonth(), 1))
    }
    // Keep focus on the chosen day, so the keys can carry on from it.
    requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus())
  }

  const onGridKey = (e: KeyboardEvent) => {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
    if (e.key in moves) choose(addDays(day, moves[e.key]!))
    else if (e.key === 'PageUp') choose(new Date(day.getFullYear(), day.getMonth() - 1, day.getDate()))
    else if (e.key === 'PageDown') choose(new Date(day.getFullYear(), day.getMonth() + 1, day.getDate()))
    else if (e.key === 'Home') choose(addDays(day, -((day.getDay() + 6) % 7)))
    else if (e.key === 'End') choose(addDays(day, 6 - ((day.getDay() + 6) % 7)))
    else return
    e.preventDefault()
  }

  const monthLabel = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(month)
  const summary = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(at)
  const canGoBack = month > new Date(today.getFullYear(), today.getMonth(), 1)
  const canGoOn = month < new Date(last.getFullYear(), last.getMonth(), 1)

  return (
    <div className="p-4">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">{title}</h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </header>

      <div className="mb-2 flex items-center justify-between">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous month"
          disabled={!canGoBack}
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <p className="text-sm font-medium" aria-live="polite">
          {monthLabel}
        </p>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next month"
          disabled={!canGoOn}
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      <div role="grid" aria-label={monthLabel} ref={grid} onKeyDown={onGridKey} className="select-none">
        <div role="row" className="grid grid-cols-7 text-center text-[11px] font-medium text-faint">
          {weekdays.map((w, i) => (
            <span key={i} role="columnheader" className="py-1">
              {w}
            </span>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, week) => (
          <div role="row" key={week} className="grid grid-cols-7 gap-0.5">
            {days.slice(week * 7, week * 7 + 7).map((d) => {
              const selected = sameDay(d, day)
              const outside = d.getMonth() !== month.getMonth()
              const unavailable = d < today || d > last
              return (
                <button
                  key={d.toISOString()}
                  type="button"
                  role="gridcell"
                  aria-selected={selected}
                  aria-label={new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(d)}
                  disabled={unavailable}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => choose(d)}
                  className={cn(
                    'grid h-9 place-items-center rounded-xl text-sm tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    selected ? 'accent-gloss font-semibold' : 'hover:bg-surface-2',
                    !selected && outside && 'text-faint',
                    !selected && sameDay(d, today) && 'font-semibold text-accent-ink',
                    unavailable && 'pointer-events-none opacity-30',
                  )}
                >
                  {d.getDate()}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      <div className="mt-4 space-y-2">
        <label className="flex items-center gap-2.5 text-sm">
          <Clock className="size-4 text-muted" aria-hidden />
          <span className="w-10 text-muted">Time</span>
          <input
            type="time"
            step={300}
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="h-9 flex-1 rounded-xl border border-line bg-surface px-3 text-sm tabular-nums outline-none focus:border-accent/40 focus:ring-4 focus:ring-accent/10"
          />
        </label>
        <div className="flex flex-wrap gap-1.5 pl-[4.25rem]" role="group" aria-label="Quick times">
          {QUICK_TIMES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTime(t)}
              aria-pressed={time === t}
              className={cn(
                'h-7 rounded-full px-2.5 text-xs tabular-nums ring-1 transition-colors',
                time === t ? 'bg-accent-soft text-accent-ink ring-accent/30' : 'text-muted ring-line hover:bg-surface-2',
              )}
            >
              {new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(2024, 0, 1, Number(t.slice(0, 2)), 0))}
            </button>
          ))}
        </div>
        <p className="pl-[4.25rem] text-[11px] text-faint">Times are in {zone.replace(/_/g, ' ')}</p>
      </div>

      <footer className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-4">
        <p className={cn('text-sm', past ? 'text-rose-600 dark:text-rose-400' : 'text-muted')} aria-live="polite">
          {past ? 'Choose a time that’s still to come.' : summary}
        </p>
        <Button variant="primary" size="sm" disabled={past} onClick={() => onConfirm(at)}>
          {confirmLabel}
        </Button>
      </footer>
    </div>
  )
}
