import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyPriority, setAiAccessPolicy, setLlmConfig, type AiThread } from '.'
import { heuristicLabels, heuristicPriority } from './mock/heuristics'

const now = Date.now()
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString()

function chat(messages: [from: 'me' | 'them', body: string, minutesAgo: number][], extra: Partial<AiThread> = {}): AiThread {
  return {
    id: 'wa:t1',
    title: 'Ravi Kumar',
    network: 'whatsapp',
    isGroup: false,
    me: { name: 'Aarav Mehta' },
    participants: [{ id: 'ravi', name: 'Ravi Kumar' }],
    messages: messages.map(([from, body, minutes], i) => ({
      id: `m${i}`,
      senderId: from === 'me' ? 'me' : 'ravi',
      senderName: from === 'me' ? 'Aarav Mehta' : 'Ravi Kumar',
      fromMe: from === 'me',
      body,
      sentAt: ago(minutes),
    })),
    ...extra,
  }
}

describe('urgency rules (demo AI)', () => {
  it('sees someone chasing, saying it is urgent, or money at stake', () => {
    expect(heuristicPriority(chat([['them', 'Did you get the files?', 90], ['them', 'Hello??', 30]]), now).priority).toBe('urgent')
    expect(heuristicPriority(chat([['them', 'Bhai jaldi call karo', 5]]), now).priority).toBe('urgent')
    expect(heuristicPriority(chat([['them', 'My payment failed, can you check?', 5]]), now).priority).toBe('urgent')
    expect(heuristicPriority(chat([['them', 'Send it whenever, no rush. Not urgent', 5]]), now).priority).not.toBe('urgent')
    // A plain question, just asked: a reply is expected, but nothing presses.
    expect(heuristicPriority(chat([['them', 'What colour do you prefer?', 5]]), now)).toMatchObject({ priority: 'normal', expectsReply: true })
    // A question left for days.
    expect(heuristicPriority(chat([['them', 'Can you send the catalogue?', 60 * 24 * 3]]), now).priority).toBe('urgent')
  })

  it('tags what a chat is about', () => {
    expect(heuristicLabels(chat([['them', 'Can you send the invoice for the order by Friday?', 5]]))).toEqual(['question', 'deadline', 'payment'])
    expect(heuristicLabels(chat([['them', 'Any update on my parcel?', 20], ['them', '??', 5]]))).toEqual(
      expect.arrayContaining(['follow-up', 'order']),
    )
    const promo = chat([['them', 'Flat 50% off this weekend! Use coupon SAVE50', 5]], {
      participants: [{ id: 'ravi', name: 'ShopCo', label: 'Automated' }],
    })
    expect(heuristicLabels(promo)).toEqual(['promo'])
    expect(heuristicLabels(chat([['them', 'Dinner is at 8, see you there', 5]]))).toContain('meeting')
  })
})

describe('with a real AI', () => {
  beforeEach(() => {
    setAiAccessPolicy(() => true)
    setLlmConfig({ provider: 'shared' })
  })
  afterEach(() => {
    setLlmConfig(null)
    vi.unstubAllGlobals()
  })

  const answer = (output: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ output }), { status: 200 })))

  it('never shows someone who says it is urgent as normal', async () => {
    answer({ priority: 'normal', expectsReply: true, reason: 'Ravi asked something.', labels: ['question'] })
    expect(await classifyPriority(chat([['them', 'Urgent: please call me, the truck is here', 2]]))).toMatchObject({
      priority: 'urgent',
      labels: ['question'],
    })
    // Unless they say it isn't.
    expect((await classifyPriority(chat([['them', 'Not urgent, but can you check?', 2]]))).priority).toBe('normal')
  })

  it("leaves a group's urgent message alone when it isn't for the user", async () => {
    answer({ priority: 'low', expectsReply: false, reason: 'Group chatter.', labels: [] })
    const group = chat([['them', 'Urgent: whoever has the keys, call Neha', 2]], { isGroup: true })
    expect((await classifyPriority(group)).priority).toBe('low')
  })
})
