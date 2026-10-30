import { describe, expect, it } from 'vitest'
import { LABEL_CONFIDENCE, type ChatLabel } from '@/data/types'
import { heuristicLabels } from './heuristics'

const now = Date.UTC(2026, 9, 30, 10)

/** The tags the demo AI puts on a chat whose last messages, all theirs, are these. */
function tagsFor(...bodies: string[]): ChatLabel[] {
  const thread = {
    id: 't',
    title: 'Ravi',
    network: 'whatsapp' as const,
    isGroup: false,
    me: { name: 'Aarav' },
    participants: [{ id: 'p', name: 'Ravi' }],
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
})
