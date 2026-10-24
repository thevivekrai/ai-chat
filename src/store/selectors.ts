import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Priority, PriorityResult } from '@/ai'
import { NEEDS_REPLY_FOR } from '@/config'
import type { Contact, Me, Message, NetworkId, ScheduledMessage, Task, Thread } from '@/data/types'
import { ME_ID } from '@/data/types'
import { expectsReply, firstOpenMessage, hasQuestion, hasRequest } from '@/lib/replyRules'
import { DAY, toMs } from '@/lib/time'
import { useAi, type AiEntry } from './ai'
import { useClock } from './clock'
import { settledLastMessageId, useInbox } from './inbox'

/** A chat's picture: the group's own, or the other person's in a 1:1 chat. */
export function threadPicture(thread: Thread, contacts: Record<string, Contact>): string | undefined {
  return thread.kind === 'group' ? thread.avatarUrl : contacts[thread.participantIds[0]]?.avatarUrl
}
import { canAiReadThread, useSettings } from './settings'
import type { View } from './ui'

export interface ThreadView {
  id: string
  thread: Thread
  participants: Contact[]
  lastMessage: Message | undefined
  lastAt: number
  fromMeLast: boolean
  /** When the oldest message I haven't answered arrived (null if I wrote last). */
  waitingSince: number | null
  snoozed: boolean
  scheduledCount: number
  /**
   * Last message is theirs, from the past week (NEEDS_REPLY_FOR), expects a response, and isn't
   * done, snoozed or scheduled.
   */
  needsReply: boolean
  /** I wrote last and asked something. */
  waitingOnThem: boolean
  aiAllowed: boolean
  /** Up-to-date AI classification, if there is one. */
  priority: PriorityResult | null
  /** The previous classification while a new one is computed (after a new message). */
  stalePriority: PriorityResult | null
  priorityLoading: boolean
  /** For sorting: the fresh priority, else the previous one, else normal. */
  sortPriority: Priority
}

export interface ThreadViewInput {
  threads: Record<string, Thread>
  messages: Record<string, Message[]>
  contacts: Record<string, Contact>
  scheduled: ScheduledMessage[]
  me: Me
  priority: Record<string, AiEntry<PriorityResult>>
  canRead: (threadId: string) => boolean
  now: number
}

function buildThreadView(thread: Thread, input: ThreadViewInput): ThreadView {
  const messages = input.messages[thread.id] ?? []
  const last = messages[messages.length - 1]
  const lastAt = last ? toMs(last.sentAt) : 0
  const fromMeLast = last?.senderId === ME_ID

  const pending: Message[] = []
  for (let i = messages.length - 1; i >= 0 && messages[i].senderId !== ME_ID; i--) pending.unshift(messages[i])

  const participants = thread.participantIds.map((id) => input.contacts[id]).filter((c): c is Contact => !!c)
  const aiAllowed = input.canRead(thread.id)
  const entry = aiAllowed ? input.priority[thread.id] : undefined
  const fresh =
    entry?.status === 'ready' && entry.key === settledLastMessageId(messages) ? (entry.result ?? null) : null

  const snoozed = !!thread.snoozedUntil && toMs(thread.snoozedUntil) > input.now
  const doneSinceLast = !!thread.doneAt && toMs(thread.doneAt) >= lastAt
  const scheduledCount = input.scheduled.filter((s) => s.threadId === thread.id).length

  // AI decides when it may read the thread; otherwise simple on-device rules do.
  const isGroup = thread.kind === 'group'
  const expects =
    fresh?.expectsReply ??
    expectsReply({
      isGroup,
      isAutomated: participants.some((p) => p.label === 'Automated'),
      myName: input.me.name,
      pending: pending.map((m) => m.body),
    })
  const waitingFrom = firstOpenMessage(pending, { isGroup, myName: input.me.name })

  return {
    id: thread.id,
    thread,
    participants,
    lastMessage: last,
    lastAt,
    fromMeLast,
    waitingSince: waitingFrom ? toMs(waitingFrom.sentAt) : null,
    snoozed,
    scheduledCount,
    needsReply:
      !fromMeLast &&
      pending.length > 0 &&
      input.now - lastAt < NEEDS_REPLY_FOR &&
      expects &&
      !snoozed &&
      !doneSinceLast &&
      scheduledCount === 0,
    waitingOnThem:
      fromMeLast &&
      last.status !== 'failed' &&
      (hasQuestion(last.body) || hasRequest(last.body)) &&
      input.now - lastAt < 14 * DAY &&
      !snoozed &&
      !doneSinceLast,
    aiAllowed,
    priority: fresh,
    stalePriority: fresh ? null : (entry?.result ?? null),
    priorityLoading: aiAllowed && !fresh && entry?.status !== 'error',
    sortPriority: fresh?.priority ?? entry?.result?.priority ?? 'normal',
  }
}

export function buildThreadViews(input: ThreadViewInput): ThreadView[] {
  return Object.values(input.threads).map((t) => buildThreadView(t, input))
}

const RANK: Record<Priority, number> = { urgent: 0, normal: 1, low: 2 }

function matchesQuery(view: ThreadView, query: string, messages: Message[] = []): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    view.thread.title.toLowerCase().includes(q) ||
    view.participants.some((p) => p.name.toLowerCase().includes(q)) ||
    messages.some((m) => m.body.toLowerCase().includes(q))
  )
}

export function filterByNetwork<T extends { thread: Thread }>(views: T[], networks: NetworkId[]): T[] {
  return networks.length ? views.filter((v) => networks.includes(v.thread.network)) : views
}

/** The threads a list view shows, in display order. */
export function selectViewThreads(
  views: ThreadView[],
  view: View,
  { networks, query, messages }: { networks: NetworkId[]; query: string; messages: Record<string, Message[]> },
): ThreadView[] {
  const list = filterByNetwork(views, networks).filter((v) => matchesQuery(v, query, messages[v.id]))
  switch (view) {
    case 'needs-reply':
      // Most important first; within the same priority, whoever has waited longest.
      return list
        .filter((v) => v.needsReply)
        .sort((a, b) => RANK[a.sortPriority] - RANK[b.sortPriority] || (a.waitingSince ?? 0) - (b.waitingSince ?? 0))
    case 'waiting':
      return list.filter((v) => v.waitingOnThem).sort((a, b) => a.lastAt - b.lastAt)
    default:
      return [...list].sort((a, b) => b.lastAt - a.lastAt)
  }
}

export function countViews(
  views: ThreadView[],
  {
    networks,
    tasks,
    scheduled,
    messages = {},
  }: { networks: NetworkId[]; tasks: Task[]; scheduled: ScheduledMessage[]; messages?: Record<string, Message[]> },
): Record<View, number> {
  const visible = filterByNetwork(views, networks)
  const visibleIds = new Set(visible.map((v) => v.id))
  return {
    'needs-reply': visible.filter((v) => v.needsReply).length,
    all: visible.length,
    waiting: visible.filter((v) => v.waitingOnThem).length,
    scheduled: scheduled.filter((s) => visibleIds.has(s.threadId)).length + visible.filter((v) => v.snoozed).length,
    tasks: tasks.filter((t) => !t.done).length,
    starred: [...visibleIds].reduce((n, id) => n + (messages[id]?.filter((m) => m.starred).length ?? 0), 0),
  }
}

/** Starred messages across the chats on show, newest first. */
export function starredMessages(messages: Record<string, Message[]>, threads: Record<string, Thread>, networks: NetworkId[]): Message[] {
  return Object.values(messages)
    .flat()
    .filter((m) => m.starred && threads[m.threadId] && (!networks.length || networks.includes(threads[m.threadId].network)))
    .sort((a, b) => toMs(b.sentAt) - toMs(a.sentAt))
}

/** All threads with derived queue state, recomputed when data, AI results, consent or time change. */
export function useThreadViews(): ThreadView[] {
  const { threads, messages, contacts, scheduled, me } = useInbox(
    useShallow((s) => ({ threads: s.threads, messages: s.messages, contacts: s.contacts, scheduled: s.scheduled, me: s.me })),
  )
  const priority = useAi((s) => s.priority)
  const { aiEnabled, aiThreadIds } = useSettings(
    useShallow((s) => ({ aiEnabled: s.aiEnabled, aiThreadIds: s.aiThreadIds })),
  )
  const now = useClock((s) => s.now)

  return useMemo(
    () =>
      buildThreadViews({
        threads,
        messages,
        contacts,
        scheduled,
        me,
        priority,
        canRead: (id) => canAiReadThread({ aiEnabled, aiThreadIds }, id),
        now,
      }),
    [threads, messages, contacts, scheduled, me, priority, aiEnabled, aiThreadIds, now],
  )
}
