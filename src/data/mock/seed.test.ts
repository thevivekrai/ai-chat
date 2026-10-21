import { describe, expect, it } from 'vitest'
import { DAY, toMs } from '@/lib/time'
import { ME_ID } from '../types'
import { NOW, seedState } from '@/test/fixtures'

describe('demo seed', () => {
  const { snapshot, messages } = seedState()

  it('has 15 conversations, three on each of the five networks', () => {
    expect(snapshot.threads).toHaveLength(15)
    const perNetwork = snapshot.threads.reduce<Record<string, number>>((acc, t) => {
      acc[t.network] = (acc[t.network] ?? 0) + 1
      return acc
    }, {})
    expect(perNetwork).toEqual({ whatsapp: 3, telegram: 3, instagram: 3, slack: 3, sms: 3 })
  })

  it('keeps every thread in chronological order, entirely in the past', () => {
    for (const list of Object.values(messages)) {
      for (let i = 1; i < list.length; i++) expect(toMs(list[i].sentAt)).toBeGreaterThan(toMs(list[i - 1].sentAt))
      expect(toMs(list[list.length - 1].sentAt)).toBeLessThan(NOW)
    }
  })

  it('includes a group chat with 30+ messages', () => {
    const groups = snapshot.threads.filter((t) => t.kind === 'group')
    expect(Math.max(...groups.map((g) => messages[g.id].length))).toBeGreaterThanOrEqual(30)
  })

  it('includes a vendor quote with an attachment', () => {
    expect(messages.sharma.some((m) => m.attachments?.length && /quotation/i.test(m.attachments[0].name))).toBe(true)
    expect(messages.sharma.some((m) => m.body.includes('₹18.50'))).toBe(true)
  })

  it('includes an unanswered message from 3 days ago', () => {
    const last = messages.brewbay[messages.brewbay.length - 1]
    expect(last.senderId).not.toBe(ME_ID)
    expect(Math.floor((NOW - toMs(messages.brewbay[0].sentAt)) / DAY)).toBe(3)
  })

  it('mixes in casual Hinglish', () => {
    const all = Object.values(messages).flat()
    expect(all.filter((m) => /\b(hai|kya|kab|bhai|beta|baje|karte)\b/i.test(m.body)).length).toBeGreaterThan(5)
  })

  it('names deadlines relative to the day it was generated', () => {
    // NOW is a Wednesday: "confirm by" is tomorrow, the invoice is due in two days.
    expect(messages.sharma.at(-1)?.body).toContain('Thursday')
    expect(messages.neha.find((m) => m.id === 'neha-13')?.body).toContain('by Friday')
  })
})
