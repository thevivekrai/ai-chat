import { describe, expect, it } from 'vitest'
import { findDateMention } from './dates'

// Tuesday 20 Oct 2026, 10:00 local time.
const SENT = new Date(2026, 9, 20, 10, 0).getTime()

function resolve(text: string) {
  const mention = findDateMention(text, SENT)
  if (!mention) return null
  const d = new Date(mention.at)
  return { date: `${d.getMonth() + 1}/${d.getDate()}`, time: `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`, phrases: mention.phrases }
}

describe('findDateMention', () => {
  it('resolves weekdays to the next occurrence after the message', () => {
    expect(resolve('Can you send the invoice by Friday?')).toMatchObject({ date: '10/23', time: '9:00' })
    expect(resolve('Please confirm by Tuesday')).toMatchObject({ date: '10/20' })
  })

  it('combines a day with a time', () => {
    expect(resolve('confirmed for Thursday at 5:30 PM')).toMatchObject({ date: '10/22', time: '17:30' })
    expect(resolve('Need your feedback by tomorrow EOD')).toMatchObject({
      date: '10/21',
      time: '18:00',
      phrases: ['tomorrow', 'EOD'],
    })
  })

  it('understands Hinglish', () => {
    expect(resolve('Sir kal pickup ke liye 11 baje aaunga')).toMatchObject({
      date: '10/21',
      time: '11:00',
      phrases: ['kal', '11 baje'],
    })
    expect(resolve('Subah 5 baje Dadar se nikalte hain')).toMatchObject({ time: '5:00' })
    expect(resolve('shaam 7 baje milte hain')).toMatchObject({ time: '19:00' })
  })

  it('handles relative spans and evenings', () => {
    expect(resolve("We'd need them in about 3 weeks")).toMatchObject({ date: '11/10' })
    expect(resolve('Need to know by tonight')).toMatchObject({ date: '10/20', time: '21:00' })
    expect(resolve('is Sunday lunch pe aa rahe ho na?')).toMatchObject({ date: '10/25', time: '13:00', phrases: ['Sunday'] })
  })

  it('ignores text without a date', () => {
    expect(resolve('Same day works')).toBeNull()
    expect(resolve('Lunch was great')).toBeNull()
    expect(resolve('Kala Ghoda pop-up final count: 41 pieces sold')).toBeNull()
  })

  it('reads calendar dates: "5 Nov", "Nov 5", "5th November", "the 1st"', () => {
    const ref = new Date(2026, 9, 30, 10, 0).getTime()
    const nov5 = new Date(2026, 10, 5).toDateString()
    for (const text of ['due on 5 Nov', 'due on Nov 5', 'by 5th November']) {
      expect(new Date(findDateMention(text, ref)!.at).toDateString(), text).toBe(nov5)
    }
    // A day of the month that has gone by is next month's; a date that has gone by, next year's.
    expect(new Date(findDateMention('rent is due on the 1st', ref)!.at).toDateString()).toBe(new Date(2026, 10, 1).toDateString())
    expect(new Date(findDateMention('see you on 2 Jan', ref)!.at).getFullYear()).toBe(2027)
    // "may" as a word isn't May.
    expect(findDateMention('may 2 people come along?', ref)).toBeNull()
  })
})
