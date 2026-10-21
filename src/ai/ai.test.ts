import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAnswerSources } from '@/store/aiInput'
import { searchMessages } from '@/data/mock/search'
import { NOW, aiThread, seedState } from '@/test/fixtures'
import {
  AiAccessError,
  TONES,
  answerQuestion,
  classifyPriority,
  draftReply,
  extractTasks,
  setAiAccessPolicy,
  summarizeThread,
} from '.'
import { heuristicExpectsReply } from './mock/heuristics'

const THREAD_IDS = Object.keys(seedState().threads)

const myReply = (body: string) => ({
  id: 'my-reply',
  senderId: 'me',
  senderName: 'Aarav',
  fromMe: true,
  body,
  sentAt: new Date(NOW).toISOString(),
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  setAiAccessPolicy(() => true)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('privacy gate', () => {
  it('refuses threads the user has not allowed', async () => {
    setAiAccessPolicy((id) => id !== 'maa')
    await expect(summarizeThread(aiThread('maa'))).rejects.toBeInstanceOf(AiAccessError)
    await expect(draftReply(aiThread('maa'), 'short')).rejects.toBeInstanceOf(AiAccessError)
    await expect(summarizeThread(aiThread('rohan'))).resolves.toBeTruthy()
  })
})

describe('classifyPriority', () => {
  it('ranks the demo threads', async () => {
    const results = Object.fromEntries(
      await Promise.all(THREAD_IDS.map(async (id) => [id, await classifyPriority(aiThread(id))] as const)),
    )
    expect(results.brewbay).toMatchObject({ priority: 'urgent', expectsReply: true })
    expect(results.brewbay.reason).toContain('3 days')
    expect(results.sharma.reason).toContain('tomorrow')
    expect(results.landlord).toMatchObject({ priority: 'low', expectsReply: false })
    expect(results.arjun.expectsReply).toBe(false)
  })

  it('agrees with the on-device rules about who expects a reply', async () => {
    for (const id of THREAD_IDS) {
      const thread = aiThread(id)
      expect((await classifyPriority(thread)).expectsReply, id).toBe(heuristicExpectsReply(thread))
    }
  })

  it('stops treating a thread as urgent once I have replied', async () => {
    const thread = aiThread('priya')
    thread.messages.push(myReply('On it, checking with the courier now!'))
    expect(await classifyPriority(thread)).toMatchObject({ priority: 'normal', expectsReply: false })
  })

  it('falls back to reading the thread once it changes', async () => {
    const thread = aiThread('rohan')
    thread.messages.push({ ...thread.messages[0], id: 'new', body: 'Hello?? any update, need it urgently', sentAt: new Date(NOW).toISOString() })
    expect(await classifyPriority(thread)).toMatchObject({ priority: 'urgent', expectsReply: true })
  })
})

describe('summarizeThread', () => {
  it('summarises every thread in one line without template leftovers', async () => {
    for (const id of THREAD_IDS) {
      const { oneLine } = await summarizeThread(aiThread(id))
      expect(oneLine.length, id).toBeGreaterThan(20)
      expect(oneLine, id).not.toMatch(/undefined|NaN|\$\{/)
    }
  })

  it('gives key points for the group chat', async () => {
    const { oneLine, bullets } = await summarizeThread(aiThread('trek'))
    expect(oneLine).toContain('Saturday')
    expect(bullets.length).toBeGreaterThanOrEqual(3)
  })
})

describe('extractTasks', () => {
  it('finds "send invoice by Friday" with a due date', async () => {
    const tasks = await extractTasks(aiThread('neha'))
    const invoice = tasks.find((t) => /invoice/i.test(t.title))
    expect(invoice).toBeTruthy()
    expect(new Date(invoice!.dueAt!).getDay()).toBe(5)
    expect(invoice!.dueText).toBe('Friday')
  })

  it('handles Hinglish times', async () => {
    const [pickup] = await extractTasks(aiThread('courier'))
    expect(new Date(pickup.dueAt!).getHours()).toBe(11)
  })

  it("doesn't turn my own replies into tasks", async () => {
    const thread = aiThread('priya')
    thread.messages.push(myReply("I'll make sure the planters reach you before Saturday"))
    const tasks = await extractTasks(thread)
    expect(tasks.map((t) => t.sourceMessageId)).not.toContain('my-reply')
  })
})

describe('draftReply', () => {
  it('drafts all three tones for every thread', async () => {
    for (const id of THREAD_IDS) {
      for (const tone of TONES) {
        const { text } = await draftReply(aiThread(id), tone)
        expect(text.length, `${id}/${tone}`).toBeGreaterThan(2)
        expect(text, `${id}/${tone}`).not.toMatch(/undefined|NaN|\$\{/)
      }
    }
  })

  it('offers a different wording on regenerate', async () => {
    const thread = aiThread('priya')
    expect((await draftReply(thread, 'friendly', 1)).text).not.toBe((await draftReply(thread, 'friendly', 0)).text)
  })
})

describe('answerQuestion', () => {
  it('answers "what did the supplier quote me?" with cited sources', async () => {
    const state = seedState()
    const hits = searchMessages({ ...state.snapshot, now: NOW }, 'what did the supplier quote me?')
    const sources = buildAnswerSources(hits, state, () => true)
    const { answer, citedMessageIds } = await answerQuestion('what did the supplier quote me?', sources)
    expect(answer).toContain('₹18.50')
    expect(answer).toContain('₹43,660')
    expect(citedMessageIds).toContain('sharma-5')
  })

  it('combines several chats for "which orders are people waiting on?"', async () => {
    const question = 'Which orders are people waiting on?'
    const state = seedState()
    const hits = searchMessages({ ...state.snapshot, now: NOW }, question)
    const { answer } = await answerQuestion(question, buildAnswerSources(hits, state, () => true))
    expect(answer).toContain('#MS-2041')
    expect(answer).toContain('Brew Bay Café')
  })

  it('only uses what was retrieved', async () => {
    const { answer, citedMessageIds } = await answerQuestion('what did the supplier quote me?', [])
    expect(citedMessageIds).toEqual([])
    expect(answer).toMatch(/couldn't find/i)
  })
})
