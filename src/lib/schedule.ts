import { addDays, atTime, HOUR, MINUTE } from './time'

export interface TimeOption {
  id: string
  label: string
  at: Date
}

function nextWeekday(now: number, weekday: number, hours: number): number {
  const d = new Date(now)
  const delta = (weekday - d.getDay() + 7) % 7 || 7
  return atTime(addDays(now, delta), hours)
}

/** Round up to the next half hour so options read as "4:30 PM", not "4:17 PM". */
function roundUp(ts: number): number {
  const step = 30 * MINUTE
  return Math.ceil(ts / step) * step
}

export function snoozeOptions(now: number = Date.now()): TimeOption[] {
  const hour = new Date(now).getHours()
  const day = new Date(now).getDay()
  const options: TimeOption[] = []
  if (hour < 18) options.push({ id: 'later', label: 'Later today', at: new Date(roundUp(now + 3 * HOUR)) })
  options.push({ id: 'tomorrow', label: 'Tomorrow morning', at: new Date(atTime(addDays(now, 1), 9)) })
  if (day >= 1 && day <= 4) options.push({ id: 'weekend', label: 'This weekend', at: new Date(nextWeekday(now, 6, 10)) })
  options.push({ id: 'next-week', label: 'Next week', at: new Date(nextWeekday(now, 1, 9)) })
  return options
}

export function sendLaterOptions(now: number = Date.now()): TimeOption[] {
  const hour = new Date(now).getHours()
  const options: TimeOption[] = [{ id: 'hour', label: 'In 1 hour', at: new Date(roundUp(now + HOUR)) }]
  if (hour < 18) options.push({ id: 'evening', label: 'This evening', at: new Date(atTime(now, 19)) })
  options.push({ id: 'morning', label: 'Tomorrow morning', at: new Date(atTime(addDays(now, 1), 9)) })
  options.push({ id: 'monday', label: 'Monday morning', at: new Date(nextWeekday(now, 1, 9)) })
  return options
}
