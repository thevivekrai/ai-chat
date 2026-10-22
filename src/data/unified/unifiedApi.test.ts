import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TELEGRAM_API } from '../connectors/telegram/botApi'
import { readJson, storage, writeJson } from '../storage'
import type { InboxEvent } from '../types'
import { eventually, installFakeTelegram } from '@/test/fakeTelegram'
import { CONFIG_KEY, LOCAL_KEY, type LocalState } from './persisted'
import { createUnifiedApi } from './unifiedApi'

let telegram: ReturnType<typeof installFakeTelegram>
let stop: (() => void) | null = null

function start(config: { demo: boolean; telegram?: boolean }) {
  writeJson(CONFIG_KEY, {
    demo: config.demo,
    ...(config.telegram ? { telegram: { token: telegram.token, apiBase: DEFAULT_TELEGRAM_API } } : {}),
  })
  const api = createUnifiedApi()
  const events: InboxEvent[] = []
  stop = api.subscribe((e) => events.push(e))
  return { api, events }
}

/** Has a Telegram customer write in, and waits until the inbox has seen it. */
async function customerWrites(events: InboxEvent[], text = 'Is the indigo planter still available?') {
  const priya = telegram.person(42, 'Priya', { last_name: 'Nair' })
  telegram.message(telegram.privateChat(priya), priya, { text })
  await eventually(() =>
    expect(events.some((e) => e.type === 'message.created' && e.message.body === text)).toBe(true),
  )
}

beforeEach(() => {
  for (const key of [CONFIG_KEY, LOCAL_KEY, 'tidings.telegram', 'tidings.mockdb']) storage.remove(key)
  telegram = installFakeTelegram()
})

afterEach(() => {
  stop?.()
  stop = null
  vi.unstubAllGlobals()
})

describe('unified inbox', () => {
  it('merges the demo inbox with a connected account', async () => {
    const { api, events } = start({ demo: true, telegram: true })
    await customerWrites(events)

    const inbox = await api.loadInbox()
    expect(inbox.threads.filter((t) => t.network === 'telegram' && t.id.startsWith('tg:'))).toHaveLength(1)
    expect(inbox.threads.length).toBe(16)
    expect(inbox.me.name).toBe('Aarav') // the demo persona, while the demo is on
    expect(api.connections.get()).toMatchObject({ demo: true, telegram: { state: 'online' }, matrix: null })
  })

  it('shows only real chats once the demo is off', async () => {
    const { api, events } = start({ demo: false, telegram: true })
    await customerWrites(events)
    const inbox = await api.loadInbox()
    expect(inbox.threads.map((t) => t.id)).toEqual(['tg:42'])
    expect(inbox.me.name).toBe('Mitti Studio')
  })

  it('routes replies to the right network', async () => {
    const { api, events } = start({ demo: true, telegram: true })
    await customerWrites(events)

    await api.sendMessage('tg:42', 'Yes! ₹2,850 for the set')
    expect(telegram.sent).toEqual([{ chat_id: '42', text: 'Yes! ₹2,850 for the set' }])

    const demoReply = await api.sendMessage('priya', 'On its way')
    expect(demoReply.threadId).toBe('priya')
    expect(telegram.sent).toHaveLength(1)
  })

  it('keeps done and snoozed state on this device, and wakes snoozed chats on new messages', async () => {
    const { api, events } = start({ demo: false, telegram: true })
    await customerWrites(events)

    const until = new Date(Date.now() + 86_400_000).toISOString()
    expect(await api.updateThreadState('tg:42', { snoozedUntil: until })).toMatchObject({ snoozedUntil: until })
    expect((await api.loadInbox()).threads[0].snoozedUntil).toBe(until)
    expect(readJson<LocalState>(LOCAL_KEY)?.threadState['tg:42'].snoozedUntil).toBe(until)

    await customerWrites(events, 'Hello? Need it by Saturday')
    expect(events).toContainEqual({ type: 'thread.updated', thread: expect.objectContaining({ id: 'tg:42', snoozedUntil: null }) })
  })

  it('sends scheduled replies when due, and holds back ones missed while closed', async () => {
    const first = start({ demo: false, telegram: true })
    await customerWrites(first.events)
    const due = await first.api.scheduleMessage('tg:42', 'Shipping today!', new Date(Date.now() - 1000).toISOString())
    const missed = await first.api.scheduleMessage('tg:42', 'Good morning', new Date(Date.now() - 3 * 3_600_000).toISOString())
    expect(due.id).toMatch(/^ls_/)
    stop?.()

    // Opening the app again runs the scheduler straight away.
    const { events } = start({ demo: false, telegram: true })
    await eventually(() => expect(telegram.sent).toEqual([{ chat_id: '42', text: 'Shipping today!' }]))
    await eventually(() => expect(events).toContainEqual({ type: 'scheduled.removed', scheduledId: due.id }))
    expect(events).toContainEqual({
      type: 'scheduled.updated',
      scheduled: expect.objectContaining({ id: missed.id, error: expect.stringMatching(/app was closed/) }),
    })
  })

  it('searches every source', async () => {
    const { api, events } = start({ demo: true, telegram: true })
    await customerWrites(events, 'What is the price of the indigo planter set?')
    const hits = await api.searchMessages('indigo planter price')
    expect(hits.some((h) => h.threadId === 'tg:42')).toBe(true)
    expect(hits.some((h) => h.threadId === 'priya')).toBe(true)
  })

  it('forgets an account and its chats when disconnected', async () => {
    const { api, events } = start({ demo: true, telegram: true })
    await customerWrites(events)
    await api.updateThreadState('tg:42', { doneAt: new Date().toISOString() })

    await api.connections.disconnect('telegram')

    const inbox = await api.loadInbox()
    expect(inbox.threads.some((t) => t.id.startsWith('tg:'))).toBe(false)
    expect(api.connections.get().telegram).toBeNull()
    expect(storage.get('tidings.telegram')).toBeNull()
    expect(readJson<LocalState>(LOCAL_KEY)?.threadState).toEqual({})
    expect(readJson(CONFIG_KEY)).toEqual({ demo: true })
  })

  it('checks a bot token before connecting', async () => {
    const { api } = start({ demo: true })
    await expect(api.connections.connectTelegram({ token: 'wrong' })).rejects.toThrow(/didn't accept that token/)
    expect(api.connections.get().telegram).toBeNull()

    await api.connections.connectTelegram({ token: telegram.token })
    expect(api.connections.get().telegram).not.toBeNull()
    expect(readJson(CONFIG_KEY)).toMatchObject({ telegram: { token: telegram.token, apiBase: DEFAULT_TELEGRAM_API } })
  })

  it('keeps tasks wherever they come from', async () => {
    const { api } = start({ demo: true })
    const task = await api.addTask({ title: 'Send invoice', dueAt: null, source: { threadId: 'sharma', messageId: 'sharma-3' } })
    expect((await api.loadInbox()).tasks).toEqual([task])
    await api.updateTask(task.id, { done: true })
    expect((await api.loadInbox()).tasks[0].done).toBe(true)

    // A task whose demo chat no longer exists (say, after the demo was regenerated) is hidden.
    await api.addTask({ title: 'Old lunch', dueAt: null, source: { threadId: 'removed-chat', messageId: 'removed-chat-1' } })
    expect((await api.loadInbox()).tasks.map((t) => t.title)).toEqual(['Send invoice'])

    // Resetting the demo regenerates its chats, so tasks pointing into them go too.
    await api.demo?.reset()
    expect((await api.loadInbox()).tasks).toEqual([])
  })
})
