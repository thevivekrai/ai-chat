import { beforeEach, describe, expect, it } from 'vitest'
import type { Message } from '@/data/types'
import { ME_ID } from '@/data/types'
import type { SendOptions } from '@/data/api'
import { cancelEdit, sendReply, startEdit, startReply } from './actions'
import { useInbox } from './inbox'
import { useUi } from './ui'

const mine: Message = { id: 'm1', threadId: 't1', senderId: ME_ID, body: 'See you at 6', sentAt: '2026-10-21T10:00:00.000Z' }

describe('editing a message', () => {
  beforeEach(() => {
    useInbox.setState({ messages: { t1: [mine] } })
    useUi.setState({ composer: {}, replyingTo: {}, editing: {}, editDrafts: {} })
  })

  it('sets aside the reply being written, and brings it back afterwards', () => {
    useUi.getState().setComposer('t1', 'A long reply I was writing')
    useUi.getState().setReplyingTo('t1', 'm0')
    startEdit('t1', 'm1')
    expect(useUi.getState()).toMatchObject({ composer: { t1: 'See you at 6' }, editing: { t1: 'm1' }, replyingTo: {} })
    useUi.getState().setComposer('t1', 'See you at 7')
    cancelEdit('t1')
    expect(useUi.getState()).toMatchObject({ composer: { t1: 'A long reply I was writing' }, editing: {}, replyingTo: { t1: 'm0' }, editDrafts: {} })
  })

  it('starting a reply leaves the edit, with the draft back', () => {
    useUi.getState().setComposer('t1', 'Draft')
    startEdit('t1', 'm1')
    startReply('t1', 'm1')
    expect(useUi.getState()).toMatchObject({ composer: { t1: 'Draft' }, editing: {}, replyingTo: { t1: 'm1' } })
  })
})

describe('sending text with files', () => {
  it('sends text too long for a caption as its own message, first, with the quote', async () => {
    const sent: { body: string; options?: SendOptions }[] = []
    useInbox.setState({ sendMessage: async (_threadId, body, options) => void sent.push({ body, options }) })
    useUi.getState().setReplyingTo('t1', 'm0')
    const photo = new File(['x'], 'a.jpg', { type: 'image/jpeg' })
    const long = 'word '.repeat(300).trim()
    await sendReply('t1', long, [photo])
    expect(sent.map((s) => [s.body.length, s.options?.replyToId, !!s.options?.file])).toEqual([
      [long.length, 'm0', false],
      [0, undefined, true],
    ])

    sent.length = 0
    await sendReply('t1', 'Short caption', [photo, photo])
    expect(sent.map((s) => s.body)).toEqual(['Short caption', ''])
  })
})
