import type { Contact, Message, SearchHit, Thread } from '../types'
import { DAY, toMs } from '@/lib/time'

/**
 * Keyword search across every chat, tuned for natural-language questions like
 * "what did the supplier quote me?": stop words are dropped, words are lightly stemmed
 * (quote / quoted / quotation → "quot"), and a few synonym groups widen the net
 * (quote ↔ price ↔ rate). Contact names and labels count too, so "supplier" finds the chat with
 * the contact tagged Supplier.
 *
 * A real backend would use server-side search or a local embedding index instead.
 */

const STOPWORDS = new Set(
  (
    'a an the what whats did do does done me my mine i im you your to of for on in at is are was were be been it its ' +
    'this that these those and or with about from how when where who whom which any can could should would will we us ' +
    'our they them their he she him her have has had get got tell show find last latest there so just pls please ' +
    'hai ka ki ke ko se kya mujhe mera meri ne toh bhi na ho tha thi'
  ).split(' '),
)

const SYNONYM_GROUPS = [
  ['quote', 'quotation', 'price', 'pricing', 'rate', 'cost', 'estimate', 'kitna', 'kitne'],
  ['supplier', 'vendor', 'wholesale', 'packaging'],
  ['order', 'delivery', 'deliver', 'shipping', 'ship', 'dispatch', 'tracking', 'parcel', 'courier', 'pickup'],
  ['invoice', 'bill', 'billing', 'gst', 'accountant'],
  ['trek', 'trip', 'hike', 'rajmachi'],
  ['meet', 'coffee', 'lunch', 'dinner', 'plan'],
  ['pay', 'payment', 'paid', 'upi', 'transfer', 'owe'],
  ['box', 'carton', 'packaging'],
  ['appointment', 'dentist', 'dental', 'doctor', 'checkup'],
  ['plumber', 'sink', 'leak'],
]

export function stem(word: string): string {
  let w = word.toLowerCase().replace(/'s$/, '')
  if (w.length > 6 && w.endsWith('ation')) w = w.slice(0, -5)
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3)
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2)
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2)
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
  // shipp → ship, plann → plan
  if (/([bcdfgklmnprt])\1$/.test(w) && w.length > 3) w = w.slice(0, -1)
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1)
  return w
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2)
}

const STEMMED_GROUPS = SYNONYM_GROUPS.map((group) => new Set(group.map(stem)))

interface QueryTerm {
  stem: string
  alternatives: Set<string>
}

export function parseQuery(query: string): QueryTerm[] {
  const seen = new Set<string>()
  const terms: QueryTerm[] = []
  for (const token of tokenize(query)) {
    if (STOPWORDS.has(token)) continue
    const s = stem(token)
    if (seen.has(s)) continue
    seen.add(s)
    const alternatives = new Set<string>()
    for (const group of STEMMED_GROUPS) {
      if (group.has(s)) group.forEach((alt) => alt !== s && alternatives.add(alt))
    }
    terms.push({ stem: s, alternatives })
  }
  return terms
}

interface SearchInput {
  threads: Thread[]
  messages: Message[]
  contacts: Contact[]
  now?: number
}

const MAX_HITS_PER_THREAD = 3

export function searchMessages(
  { threads, messages, contacts, now = Date.now() }: SearchInput,
  query: string,
  limit = 20,
): SearchHit[] {
  const terms = parseQuery(query)
  if (terms.length === 0) return []

  const contactsById = new Map(contacts.map((c) => [c.id, c]))
  const byThread = new Map<string, Message[]>()
  for (const m of messages) {
    const list = byThread.get(m.threadId) ?? []
    list.push(m)
    byThread.set(m.threadId, list)
  }

  const hits: SearchHit[] = []
  for (const thread of threads) {
    const threadMessages = (byThread.get(thread.id) ?? []).sort((a, b) => toMs(a.sentAt) - toMs(b.sentAt))
    const people = thread.participantIds.map((id) => contactsById.get(id)).filter((c): c is Contact => !!c)
    const threadText = [thread.title, ...people.flatMap((p) => [p.name, p.label ?? '', p.org ?? ''])].join(' ')
    const threadStems = new Set(tokenize(threadText).map(stem))
    const threadMatches = terms.filter(
      (t) => threadStems.has(t.stem) || [...t.alternatives].some((alt) => threadStems.has(alt)),
    ).length
    const recentIds = new Set(threadMessages.slice(-3).map((m) => m.id))

    const threadHits: SearchHit[] = []
    for (const message of threadMessages) {
      const words = tokenize(message.body)
      const stemToWords = new Map<string, string[]>()
      for (const w of words) {
        const s = stem(w)
        stemToWords.set(s, [...(stemToWords.get(s) ?? []), w])
      }

      let bodyScore = 0
      let bodyMatches = 0
      const matched = new Set<string>()
      for (const term of terms) {
        if (stemToWords.has(term.stem)) {
          bodyScore += 3
          bodyMatches++
          stemToWords.get(term.stem)!.forEach((w) => matched.add(w))
          continue
        }
        const alt = [...term.alternatives].find((a) => stemToWords.has(a))
        if (alt) {
          bodyScore += 1.5
          bodyMatches++
          stemToWords.get(alt)!.forEach((w) => matched.add(w))
        }
      }

      // A thread-level match (e.g. the contact is tagged "Supplier") surfaces its latest messages.
      if (bodyScore === 0 && !(threadMatches > 0 && recentIds.has(message.id))) continue

      const coverage = Math.min(1, (bodyMatches + threadMatches) / terms.length)
      const ageDays = Math.max(0, (now - toMs(message.sentAt)) / DAY)
      const recency = Math.max(0, 1 - ageDays / 30)
      threadHits.push({
        messageId: message.id,
        threadId: thread.id,
        score: bodyScore + threadMatches * 1.5 + coverage * 2 + recency,
        matchedWords: [...matched],
      })
    }

    threadHits.sort((a, b) => b.score - a.score)
    hits.push(...threadHits.slice(0, MAX_HITS_PER_THREAD))
  }

  const sentAt = new Map(messages.map((m) => [m.id, toMs(m.sentAt)]))
  return hits
    .sort((a, b) => b.score - a.score || (sentAt.get(b.messageId) ?? 0) - (sentAt.get(a.messageId) ?? 0))
    .slice(0, limit)
}
