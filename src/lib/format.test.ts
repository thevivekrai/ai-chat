import { describe, expect, it } from 'vitest'
import { ME_ID, type Attachment, type Message } from '@/data/types'
import { messagePreview } from './format'

const message = (attachments: Attachment[], body = ''): Message => ({
  id: 'm',
  threadId: 't',
  senderId: 'c-ravi',
  body,
  sentAt: '2026-10-23T10:00:00.000Z',
  attachments,
})

describe('chat list preview', () => {
  it('names what a message without text carries', () => {
    expect(messagePreview(message([{ kind: 'sticker', name: '😂 Sticker' }]), {}, false)).toBe('😂 Sticker')
    expect(messagePreview(message([{ kind: 'image', name: 'Photo' }]), {}, false)).toBe('📷 Photo')
    expect(messagePreview(message([{ kind: 'file', name: 'Invoice.pdf' }]), {}, false)).toBe('📎 Invoice.pdf')
    // A caption wins.
    expect(messagePreview(message([{ kind: 'image', name: 'Photo' }], 'The new planters'), {}, false)).toBe('The new planters')
  })

  it('says when the last message was deleted for everyone', () => {
    expect(messagePreview({ ...message([]), deleted: true }, {}, true)).toBe('This message was deleted')
    expect(messagePreview({ ...message([]), senderId: ME_ID, deleted: true }, {}, false)).toBe('You deleted this message')
  })
})
