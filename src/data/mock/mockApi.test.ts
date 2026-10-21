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
    expect(events.map((e) => e.type)).toEqual(['message.created', 'thread.updated'])
    const thread = (await api.loadInbox()).threads.find((t) => t.id === 'rohan')
    expect(thread).toMatchObject({ snoozedUntil: null, unreadCount: 3 })
  })

  it('sends scheduled messages once they are due', async () => {
    const api = await freshApi()
    const item = await api.scheduleMessage('maa', 'Pakka aa raha hoon!', new Date(Date.now() - 1000).toISOString())
    const snapshot = await api.loadInbox()
    expect(snapshot.scheduled.map((s) => s.id)).not.toContain(item.id)
    expect(snapshot.messages.some((m) => m.threadId === 'maa' && m.body === 'Pakka aa raha hoon!')).toBe(true)
  })

  it('keeps future scheduled messages queued', async () => {
    const snapshot = await (await freshApi()).loadInbox()
    expect(snapshot.scheduled.map((s) => s.threadId)).toEqual(['arjun'])
  })
})
