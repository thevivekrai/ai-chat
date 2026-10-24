import { describe, expect, it } from 'vitest'
import { NOW, seedState } from '@/test/fixtures'
import { matchesInChat, parseQuery, searchMessages, stem } from './search'

const { snapshot } = seedState()
const search = (q: string) => searchMessages({ ...snapshot, now: NOW }, q)

describe('stem', () => {
  it('folds common inflections together', () => {
    expect(new Set(['quote', 'quoted', 'quotation', 'quotes'].map(stem)).size).toBe(1)
    expect(stem('shipping')).toBe(stem('ship'))
    expect(stem('boxes')).toBe(stem('box'))
  })
})

describe('searchMessages', () => {
  it('drops question words', () => {
    expect(parseQuery('what did the supplier quote me?').map((t) => t.stem)).toEqual(['supplier', 'quot'])
  })

  it('finds the supplier quote from a natural question', () => {
    const hits = search('what did the supplier quote me?')
    expect(hits[0].threadId).toBe('sharma')
    expect(hits[0].matchedWords.length).toBeGreaterThan(0)
  })

  it('searches across networks and caps hits per chat', () => {
    const hits = search('price')
    const threads = new Set(hits.map((h) => h.threadId))
    expect(threads.has('rohan')).toBe(true)
    expect(threads.has('brewbay')).toBe(true)
    for (const id of threads) expect(hits.filter((h) => h.threadId === id).length).toBeLessThanOrEqual(3)
  })

  it("answers the command bar's suggested questions from the demo chats", () => {
    expect(search('When is my flight?')[0]).toMatchObject({ threadId: 'arjun' })
    expect(search('Have I ordered anything?').length).toBeGreaterThan(0)
    // Booking words count as the flight too.
    expect(search('boarding pass').map((h) => h.threadId)).toContain('arjun')
  })

  it('returns nothing for stop words only', () => {
    expect(search('what is it')).toEqual([])
  })
})

describe('search in a chat', () => {
  const messages = [
    { id: 'a', threadId: 't', senderId: 'c-1', body: 'The Pune order ships Friday', sentAt: '2026-10-20T10:00:00.000Z' },
    { id: 'b', threadId: 't', senderId: 'c-1', body: 'ok', sentAt: '2026-10-20T11:00:00.000Z' },
    { id: 'c', threadId: 't', senderId: 'c-1', body: 'Is the ORDER packed?', sentAt: '2026-10-20T12:00:00.000Z' },
    { id: 'd', threadId: 't', senderId: 'c-1', body: '', deleted: true, sentAt: '2026-10-20T13:00:00.000Z' },
  ]

  it('finds exactly what was typed, ignoring case, oldest first', () => {
    expect(matchesInChat(messages, 'order')).toEqual(['a', 'c'])
    expect(matchesInChat(messages, '  Pune order ')).toEqual(['a'])
    // Unlike the AI search, words aren't stemmed or widened.
    expect(matchesInChat(messages, 'orders')).toEqual([])
    expect(matchesInChat(messages, '   ')).toEqual([])
  })
})
