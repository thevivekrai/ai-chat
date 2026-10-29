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
  beforeEach(() => setAiAccessPolicy(() => true))

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

  /** The tags the demo AI would use: sure enough, most sure first, at most three. */
  const used = async (t: ReturnType<typeof chat>) => (await classifyPriority(t)).labels ?? []

  it('tags what a chat is about', async () => {
    expect(await used(chat([['them', 'Can you send the invoice for the order by Friday?', 5]]))).toEqual(
      expect.arrayContaining(['payment', 'order']),
    )
    expect(await used(chat([['them', 'Any update on my parcel?', 20], ['them', '??', 5]]))).toEqual(
      expect.arrayContaining(['follow-up', 'order']),
    )
    const promo = chat([['them', 'Flat 50% off this weekend! Use coupon SAVE50', 5]], {
      participants: [{ id: 'ravi', name: 'ShopCo', label: 'Automated' }],
    })
    expect(await used(promo)).toContain('promo')
    expect(await used(chat([['them', 'Dinner is at 8, see you there', 5]]))).toContain('meeting')
  })

  it('weighs every tag rather than taking the first rules that match', async () => {
    // Asked, chased and dated — but plainly about money: payment isn't crowded out.
    const tags = await used(chat([['them', 'Hi?? the invoice payment of ₹4,500 is due tomorrow, refund the rest?', 5]]))
    expect(tags).toContain('payment')
    expect(tags.length).toBeLessThanOrEqual(3)
  })

  it('tags the new kinds of chat', async () => {
    expect(await used(chat([['them', 'Your flight ticket and hotel booking for Goa are confirmed', 5]]))).toContain('travel')
    expect(await used(chat([['them', 'Doctor appointment moved, bring your test results', 5]]))).toContain('health')
    expect(await used(chat([['them', 'Salary credited, EMI and loan statement attached', 5]]))).toContain('finance')
  })

  it('leaves a chat untagged when nothing is sure', async () => {
    // Small talk: nothing clearly applies, so nothing is guessed.
    expect(await used(chat([['them', 'haha nice', 5]]))).toEqual([])
    // Everything considered is still kept for "why this tag?", with how sure it was.
    const calls = heuristicLabels(chat([['them', 'Can you send it by Friday?', 5]]))
    expect(calls.every((c) => c.confidence >= 0 && c.confidence <= 1 && !!c.why)).toBe(true)
  })

  it('gives the same tags for the same chat, every time', async () => {
    const t = chat([['them', 'Can you send the invoice for the order by Friday?', 5]])
    const [a, b] = [await classifyPriority(t), await classifyPriority(t)]
    expect(a.labels).toEqual(b.labels)
    expect(a.audit?.promptHash).toBe(b.audit?.promptHash)
    expect(a.audit?.model).toBe('demo')
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

  it('uses only tags the model is sure of, and only ones that exist', async () => {
    answer({
      priority: 'normal',
      expectsReply: true,
      reason: 'Priya asked about a payment.',
      labels: [
        { tag: 'payment', confidence: 0.92, why: 'asks about the invoice' },
        { tag: 'meeting', confidence: 0.4, why: 'mentions next week' },
        { tag: 'made-up', confidence: 0.99 },
        { tag: 'question', confidence: 0.7 },
      ],
    })
    const result = await classifyPriority(chat([['them', 'Did you pay the invoice? Maybe meet next week', 2]]))
    expect(result.labels).toEqual(['payment', 'question'])
    // The unsure one is kept for "why this tag?", not used; the made-up one is gone entirely.
    expect(result.labelCalls?.map((c) => c.tag)).toEqual(['payment', 'question', 'meeting'])
    expect(result.labelCalls?.[0]).toMatchObject({ why: 'asks about the invoice' })
  })

  it('is untagged when the model is sure of nothing', async () => {
    answer({ priority: 'low', expectsReply: false, reason: 'Small talk.', labels: [{ tag: 'fyi', confidence: 0.3 }] })
    expect((await classifyPriority(chat([['them', 'haha', 2]]))).labels).toEqual([])
  })

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
