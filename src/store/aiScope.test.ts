import { describe, expect, it } from 'vitest'
import type { Message, Thread } from '@/data/types'
import { buildScopedSources } from './aiInput'

const thread = (id: string, title: string): Thread => ({ id, network: 'whatsapp', kind: 'direct', title, participantIds: [id], unreadCount: 0, doneAt: null, snoozedUntil: null })
const msg = (threadId: string, n: number): Message => ({ id: `${threadId}:${n}`, threadId, senderId: threadId, body: `${threadId} #${n}`, sentAt: new Date(2026, 9, 1, 9, n).toISOString() })

describe('asking the AI about chosen chats', () => {
  const input = {
    threads: { john: thread('john', 'John'), sarah: thread('sarah', 'Sarah'), boss: thread('boss', 'Boss') },
    messages: {
      john: Array.from({ length: 80 }, (_, i) => msg('john', i)),
      sarah: [msg('sarah', 1)],
      boss: [msg('boss', 1)],
    },
    contacts: {},
    me: { id: 'me', name: 'Aarav' },
  }

  it('sends only the chosen chats, never the rest of the inbox', () => {
    const sources = buildScopedSources(['john', 'sarah'], input as never, () => true)
    expect(new Set(sources.map((s) => s.threadId))).toEqual(new Set(['john', 'sarah']))
    // The latest of each, not the whole history.
    expect(sources.filter((s) => s.threadId === 'john')).toHaveLength(60)
    expect(sources.some((s) => s.body === 'john #79')).toBe(true)
  })

  it('leaves out a chosen chat the AI may not read', () => {
    const sources = buildScopedSources(['john', 'boss'], input as never, (id) => id !== 'boss')
    expect(sources.every((s) => s.threadId === 'john')).toBe(true)
  })
})
