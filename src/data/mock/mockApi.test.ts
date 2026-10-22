import { describe, expect, it } from 'vitest'
import { HOUR } from '@/lib/time'
import type { InboxEvent } from '../types'
import { createMockApi } from './mockApi'

async function freshApi() {
  const api = createMockApi()
  await api.demo!.reset()
  return api
}

describe('mock api', () => {
  it('persists sent messages for the next session', async () => {
    const api = await freshApi()
    const sent = await api.sendMessage('rohan', 'A set of 6 is ₹2,400 🙂')
    const nextSession = await createMockApi().loadInbox()
    expect(nextSession.messages.find((m) => m.id === sent.id)?.body).toBe('A set of 6 is ₹2,400 🙂')
  })

  it('brings a snoozed chat back when a new message arrives', async () => {
    const api = await freshApi()
    await api.updateThreadState('rohan', { snoozedUntil: new Date(Date.now() + HOUR).toISOString() })
    const events: InboxEvent[] = []
    const unsubscribe = api.subscribe((e) => events.push(e))
    const incoming = await api.demo!.simulateIncoming()
    unsubscribe()

    expect(incoming?.threadId).toBe('rohan')
    // They're seen typing first, then the message arrives.
    expect(events.map((e) => e.type)).toEqual(['typing', 'typing', 'message.created', 'thread.updated'])
    expect(events[0]).toMatchObject({ type: 'typing', threadId: 'rohan', active: true })
    expect(events[1]).toMatchObject({ type: 'typing', threadId: 'rohan', active: false })
    const thread = (await api.loadInbox()).threads.find((t) => t.id === 'rohan')
    expect(thread).toMatchObject({ snoozedUntil: null, unreadCount: 3 })
  })

  it('replies with a quote, and keeps one reaction per person', async () => {
    const api = await freshApi()
    const reply = await api.sendMessage('divya', 'Haan, Sunday pakka!', { replyToId: 'divya-3' })
    expect(reply.replyTo).toMatchObject({ id: 'divya-3', senderId: 'c-divya' })

    const liked = await api.react('divya', 'divya-3', '👍')
    expect(liked.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }])
    const loved = await api.react('divya', 'divya-3', '❤️')
    expect(loved.reactions).toEqual([{ emoji: '❤️', count: 1, mine: true }])
    const removed = await api.react('divya', 'divya-3', null)
    expect(removed.reactions).toBeUndefined()

    const seeded = (await api.loadInbox()).messages.find((m) => m.id === 'divya-4')
    expect(seeded?.replyTo).toMatchObject({ id: 'divya-3', senderId: 'c-divya' })
    expect(api.capabilities('divya')).toEqual({ reply: true, react: true, typing: true, history: false })
  })

  it('sends scheduled messages once they are due', async () => {
    const api = await freshApi()
    const item = await api.scheduleMessage('divya', 'Pakka aa raha hoon!', new Date(Date.now() - 1000).toISOString())
    const snapshot = await api.loadInbox()
    expect(snapshot.scheduled.map((s) => s.id)).not.toContain(item.id)
    expect(snapshot.messages.some((m) => m.threadId === 'divya' && m.body === 'Pakka aa raha hoon!')).toBe(true)
  })

  it('keeps future scheduled messages queued', async () => {
    const snapshot = await (await freshApi()).loadInbox()
    expect(snapshot.scheduled.map((s) => s.threadId)).toEqual(['arjun'])
  })
})
