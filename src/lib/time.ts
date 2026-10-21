export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

export const toMs = (iso: string) => new Date(iso).getTime()

export function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Calendar-day difference (b - a), ignoring time of day and DST shifts. */
export function dayDiff(a: number, b: number): number {
  return Math.round((startOfDay(b) - startOfDay(a)) / DAY)
}

export function addDays(ts: number, days: number): number {
  const d = new Date(ts)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

/** Same calendar day as `ts`, at the given local time. */
export function atTime(ts: number, hours: number, minutes = 0): number {
  const d = new Date(ts)
  d.setHours(hours, minutes, 0, 0)
  return d.getTime()
}

/** Compact duration: "now", "12m", "5h", "3d", "2w". */
export function formatDuration(ms: number): string {
  if (ms < MINUTE) return 'now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`
  if (ms < 14 * DAY) return `${Math.floor(ms / DAY)}d`
  return `${Math.floor(ms / (7 * DAY))}w`
}

/** Long-form duration for sentences: "3 days", "5 hours", "12 minutes". */
export function formatDurationLong(ms: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`
  if (ms < HOUR) return plural(Math.max(1, Math.floor(ms / MINUTE)), 'minute')
  if (ms < DAY) return plural(Math.floor(ms / HOUR), 'hour')
  return plural(Math.floor(ms / DAY), 'day')
}

/** Time-ago label for list rows: "now", "12m", "5h", "3d", or "Oct 12" when older. */
export function formatAgo(iso: string, now: number): string {
  const ms = now - toMs(iso)
  if (ms < 7 * DAY) return formatDuration(Math.max(0, ms))
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function formatClock(iso: string | number): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** Day separator label: "Today", "Yesterday", "Monday, Oct 19". */
export function formatDayLabel(iso: string, now: number): string {
  const diff = dayDiff(toMs(iso), now)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

/**
 * Human label for a future (or overdue) moment: "Today 6:00 PM", "Tomorrow", "Fri 10:00 AM",
 * "Oct 30". Times at exactly 09:00 are treated as "no specific time" and omitted.
 */
export function formatWhen(iso: string, now: number, opts: { withTime?: boolean } = {}): string {
  const ts = toMs(iso)
  const d = new Date(ts)
  const diff = dayDiff(now, ts)
  const showTime = opts.withTime ?? !(d.getHours() === 9 && d.getMinutes() === 0)
  const time = showTime ? ` ${formatClock(iso)}` : ''
  if (diff === 0) return `Today${time}`
  if (diff === 1) return `Tomorrow${time}`
  if (diff === -1) return `Yesterday${time}`
  if (diff > 1 && diff < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })}${time}`
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${time}`
}

/** Compact hint for time pickers: "9:30 PM" today, otherwise "Thu 9:00 AM". */
export function formatShortWhen(ts: number, now: number): string {
  const clock = formatClock(ts)
  if (dayDiff(now, ts) === 0) return clock
  return `${new Date(ts).toLocaleDateString(undefined, { weekday: 'short' })} ${clock}`
}

export function weekdayName(ts: number): string {
  return WEEKDAYS[new Date(ts).getDay()]
}
