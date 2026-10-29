import { describe, expect, it } from 'vitest'
import type { Message, Thread } from '@/data/types'
import { ME_ID } from '@/data/types'
import { DAY, HOUR } from '@/lib/time'
import { NOW, viewInput } from '@/test/fixtures'
import { buildThreadViews, countViews, selectViewThreads, starredMessages } from './selectors'

const opts = { networks: [], query: '', messages: viewInput().messages }
const needsReplyIds = (input = viewInput()) =>
  selectViewThreads(buildThreadViews(input), 'needs-reply', { ...opts, messages: input.messages }).map((v) => v.id)

describe('Needs reply (without AI)', () => {
  it('lists threads where the other person is waiting on me, longest wait first', () => {
    expect(needsReplyIds()).toEqual([
      'brewbay', // asked for pricing 3 days ago
      'trek', // @mentioned 2 days ago
      'divya',
      'sharma',
      'zoya',
      'ishaan',
      'priya',
      'neha',
      'rohan',
      'courier',
    ])
  })

  it('measures the wait from the first open question, not an old thank-you or update', () => {
    const views = Object.fromEntries(buildThreadViews(viewInput()).map((v) => [v.id, v]))
    const waitedHours = (id: string) => Math.round((NOW - views[id].waitingSince!) / HOUR)
    expect(waitedHours('zoya')).toBe(5) // not 9 days, from her "Thank youuu"
    expect(waitedHours('sharma')).toBe(22) // from "please confirm", not "will share by tomorrow"
    expect(waitedHours('ishaan')).toBe(3)
  })

  it('skips acknowledgements, automated messages, group chatter and threads I answered last', () => {
    const ids = needsReplyIds()
    for (const id of ['landlord', 'clinic', 'potters', 'arjun', 'studio-ops']) expect(ids).not.toContain(id)
  })

  it('lets a chat go after a week without a reply, until they write again', () => {
    const input = viewInput()
    // Six days on, the café lead (asked 3 days ago) is still waiting…
    expect(needsReplyIds({ ...input, now: NOW + 3 * DAY })).toContain('brewbay')
    // …but once their last message is a week old, it's no longer a to-do, and has no badge to show.
    const later = { ...input, now: NOW + 4 * DAY + HOUR }
    expect(needsReplyIds(later)).not.toContain('brewbay')
    const views = Object.fromEntries(buildThreadViews(later).map((v) => [v.id, v]))
    expect(views.brewbay.needsReply).toBe(false)
    expect(selectViewThreads(buildThreadViews(later), 'all', opts).map((v) => v.id)).toContain('brewbay')

    // They write again: back in the queue.
    const nudge: Message = { id: 'z', threadId: 'brewbay', senderId: input.threads.brewbay.participantIds[0], body: 'Any update on the pricing?', sentAt: new Date(NOW + 4 * DAY).toISOString() }
    const messages = { ...input.messages, brewbay: [...input.messages.brewbay, nudge] }
    expect(needsReplyIds({ ...later, messages })).toContain('brewbay')
  })

  it('brings a chat snoozed for longer than that back when the snooze ends', () => {
    const input = viewInput()
    const snoozedUntil = new Date(NOW + 10 * DAY).toISOString()
    const threads = { ...input.threads, brewbay: { ...input.threads.brewbay, snoozedUntil } }
    expect(needsReplyIds({ ...input, threads, now: NOW + 9 * DAY })).not.toContain('brewbay')
    expect(needsReplyIds({ ...input, threads, now: NOW + 10 * DAY + HOUR })).toContain('brewbay')
    // And a week after that, it goes like any other.
    expect(needsReplyIds({ ...input, threads, now: NOW + 17 * DAY + HOUR })).not.toContain('brewbay')
  })

  it('drops a thread as soon as I reply', () => {
    const input = viewInput()
    const reply: Message = { id: 'x', threadId: 'priya', senderId: ME_ID, body: 'On it!', sentAt: new Date(NOW).toISOString(), status: 'sending' }
    const messages = { ...input.messages, priya: [...input.messages.priya, reply] }
    expect(needsReplyIds({ ...input, messages })).not.toContain('priya')
  })

  it('counts a voice message or photo with no text as something to answer, but not a sticker', () => {
    const input = viewInput()
    const after = (body: string, attachments: Message['attachments']): Record<string, Message[]> => {
      const reply: Message = { id: 'mine', threadId: 'priya', senderId: ME_ID, body: 'On it!', sentAt: new Date(NOW - 2 * HOUR).toISOString() }
      const theirs: Message = { id: 'theirs', threadId: 'priya', senderId: 'c-priya', body, attachments, sentAt: new Date(NOW - HOUR).toISOString() }
      return { ...input.messages, priya: [...input.messages.priya, reply, theirs] }
    }
    expect(needsReplyIds({ ...input, messages: after('', [{ kind: 'audio', name: 'Voice message', voice: true, duration: 9 }]) })).toContain('priya')
    expect(needsReplyIds({ ...input, messages: after('', [{ kind: 'image', name: 'Photo' }]) })).toContain('priya')
    expect(needsReplyIds({ ...input, messages: after('', [{ kind: 'sticker', name: '👍 Sticker' }]) })).not.toContain('priya')
  })

  it('respects done until something new arrives', () => {
    const input = viewInput()
    const doneThreads: Record<string, Thread> = {
      ...input.threads,
      rohan: { ...input.threads.rohan, doneAt: new Date(NOW).toISOString() },
    }
    expect(needsReplyIds({ ...input, threads: doneThreads })).not.toContain('rohan')

    const later: Message = { id: 'y', threadId: 'rohan', senderId: 'c-rohan', body: 'Hello?', sentAt: new Date(NOW + 1000).toISOString() }
    const messages = { ...input.messages, rohan: [...input.messages.rohan, later] }
    expect(needsReplyIds({ ...input, threads: doneThreads, messages, now: NOW + 2000 })).toContain('rohan')
  })

  it('shows the chat\'s own tags alongside the AI\'s, each once', () => {
    const input = viewInput({
      canRead: () => true,
      threads: { ...viewInput().threads, rohan: { ...viewInput().threads.rohan, labels: ['personal', 'meeting'] } },
      priority: {
        rohan: { key: 'rohan-2', status: 'ready', result: { priority: 'normal', expectsReply: true, reason: '', labels: ['meeting', 'question'] } },
      },
    })
    // The chat's own first, then the AI's; "meeting" is on both and shows once.
    expect(buildThreadViews(input).find((v) => v.id === 'rohan')!.labels).toEqual(['personal', 'meeting', 'question'])
  })

  it('leaves a chat whose tags were cleared to the user alone, priority and all', () => {
    const input = viewInput({
      canRead: () => true,
      threads: { ...viewInput().threads, rohan: { ...viewInput().threads.rohan, labels: ['personal'], labelsLocked: true } },
      priority: {
        rohan: {
          key: 'rohan-2',
          status: 'ready',
          result: { priority: 'urgent', expectsReply: true, reason: '', labels: ['payment'], labelCalls: [{ tag: 'payment', confidence: 0.9, why: 'Money' }] },
        },
      },
    })
    const view = buildThreadViews(input).find((v) => v.id === 'rohan')!
    // The AI's tags are gone; the user's own stay; Urgent isn't a tag and stays too.
    expect(view.labels).toEqual(['personal'])
    expect(view.priority?.priority).toBe('urgent')
    expect(view.labelSources).toEqual({ personal: { by: 'you' } })
  })

  it('says why each tag is there', () => {
    const input = viewInput({
      canRead: () => true,
      threads: { ...viewInput().threads, rohan: { ...viewInput().threads.rohan, labels: ['work'] } },
      priority: {
        rohan: {
          key: 'rohan-2',
          status: 'ready',
          result: {
            priority: 'normal',
            expectsReply: true,
            reason: '',
            labels: ['payment'],
            labelCalls: [
              { tag: 'payment', confidence: 0.9, why: 'Asks about the invoice' },
              { tag: 'meeting', confidence: 0.4, why: 'Mentions next week' },
            ],
          },
        },
      },
    })
    expect(buildThreadViews(input).find((v) => v.id === 'rohan')!.labelSources).toEqual({
      work: { by: 'you' },
      payment: { by: 'ai', confidence: 0.9, why: 'Asks about the invoice' },
    })
  })

  it('shows a done chat as Normal rather than Urgent, so it never loses its tag', () => {
    const base = viewInput({
      canRead: () => true,
      priority: {
        rohan: { key: 'rohan-2', status: 'ready', result: { priority: 'urgent', expectsReply: true, reason: 'Waiting on you.', labels: ['deadline'] } },
      },
    })
    expect(buildThreadViews(base).find((v) => v.id === 'rohan')!.priority?.priority).toBe('urgent')

    const done = { ...base, threads: { ...base.threads, rohan: { ...base.threads.rohan, doneAt: new Date(NOW).toISOString() } } }
    const view = buildThreadViews(done).find((v) => v.id === 'rohan')!
    expect(view.priority).toMatchObject({ priority: 'normal', reason: 'Waiting on you.' })
    expect(view.labels).toEqual([])

    // Low stays Low.
    const low = { ...done, priority: { rohan: { key: 'rohan-2', status: 'ready' as const, result: { priority: 'low' as const, expectsReply: false, reason: '' } } } }
    expect(buildThreadViews(low).find((v) => v.id === 'rohan')!.priority?.priority).toBe('low')
  })

  it('keeps a done chat sorted, so its Normal or Low stays', () => {
    const base = viewInput({ canRead: () => true })
    const input = {
      ...base,
      threads: { ...base.threads, rohan: { ...base.threads.rohan, doneAt: new Date(NOW).toISOString() } },
      priority: { rohan: { key: 'rohan-2', status: 'loading' as const } },
    }
    // Classifying a chat that's already done still shows as in progress, rather than nothing at all.
    expect(buildThreadViews(input).find((v) => v.id === 'rohan')).toMatchObject({ done: true, priorityLoading: true })
  })

  it('drops the tags that ask something of a done chat (and leaves it out of their filters) until they write again', () => {
    const input = viewInput({
      canRead: () => true,
      priority: {
        rohan: { key: 'rohan-2', status: 'ready', result: { priority: 'urgent', expectsReply: true, reason: '', labels: ['deadline', 'payment', 'work'] } },
      },
      threads: { ...viewInput().threads, rohan: { ...viewInput().threads.rohan, labels: ['personal', 'meeting'] } },
    })
    const rohan = (i: typeof input) => buildThreadViews(i).find((v) => v.id === 'rohan')!
    expect(rohan(input)).toMatchObject({ done: false, labels: ['personal', 'meeting', 'deadline', 'payment', 'work'] })

    const done = { ...input, threads: { ...input.threads, rohan: { ...input.threads.rohan, doneAt: new Date(NOW).toISOString() } } }
    // Only Personal asks nothing of you: Meeting, Work, Deadline and Payment all go.
    expect(rohan(done)).toMatchObject({ done: true, labels: ['personal'] })
    expect(selectViewThreads(buildThreadViews(done), 'all', { ...opts, tag: 'payment' }).map((v) => v.id)).not.toContain('rohan')

    const later: Message = { id: 'z', threadId: 'rohan', senderId: 'c-rohan', body: 'Paid?', sentAt: new Date(NOW + 1000).toISOString() }
    expect(rohan({ ...done, messages: { ...done.messages, rohan: [...done.messages.rohan, later] }, now: NOW + 2000 }).done).toBe(false)
  })

  it('hides snoozed threads until the snooze ends', () => {
    const input = viewInput()
    const until = new Date(NOW + 2 * HOUR).toISOString()
    const threads = { ...input.threads, divya: { ...input.threads.divya, snoozedUntil: until } }
    expect(needsReplyIds({ ...input, threads })).not.toContain('divya')
    expect(needsReplyIds({ ...input, threads, now: NOW + 3 * HOUR })).toContain('divya')
  })

  it('uses AI classification when the thread is readable', () => {
    const input = viewInput({
      canRead: (id) => id === 'zoya',
      priority: { zoya: { key: 'zoya-4', status: 'ready', result: { priority: 'low', expectsReply: false, reason: '' } } },
    })
    expect(needsReplyIds(input)).not.toContain('zoya')
  })

  it('sorts by AI priority first', () => {
    const input = viewInput({
      canRead: () => true,
      priority: {
        rohan: { key: 'rohan-2', status: 'ready', result: { priority: 'urgent', expectsReply: true, reason: '' } },
        brewbay: { key: 'brewbay-3', status: 'ready', result: { priority: 'low', expectsReply: true, reason: '' } },
      },
    })
    const ids = needsReplyIds(input)
    expect(ids[0]).toBe('rohan')
    expect(ids[ids.length - 1]).toBe('brewbay')
  })
})

describe('other views', () => {
  it('Waiting on them lists chats where I asked last', () => {
    const input = viewInput()
    const ids = selectViewThreads(buildThreadViews(input), 'waiting', opts).map((v) => v.id)
    expect(new Set(ids)).toEqual(new Set(['arjun', 'studio-ops']))
  })

  it('filters by network and counts consistently', () => {
    const input = viewInput()
    const views = buildThreadViews(input)
    const whatsapp = selectViewThreads(views, 'all', { ...opts, networks: ['whatsapp'] })
    expect(whatsapp.map((v) => v.thread.network)).toEqual(['whatsapp', 'whatsapp', 'whatsapp'])
    const counts = countViews(views, { networks: [], tasks: [], scheduled: input.scheduled })
    expect(counts['needs-reply']).toBe(10)
    expect(counts.all).toBe(15)
    expect(counts.scheduled).toBe(1)
  })

  it('stops counting a chat as waiting after two weeks', () => {
    const later = NOW + 15 * DAY
    const ids = selectViewThreads(buildThreadViews(viewInput({ now: later })), 'waiting', opts).map((v) => v.id)
    expect(ids).toEqual([])
  })
})

describe('archived chats', () => {
  it('are only in Archived, out of the queue and every other list', () => {
    const input = viewInput()
    const queue = selectViewThreads(buildThreadViews(input), 'needs-reply', opts).map((v) => v.id)
    const archivedId = queue[0]
    input.threads = { ...input.threads, [archivedId]: { ...input.threads[archivedId], archived: true, unreadCount: 2 } }
    const views = buildThreadViews(input)
    for (const view of ['needs-reply', 'all', 'waiting'] as const) {
      expect(selectViewThreads(views, view, opts).map((v) => v.id)).not.toContain(archivedId)
    }
    expect(selectViewThreads(views, 'archived', opts).map((v) => v.id)).toEqual([archivedId])
    const counts = countViews(views, { networks: [], tasks: [], scheduled: input.scheduled })
    expect(counts.all).toBe(14)
    expect(counts['needs-reply']).toBe(9)
    // Like WhatsApp: archived chats with something unread.
    expect(counts.archived).toBe(1)
  })
})

describe('starred messages', () => {
  it('lists starred messages newest first, for the chosen networks, and counts them', () => {
    const input = viewInput()
    const star = (threadId: string, index: number) => (input.messages[threadId][index] = { ...input.messages[threadId][index], starred: true })
    const older = star('rohan', 0)
    const newer = star('rohan', 1)
    const elsewhere = star('divya', 0)
    const starred = starredMessages(input.messages, input.threads, [])
    expect(starred.map((m) => m.id)).toContain(elsewhere.id)
    expect(starred.indexOf(newer)).toBeLessThan(starred.indexOf(older))
    const network = input.threads.rohan.network
    expect(starredMessages(input.messages, input.threads, [network]).every((m) => input.threads[m.threadId].network === network)).toBe(true)
    const counts = countViews(buildThreadViews(input), { networks: [], tasks: [], scheduled: input.scheduled, messages: input.messages })
    expect(counts.starred).toBe(3)
  })
})
