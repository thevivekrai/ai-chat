import { describe, expect, it } from 'vitest'
import { LABEL_CONFIDENCE, type ChatLabel } from '@/data/types'
import { heuristicLabels } from './heuristics'

const now = Date.UTC(2026, 9, 30, 10)

/** The tags the demo AI puts on a chat whose last messages, all theirs, are these. */
function tagsFor(...bodies: string[]): ChatLabel[] {
  return tagsFrom(undefined, ...bodies)
}

/** The same, from a sender Sytext knows as automated (a bank, a shop). */
const automatedTagsFor = (...bodies: string[]) => tagsFrom('Automated', ...bodies)

function tagsFrom(label: string | undefined, ...bodies: string[]): ChatLabel[] {
  const thread = {
    id: 't',
    title: 'Ravi',
    network: 'whatsapp' as const,
    isGroup: false,
    me: { name: 'Aarav' },
    participants: [{ id: 'p', name: 'Ravi', ...(label ? { label } : {}) }],
    messages: bodies.map((body, i) => ({
      id: `m${i}`,
      senderId: 'p',
      senderName: 'Ravi',
      fromMe: false,
      body,
      sentAt: new Date(now - (bodies.length - i) * 60_000).toISOString(),
    })),
  }
  return heuristicLabels(thread, now)
    .filter((c) => c.confidence >= LABEL_CONFIDENCE)
    .map((c) => c.tag)
    .sort()
}

describe('the demo AI’s tags', () => {
  it('puts a deadline only on something that is due, not on any day mentioned', () => {
    expect(tagsFor('Please send the report by Friday')).toEqual(['deadline', 'question', 'work'])
    expect(tagsFor('bhai kal milte hai')).toEqual(['meeting'])
    expect(tagsFor('how was the test today?')).toEqual(['question'])
  })

  it('reads a forward as news, whatever it mentions', () => {
    expect(tagsFor('Forwarded: Petrol prices cut by Rs 2 from tomorrow')).toEqual(['fyi'])
  })

  it('tells a bank alert from a payment asked for', () => {
    expect(tagsFor('Rs. 5,000 debited from A/c XX1234 on 29-Oct. Avl bal Rs 12,340')).toEqual(['finance'])
    expect(tagsFor('Did you pay the invoice?')).toContain('payment')
  })

  it('keeps a delivery an order, not work with a deadline', () => {
    expect(tagsFor('Your order #402-1234 has been shipped and will arrive tomorrow')).toEqual(['order'])
  })

  it('doesn’t take a work report for a medical one', () => {
    expect(tagsFor('Please send the report by Friday')).not.toContain('health')
    expect(tagsFor('Your blood test results are ready')).toContain('health')
  })

  it('knows family and friends by how they write', () => {
    expect(tagsFor('Happy birthday bro!! 🎂')).toEqual(['personal'])
    expect(tagsFor('Beta dinner pe aa rahe ho?')).toContain('personal')
  })

  it('leaves small talk untagged rather than guessing', () => {
    for (const body of ['Good morning! 🌞', 'haha 😂😂', 'ok', 'talk later']) expect(tagsFor(body)).toEqual([])
  })

  it('gets thirty everyday messages right', () => {
    const cases: [ChatLabel[], ChatLabel[]][] = [
      [tagsFor('Hi, can you send the invoice for October?'), ['payment', 'question', 'work']],
      [tagsFor('Can we do the call tomorrow at 11?'), ['meeting', 'question']],
      [tagsFor('Bhaiya 500 rs bhej do UPI pe'), ['payment', 'personal', 'question']],
      [tagsFor('Rent is due on the 1st, please transfer by then'), ['deadline', 'payment', 'question']],
      [tagsFor('Your flight 6E 203 to Goa is confirmed. PNR X7YZ2'), ['travel']],
      [tagsFor('Your appointment with Dr. Mehta is tomorrow at 5 PM'), ['health']],
      [tagsFor('Your refund of Rs 899 has been processed'), ['payment']],
      [automatedTagsFor('Flat 50% off on all shoes! Limited time offer'), ['promo']],
      [automatedTagsFor('482913 is your OTP for login. Do not share.'), []],
      [tagsFor('Who all are coming for dinner Saturday?'), ['meeting', 'question']],
      [tagsFor('Your interview is scheduled for Monday 10am'), ['meeting', 'work']],
      [tagsFor('Need the deck before Friday EOD please'), ['deadline', 'question']],
      [tagsFor('Hello?', 'Any update on this??'), ['follow-up', 'question']],
      [tagsFor('Thanks a lot!'), []],
      [tagsFor('Congratulations on the new job!! 🎉'), ['personal']],
      [tagsFor('Can I exchange this for a size M?'), ['question', 'shopping']],
      [tagsFor('How much for 2 planters?'), ['payment', 'question']],
      [tagsFor('What if we launch the app in Hindi too?'), ['idea', 'question']],
      [tagsFor('No rush, whenever you get a chance can you review my resume'), ['later', 'question']],
      [tagsFor('FYI the office is closed on Monday'), ['fyi', 'work']],
      [automatedTagsFor('Salary credited to your account XX12. Avl bal Rs 52,300'), ['finance']],
      [tagsFor('Sir main gate pe hu, parcel lene aao'), ['order']],
      [tagsFor('You are invited to our wedding on 12 Dec 🙏'), ['personal']],
      [automatedTagsFor('Your EMI of Rs 4,500 is due on 5 Nov'), ['deadline', 'finance']],
      [tagsFor('[Photo]'), []],
      [tagsFor('😂😂😂'), []],
      [tagsFor('Please update the client on the project status today'), ['question', 'work']],
      [tagsFor('Cab to airport booked for 6am'), ['travel']],
      [tagsFor('Khana kha liya?'), ['question']],
      [tagsFor('Happy birthday bro!! 🎂'), ['personal']],
    ]
    for (const [got, want] of cases) expect(got).toEqual(want)
  })
})
