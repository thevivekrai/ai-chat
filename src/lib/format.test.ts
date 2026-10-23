import { describe, expect, it } from 'vitest'
import type { Attachment, Message } from '@/data/types'
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
})
