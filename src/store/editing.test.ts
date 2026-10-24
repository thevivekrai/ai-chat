import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, MessageAction } from '@/data/types'
import { ME_ID } from '@/data/types'
import { api, type SendOptions } from '@/data/api'
import { cancelEdit, removeUnsent, sendReply, startEdit, startReply } from './actions'
import { canRetry, useInbox } from './inbox'
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

describe("a message that wasn't sent", () => {
  it('can be removed, letting go of the photo it held', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const failed: Message = {
      id: 'pending-1',
      threadId: 't1',
      senderId: ME_ID,
      body: '',
      sentAt: '2026-10-21T10:00:00.000Z',
      status: 'failed',
      attachments: [{ kind: 'image', name: 'Photo', url: 'blob:http://localhost/abc' }],
    }
    useInbox.setState({ messages: { t1: [mine, failed] } })
    useInbox.getState().discardMessage('t1', 'pending-1')
    expect(useInbox.getState().messages.t1.map((m) => m.id)).toEqual(['m1'])
    expect(revoke).toHaveBeenCalledWith('blob:http://localhost/abc')
    // Only messages that weren't sent can be removed this way.
    useInbox.getState().discardMessage('t1', 'm1')
    expect(useInbox.getState().messages.t1.map((m) => m.id)).toEqual(['m1'])
    revoke.mockRestore()
  })

  it('kept by the network (it said it failed): removed, or replaced when sent again, there too', async () => {
    const keptFailed: Message = { id: 'wa:1:ABC', threadId: 't1', senderId: ME_ID, body: 'On my way', sentAt: '2026-10-21T10:00:00.000Z', status: 'failed' }
    const photo: Message = { ...keptFailed, id: 'wa:1:PHOTO', body: '', attachments: [{ kind: 'image', name: 'Photo' }] }
    const acted: [string, MessageAction][] = []
    let sends = false
    const send = vi.spyOn(api, 'sendMessage').mockImplementation(async (threadId, body) => {
      if (!sends) throw new Error('No connection')
      return { id: 'wa:1:NEW', threadId, senderId: ME_ID, body, sentAt: '2026-10-21T10:05:00.000Z', status: 'sent' }
    })
    const realAct = useInbox.getState().actOnMessage
    useInbox.setState({
      messages: { t1: [mine, keptFailed, photo] },
      actOnMessage: async (_threadId, messageId, action) => void acted.push([messageId, action]),
    })
    const ids = () => useInbox.getState().messages.t1.map((m) => `${m.id}:${m.status ?? ''}`)
    // Only on this device: not dropped from here alone (it would come back).
    useInbox.getState().discardMessage('t1', 'wa:1:ABC')
    expect(useInbox.getState().messages.t1).toHaveLength(3)
    removeUnsent('t1', 'wa:1:ABC')
    await vi.waitFor(() => expect(acted).toEqual([['wa:1:ABC', { type: 'delete', forEveryone: false }]]))

    // Sent again in its place: failing again, it stays as it was (with the new reason).
    acted.length = 0
    await useInbox.getState().retryMessage('t1', 'wa:1:ABC')
    expect(acted).toEqual([])
    expect(useInbox.getState().messages.t1.find((m) => m.id === 'wa:1:ABC')).toMatchObject({ status: 'failed', error: 'No connection' })
    expect(ids().sort()).toEqual(['m1:', 'wa:1:ABC:failed', 'wa:1:PHOTO:failed'])
    // Going, it's sent once however often it's tapped, and the copy that went takes its place.
    sends = true
    await Promise.all([useInbox.getState().retryMessage('t1', 'wa:1:ABC'), useInbox.getState().retryMessage('t1', 'wa:1:ABC')])
    expect(send).toHaveBeenCalledTimes(2)
    expect(acted).toEqual([['wa:1:ABC', { type: 'delete', forEveryone: false }]])
    expect(ids()).toContain('wa:1:NEW:sent')
    // A photo's file is only on the device that sent it: nothing to send again.
    expect(canRetry(photo)).toBe(false)
    await useInbox.getState().retryMessage('t1', 'wa:1:PHOTO')
    expect(send).toHaveBeenCalledTimes(2)
    send.mockRestore()
    useInbox.setState({ actOnMessage: realAct })
  })

})
