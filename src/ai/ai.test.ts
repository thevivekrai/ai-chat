import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asksAboutTasks, buildAnswerSources, openTasks } from '@/store/aiInput'
import { searchMessages } from '@/data/search'
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
import { buildAnswerPrompt } from './prompts'

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
    setAiAccessPolicy((id) => id !== 'divya')
    await expect(summarizeThread(aiThread('divya'))).rejects.toBeInstanceOf(AiAccessError)
    await expect(draftReply(aiThread('divya'), 'short')).rejects.toBeInstanceOf(AiAccessError)
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

  it('answers "what are my tasks for today?" from the open tasks', async () => {
    const state = seedState()
    const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString()
    const priya = state.messages.priya[0].id
    const tasks = [
      { id: 't1', title: 'Send the invoice', dueAt: at(2), done: false, createdAt: at(-5), source: { threadId: 'sharma', messageId: 'sharma-5' } },
      { id: 't2', title: 'Ship the planters', dueAt: at(72), done: false, createdAt: at(-5), source: { threadId: 'priya', messageId: priya } },
      { id: 't3', title: 'Already done', dueAt: at(1), done: true, createdAt: at(-5), source: { threadId: 'sharma', messageId: 'sharma-5' } },
      { id: 't4', title: 'Private chat', dueAt: at(1), done: false, createdAt: at(-5), source: { threadId: 'divya', messageId: state.messages.divya[0].id } },
      // Added by hand, and one from a message this device no longer has loaded.
      { id: 't5', title: 'Renew the domain', dueAt: at(3), done: false, createdAt: at(-5) },
      { id: 't6', title: 'Call the bank', dueAt: null, done: false, createdAt: at(-5), source: { threadId: 'sharma', messageId: 'sharma-gone' } },
    ]
    expect(asksAboutTasks('What are my tasks for today?')).toBe(true)
    expect(asksAboutTasks('What do I have to do today?')).toBe(true)
    expect(asksAboutTasks("What's on my to do list today?")).toBe(true)
    expect(asksAboutTasks('When is my flight?')).toBe(false)
    // Asking about a chat, not the task list.
    expect(asksAboutTasks('What did the supplier ask me to do?')).toBe(false)

    // Open ones only (from chats AI may read, or added by hand), soonest first.
    const open = openTasks(tasks, state.threads, (id) => id !== 'divya')
    expect(open.map((t) => t.title)).toEqual(['Send the invoice', 'Renew the domain', 'Ship the planters', 'Call the bank'])
    expect(open[0]).toMatchObject({ threadTitle: state.threads.sharma.title, messageId: 'sharma-5' })
    expect(open[1]).toEqual({ title: 'Renew the domain', dueAt: at(3) })

    const { answer, citedMessageIds } = await answerQuestion('What are my tasks for today?', [], open)
    expect(answer).toMatch(/2 tasks due today/)
    expect(answer).toContain('**Send the invoice**')
    expect(answer).toContain('**Renew the domain**')
    expect(answer).not.toContain('Ship the planters')
    expect(citedMessageIds).toEqual(['sharma-5'])

    // Nothing due today: what's open, counted in full.
    const later = open.slice(2)
    expect((await answerQuestion('What are my tasks for today?', [], later)).answer).toMatch(/Nothing is due today\. You have 2 tasks open/)
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `Task ${i}`, dueAt: null }))
    expect((await answerQuestion('my tasks?', [], many)).answer).toMatch(/12 tasks open: .*, and 7 more\./)

    // Claude gets them too, with the user's time zone to tell what "today" is.
    const prompt = buildAnswerPrompt('What are my tasks for today?', [], new Date(NOW), 'Asia/Kolkata', open)
    expect(prompt.user).toContain("(the user's time zone: Asia/Kolkata)")
    expect(prompt.user).toContain('Open tasks (4 in all)')
    expect(prompt.user).toContain(`- Renew the domain · due ${at(3)} · added by hand`)
    expect(prompt.user).toContain(`- Send the invoice · due ${at(2)} · [sharma-5] from "${state.threads.sharma.title}"`)
  })

  it('only uses what was retrieved', async () => {
    const { answer, citedMessageIds } = await answerQuestion('what did the supplier quote me?', [])
    expect(citedMessageIds).toEqual([])
    expect(answer).toMatch(/couldn't find/i)
  })
})
