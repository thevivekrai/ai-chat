import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Contact, Message, Thread } from '../types'
import { memoryDeviceStore, openDeviceStore, wipeDeviceStore, type DeviceStore } from './deviceStore'

const RAVI = 'wa:919812345678@s.whatsapp.net'
const ASHA = 'tga:5001'

const thread = (id: string, title: string): Thread => ({
  id,
  network: id.startsWith('wa:') ? 'whatsapp' : 'telegram',
  kind: 'direct',
  title,
  participantIds: [id],
  unreadCount: 0,
  doneAt: null,
  snoozedUntil: null,
})
const contact = (id: string, name: string): Contact => ({ id, name, network: id.startsWith('wa:') ? 'whatsapp' : 'telegram', handle: '' })
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString()
const message = (threadId: string, n: number): Message => ({ id: `${threadId}:${n}`, threadId, senderId: threadId, body: `Message ${n}`, sentAt: at(n) })

beforeEach(async () => {
  await wipeDeviceStore()
})

describe.each([
  ['IndexedDB', () => openDeviceStore('user-1')],
  ['memory', async () => memoryDeviceStore()],
])('the copy of linked chats on this device (%s)', (_name, open: () => Promise<DeviceStore>) => {
  it('keeps chats, contacts and messages, and reads back the latest of each chat', async () => {
    const store = await open()
    store.put({
      threads: [thread(RAVI, 'Ravi'), thread(ASHA, 'Asha')],
      contacts: [contact(RAVI, 'Ravi Kumar')],
      messages: [...Array.from({ length: 10 }, (_, i) => message(RAVI, i + 1)), message(ASHA, 1)],
    })
    await store.flush()

    const copy = await store.load(3)
    expect(copy.threads.map((t) => t.title).sort()).toEqual(['Asha', 'Ravi'])
    expect(copy.contacts).toEqual([contact(RAVI, 'Ravi Kumar')])
    expect(copy.messages.filter((m) => m.threadId === RAVI).map((m) => m.body)).toEqual(['Message 10', 'Message 9', 'Message 8'])
    expect(copy.messages.filter((m) => m.threadId === ASHA)).toHaveLength(1)
  })

  it('pages back through older messages, newest first', async () => {
    const store = await open()
    store.put({ threads: [thread(RAVI, 'Ravi')], messages: Array.from({ length: 10 }, (_, i) => message(RAVI, i + 1)) })
    expect((await store.older(RAVI, at(8), 3)).map((m) => m.body)).toEqual(['Message 7', 'Message 6', 'Message 5'])
    expect((await store.older(RAVI, at(2), 3)).map((m) => m.body)).toEqual(['Message 1'])
    expect(await store.older(RAVI, at(1), 3)).toEqual([])
  })

  it('updates messages in place, and forgets chats with their messages', async () => {
    const store = await open()
    store.put({ threads: [thread(RAVI, 'Ravi'), thread(ASHA, 'Asha')], contacts: [contact(ASHA, 'Asha')], messages: [message(RAVI, 1), message(ASHA, 1)] })
    store.put({ messages: [{ ...message(RAVI, 1), reactions: [{ emoji: '👍', count: 1, mine: true }] }] })
    store.remove({ threadIds: [ASHA], contactIds: [ASHA] })
    await store.flush()

    const copy = await store.load(10)
    expect(copy.threads.map((t) => t.id)).toEqual([RAVI])
    expect(copy.contacts).toEqual([])
    expect(copy.messages).toEqual([{ ...message(RAVI, 1), reactions: [{ emoji: '👍', count: 1, mine: true }] }])
    expect(await store.older(ASHA, at(59), 10)).toEqual([])
  })
})

describe('the IndexedDB copy', () => {
  it('lasts from one session to the next, for the same person only', async () => {
    const first = await openDeviceStore('user-1')
    first.put({ threads: [thread(RAVI, 'Ravi')], messages: [message(RAVI, 1)] })
    await first.flush()

    expect((await (await openDeviceStore('user-1')).load(10)).messages).toHaveLength(1)
    // Someone else signing in on this device never sees it.
    expect(await (await openDeviceStore('user-2')).load(10)).toEqual({ threads: [], contacts: [], messages: [] })
  })

  it('is deleted on sign-out', async () => {
    const store = await openDeviceStore('user-1')
    store.put({ threads: [thread(RAVI, 'Ravi')], messages: [message(RAVI, 1)] })
    await store.clear()
    expect((await (await openDeviceStore('user-1')).load(10)).threads).toEqual([])
  })
})
