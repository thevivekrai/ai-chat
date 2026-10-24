import { describe, expect, it } from 'vitest'
import { ME_ID, withAction, type Message } from './types'

const message: Message = {
  id: 'm1',
  threadId: 't1',
  senderId: ME_ID,
  body: 'See you at 6',
  sentAt: '2026-10-21T10:00:00.000Z',
  status: 'read',
  attachments: [{ kind: 'image', name: 'map.jpg', url: 'https://example.test/map.jpg' }],
  replyTo: { id: 'm0', senderId: 'c-ravi', body: 'When?' },
  reactions: [{ emoji: '👍', count: 1, mine: false }],
}

describe('message actions', () => {
  it('edits, pins and stars a message', () => {
    const now = new Date('2026-10-21T10:05:00.000Z')
    expect(withAction(message, { type: 'edit', body: 'See you at 7' }, now)).toMatchObject({
      body: 'See you at 7',
      editedAt: now.toISOString(),
      attachments: message.attachments,
    })
    const pinned = withAction(message, { type: 'pin', pinned: true })
    expect(pinned.pinned).toBe(true)
    expect(withAction(pinned, { type: 'pin', pinned: false }).pinned).toBeUndefined()
    const starred = withAction(message, { type: 'star', starred: true })
    expect(starred.starred).toBe(true)
    expect(withAction(starred, { type: 'star', starred: false }).starred).toBeUndefined()
  })

  it('leaves nothing of a message deleted for everyone', () => {
    const deleted = withAction(message, { type: 'delete', forEveryone: true })
    expect(deleted).toEqual({ id: 'm1', threadId: 't1', senderId: ME_ID, body: '', sentAt: message.sentAt, status: 'read', deleted: true })
  })
})
