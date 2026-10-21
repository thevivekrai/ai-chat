import { addDays, atTime, startOfDay } from '@/lib/time'

/**
 * Finds a date/time mention in a message and resolves it against the time the message was sent.
 * Understands the phrasing in the demo chats: weekdays ("by Friday"), "today / tonight / tomorrow /
 * day after tomorrow", "EOD", "in about 3 weeks", "this weekend", "next week", clock times
 * ("5:30 PM") and Hinglish ("kal", "aaj", "parso", "subah 5 baje").
 *
 * This stands in for the date handling a real model would do; see buildTasksPrompt().
 */
export interface DateMention {
  /** Exact words that set the date, in order of appearance (e.g. ["kal", "11 baje"]). */
  phrases: string[]
  /** Resolved moment, ms since epoch. */
  at: number
  /** Whether a time of day was stated or implied ("tonight", "EOD"). */
  hasTime: boolean
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }

interface Span {
  index: number
  text: string
}

interface DayMatch extends Span {
  day: number
  defaultTime?: [number, number]
}

interface TimeMatch extends Span {
  hour: number
  minute: number
  /** Meal words imply a time but are not a date on their own. */
  soft?: boolean
}

function firstMatch(text: string, re: RegExp): (RegExpExecArray & { span: Span }) | null {
  const m = re.exec(text.toLowerCase())
  if (!m) return null
  return Object.assign(m, { span: { index: m.index, text: text.slice(m.index, m.index + m[0].length) } })
}

function nextWeekday(ref: number, weekday: number): number {
  const delta = (weekday - new Date(ref).getDay() + 7) % 7
  return addDays(startOfDay(ref), delta)
}

function findDay(text: string, ref: number): DayMatch | null {
  const today = startOfDay(ref)
  const found: DayMatch[] = []
  const add = (re: RegExp, resolve: (m: RegExpExecArray) => Omit<DayMatch, keyof Span>) => {
    const m = firstMatch(text, re)
    if (m) found.push({ ...m.span, ...resolve(m) })
  }

  add(/\b(day after tomorrow|parson|parso)\b/, () => ({ day: addDays(today, 2) }))
  add(/\b(tomorrow|tmrw|kal)\b/, () => ({ day: addDays(today, 1) }))
  add(/\b(today|aaj)\b/, () => ({ day: today }))
  add(/\btonight\b/, () => ({ day: today, defaultTime: [21, 0] }))
  add(new RegExp(`\\b(${WEEKDAYS.join('|')})\\b`), (m) => ({ day: nextWeekday(ref, WEEKDAYS.indexOf(m[1])) }))
  add(/\bend of (?:the |this )?week\b/, () => ({ day: nextWeekday(ref, 5), defaultTime: [18, 0] }))
  add(/\b(?:this )?weekend\b/, () => ({ day: nextWeekday(ref, 6), defaultTime: [10, 0] }))
  add(/\bnext week\b/, () => ({ day: nextWeekday(addDays(ref, 1), 1) }))
  add(/\bin (?:about |around |roughly )?(\d+|an?|one|two|three|four|five|six) (day|week)s?\b/, (m) => {
    const n = Number(m[1]) || NUMBER_WORDS[m[1]] || 1
    return { day: addDays(today, m[2] === 'week' ? n * 7 : n) }
  })

  found.sort((a, b) => a.index - b.index)
  return found[0] ?? null
}

function findTime(text: string): TimeMatch | null {
  let m = firstMatch(text, /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/)
  if (m) {
    const hour = (Number(m[1]) % 12) + (m[3] === 'pm' ? 12 : 0)
    return { ...m.span, hour, minute: Number(m[2] ?? 0) }
  }
  m = firstMatch(text, /\b(?:(subah|morning|dopahar|afternoon|shaam|evening|raat|night)\s+)?(\d{1,2})(?::(\d{2}))?\s*baje\b/)
  if (m) {
    let hour = Number(m[2])
    const part = m[1]
    const later = part && !['subah', 'morning'].includes(part)
    if (hour < 12 && (later || (!part && hour <= 6))) hour += 12
    return { ...m.span, hour, minute: Number(m[3] ?? 0) }
  }
  m = firstMatch(text, /\b(eod|end of (?:the )?day)\b/)
  if (m) return { ...m.span, hour: 18, minute: 0 }
  m = firstMatch(text, /\bnoon\b/)
  if (m) return { ...m.span, hour: 12, minute: 0 }
  m = firstMatch(text, /\blunch\b/)
  if (m) return { ...m.span, hour: 13, minute: 0, soft: true }
  m = firstMatch(text, /\bdinner\b/)
  if (m) return { ...m.span, hour: 20, minute: 0, soft: true }
  return null
}

export function findDateMention(text: string, sentAt: number): DateMention | null {
  const day = findDay(text, sentAt)
  const time = findTime(text)
  if (!day && (!time || time.soft)) return null

  const [hour, minute] = time ? [time.hour, time.minute] : (day?.defaultTime ?? [9, 0])
  let at = atTime(day ? day.day : sentAt, hour, minute)
  // A bare time ("files by noon") that has already passed means the next day.
  if (!day && at <= sentAt) at = addDays(at, 1)

  const spans = [day, time && !time.soft ? time : null].filter((s): s is DayMatch | TimeMatch => !!s)
  spans.sort((a, b) => a.index - b.index)
  return {
    phrases: spans.map((s) => s.text),
    at,
    hasTime: !!time || !!day?.defaultTime,
  }
}
