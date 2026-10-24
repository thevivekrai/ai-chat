import { describe, expect, it } from 'vitest'
import { ME_ID, type Attachment, type Message } from '@/data/types'
import { formatDuration, messagePreview } from './format'

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

  it('names voice messages and audio, with how long they are', () => {
    expect(messagePreview(message([{ kind: 'audio', name: 'Voice message', voice: true, duration: 7 }]), {}, false)).toBe('🎤 Voice message (0:07)')
    expect(messagePreview(message([{ kind: 'audio', name: 'Kesariya', duration: 200 }]), {}, false)).toBe('🎵 Kesariya (3:20)')
    expect(messagePreview(message([{ kind: 'audio', name: 'Voice message', voice: true }]), {}, false)).toBe('🎤 Voice message')
    expect([formatDuration(0), formatDuration(65.4), formatDuration(3729)]).toEqual(['0:00', '1:05', '1:02:09'])
  })

  it('says when the last message was deleted for everyone', () => {
    expect(messagePreview({ ...message([]), deleted: true }, {}, true)).toBe('This message was deleted')
    expect(messagePreview({ ...message([]), senderId: ME_ID, deleted: true }, {}, false)).toBe('You deleted this message')
  })
})
