import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Thread } from '@/data/types'

const storage = new Map<string, string>()
const localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
}
vi.stubGlobal('localStorage', localStorage)
vi.stubGlobal('window', { localStorage })
vi.mock('@/data/server/serverApi', () => ({ serverApi: {} }))
vi.mock('@/data/server/deviceStore', () => ({ wipeDeviceStore: vi.fn() }))

// The AI's answer for the next call, or the error it fails with.
let next: () => Promise<unknown>
const calls: string[] = []
vi.mock('@/ai', async (original) => {
  const ai = await original<typeof import('@/ai')>()
  return {
    ...ai,
    canAiRead: () => true,
    classifyPriority: vi.fn(async (thread: { id: string }) => {
      calls.push(thread.id)
      return next()
    }),
  }
})

const { useAi, TAGGING_GAP_MS } = await import('./ai')
const { useInbox } = await import('./inbox')
const { useToasts } = await import('./toasts')
const { LlmError } = await import('@/ai')

const thread: Thread = { id: 't1', network: 'whatsapp', kind: 'direct', title: 'Ravi', participantIds: ['ravi'], unreadCount: 1, doneAt: null, snoozedUntil: null }
const message = (id: string): Message => ({ id, threadId: 't1', senderId: 'ravi', body: 'Did you pay the invoice?', sentAt: new Date().toISOString() })

const setMessages = (...ids: string[]) =>
  useInbox.setState({ threads: { t1: thread }, messages: { t1: ids.map(message) }, contacts: {}, me: { id: 'me', name: 'Aarav' } } as never)

describe('tagging a chat', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    useAi.getState().forgetAll()
    useToasts.setState({ toasts: [] })
    calls.length = 0
  })
  afterEach(() => vi.useRealTimers())

  it('never leaves an old tag on a chat when tagging it again fails', async () => {
    setMessages('m1')
    next = async () => ({ priority: 'urgent', expectsReply: true, reason: 'Invoice', labels: ['payment'] })
    useAi.getState().ensurePriority('t1')
    await vi.runAllTimersAsync()
    expect(useAi.getState().priority.t1?.result?.labels).toEqual(['payment'])

    // A new message, and the AI is down: the priority stays so the list doesn't jump, but the tags
    // were for the chat as it was, so they go — and the user is told, once, without a dialog.
    setMessages('m1', 'm2')
    vi.advanceTimersByTime(TAGGING_GAP_MS)
    next = async () => {
      throw new LlmError('network', "Couldn't reach the AI.")
    }
    useAi.getState().ensurePriority('t1')
    await vi.runAllTimersAsync()
    const entry = useAi.getState().priority.t1!
    expect(entry.status).toBe('error')
    expect(entry.result).toMatchObject({ priority: 'urgent', labels: [] })
    expect(useToasts.getState().toasts.map((t) => t.title)).toEqual(['Tagging skipped'])
  })

  it('tags a busy chat at most once in a while, then catches up with its latest message', async () => {
    next = async () => ({ priority: 'normal', expectsReply: true, reason: '', labels: [] })
    setMessages('m1')
    useAi.getState().ensurePriority('t1')
    await vi.advanceTimersByTimeAsync(0)
    // A burst of messages: none of them starts a call of its own.
    for (const id of ['m2', 'm3', 'm4']) {
      setMessages('m1', ...['m2', 'm3', 'm4'].slice(0, ['m2', 'm3', 'm4'].indexOf(id) + 1))
      useAi.getState().ensurePriority('t1')
    }
    expect(calls).toEqual(['t1'])
    // When the gap is up, the chat as it is now is tagged — once.
    await vi.advanceTimersByTimeAsync(TAGGING_GAP_MS)
    expect(calls).toEqual(['t1', 't1'])
    expect(useAi.getState().priority.t1?.key).toBe('m4')
  })
})
