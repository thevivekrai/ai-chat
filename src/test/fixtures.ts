import { toAiThread } from '@/store/aiInput'
import type { ThreadViewInput } from '@/store/selectors'
import type { InboxSnapshot, Message } from '@/data/types'
import { buildSeed } from '@/data/mock/seed'
import { toMs } from '@/lib/time'

/** A fixed Wednesday afternoon, so weekday-dependent text is predictable. */
export const NOW = new Date(2026, 9, 21, 15, 0, 0).getTime()

export function seedState(now = NOW) {
  const snapshot: InboxSnapshot = buildSeed(now)
  const messages: Record<string, Message[]> = {}
  for (const m of snapshot.messages) (messages[m.threadId] ??= []).push(m)
  for (const list of Object.values(messages)) list.sort((a, b) => toMs(a.sentAt) - toMs(b.sentAt))
  return {
    snapshot,
    me: snapshot.me,
    threads: Object.fromEntries(snapshot.threads.map((t) => [t.id, t])),
    contacts: Object.fromEntries(snapshot.contacts.map((c) => [c.id, c])),
    messages,
  }
}

export function viewInput(overrides: Partial<ThreadViewInput> = {}, now = NOW): ThreadViewInput {
  const s = seedState(now)
  return {
    threads: s.threads,
    messages: s.messages,
    contacts: s.contacts,
    scheduled: s.snapshot.scheduled,
    me: s.me,
    priority: {},
    canRead: () => false,
    now,
    ...overrides,
  }
}

export function aiThread(threadId: string, now = NOW) {
  const s = seedState(now)
  return toAiThread(s.threads[threadId], s.messages[threadId], s.contacts, s.me)
}
