import { describe, expect, it } from 'vitest'
import { NOW, seedState } from '@/test/fixtures'
import { parseQuery, searchMessages, stem } from './search'

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

  it('returns nothing for stop words only', () => {
    expect(search('what is it')).toEqual([])
  })
})
