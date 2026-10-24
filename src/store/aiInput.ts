import type { AiSearchSource, AiTask, AiThread } from '@/ai'
import type { Contact, Me, Message, SearchHit, Task, Thread } from '@/data/types'
import { ME_ID } from '@/data/types'
import { byDue } from '@/lib/time'

/** Builds the minimal view of a chat that AI functions receive. */
export function toAiThread(thread: Thread, messages: Message[], contacts: Record<string, Contact>, me: Me): AiThread {
  return {
    id: thread.id,
    title: thread.title,
    network: thread.network,
    isGroup: thread.kind === 'group',
    me: { name: me.name },
    participants: thread.participantIds
      .map((id) => contacts[id])
      .filter((c): c is Contact => !!c)
      .map((c) => ({ id: c.id, name: c.name, label: c.label, org: c.org })),
    messages: messages
      // Deleted for everyone: there's nothing left to read.
      .filter((m) => m.status !== 'sending' && m.status !== 'failed' && !m.deleted)
      .map((m) => ({
        id: m.id,
        senderId: m.senderId,
        senderName: m.senderId === ME_ID ? me.name : (contacts[m.senderId]?.name ?? 'Unknown'),
        fromMe: m.senderId === ME_ID,
        body: m.body,
        sentAt: m.sentAt,
        ...(m.attachments?.length ? { attachments: m.attachments.map((a) => a.name) } : {}),
      })),
  }
}

interface SourceInput {
  threads: Record<string, Thread>
  messages: Record<string, Message[]>
  contacts: Record<string, Contact>
  me: Me
}

/**
 * Evidence for answerQuestion(): the ranked search hits first, then recent context from the best
 * matching threads (the quote's numbers are often in the message after the one that matched).
 * Only threads AI may read are included.
 */
export function buildAnswerSources(
  hits: SearchHit[],
  { threads, messages, contacts, me }: SourceInput,
  canRead: (threadId: string) => boolean,
): AiSearchSource[] {
  const sources = new Map<string, AiSearchSource>()
  const add = (m: Message) => {
    const thread = threads[m.threadId]
    if (!thread || sources.has(m.id)) return
    sources.set(m.id, toSource(m, thread, contacts, me))
  }

  const readable = hits.filter((h) => canRead(h.threadId))
  for (const hit of readable) {
    const message = messages[hit.threadId]?.find((m) => m.id === hit.messageId)
    if (message) add(message)
  }
  const topThreads = [...new Set(readable.map((h) => h.threadId))].slice(0, 6)
  for (const threadId of topThreads) (messages[threadId] ?? []).slice(-40).forEach(add)
  return [...sources.values()]
}

function toSource(m: Message, thread: Thread, contacts: Record<string, Contact>, me: Me): AiSearchSource {
  return {
    messageId: m.id,
    threadId: m.threadId,
    threadTitle: thread.title,
    network: thread.network,
    senderName: m.senderId === ME_ID ? me.name : (contacts[m.senderId]?.name ?? 'Unknown'),
    fromMe: m.senderId === ME_ID,
    body: m.body,
    sentAt: m.sentAt,
  }
}

/** "What are my tasks for today?": a question the task list answers better than a search. */
export const asksAboutTasks = (question: string) => /\b(tasks?|to-?dos?|to do list|(have|need|got) to do)\b/i.test(question)

/**
 * Every open task, soonest due first, for a question about tasks: the ones added by hand, and
 * those found in chats AI may read (a task's title comes from its chat).
 */
export function openTasks(tasks: Task[], threads: Record<string, Thread>, canRead: (threadId: string) => boolean): AiTask[] {
  return tasks
    .filter((t) => !t.done && (!t.source || canRead(t.source.threadId)))
    .sort((a, b) => byDue(a.dueAt, b.dueAt))
    .map((t) => {
      // Its chat's name, where this device has the chat.
      const title = t.source && threads[t.source.threadId]?.title
      return {
        title: t.title,
        dueAt: t.dueAt,
        ...(t.source ? { threadId: t.source.threadId, messageId: t.source.messageId, ...(title ? { threadTitle: title } : {}) } : {}),
      }
    })
}
