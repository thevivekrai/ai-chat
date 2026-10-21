/**
 * Plain, on-device rules for "does this chat expect a reply from me?". The Needs-reply queue uses
 * them when AI is off (or still thinking); with AI on, classifyPriority() has the final say.
 */

const ACK_WORDS = new Set(
  (
    'ok okay okk k kk thanks thank you thx ty tysm done sent cool great nice haha hahaha lol sure noted perfect ' +
    'awesome same yes yup ji theek hai accha achha sahi booked'
  ).split(' '),
)

/** "👍", "Thanks!", "Same 🙌", "Done 💸": acknowledgements that don't need an answer. */
export function isAckOnly(body: string): boolean {
  const words = body
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  return words.length === 0 || (words.length <= 4 && words.every((w) => ACK_WORDS.has(w)))
}

export const hasQuestion = (body: string) =>
  body.includes('?') || /\b(kab|kya|kaise|kitne|kitna|kaun|kahan|kyun)\b/i.test(body)

export const hasRequest = (body: string) =>
  /\b(can you|could you|would you|please|pls|plz|kindly|let me know|lmk|need (?:your|you|to know)|confirm|rakhna|bhej|batao|bata do)\b/i.test(
    body,
  )

/** Includes stretched spellings like "Thank youuu" and "thanksss". */
export const isThanks = (body: string) => /\b(thanks+|thank\s*(?:you|u)+|thx|tysm|shukriya)\b/i.test(body)

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function mentionsName(body: string, name: string): boolean {
  return new RegExp(`(^|[^\\w])@?${escapeRegExp(name)}\\b`, 'i').test(body)
}

/** Acknowledgements and thank-yous that close a loop instead of opening one. */
export const isClosing = (body: string) =>
  isAckOnly(body) || (isThanks(body) && !hasQuestion(body) && !hasRequest(body))

/**
 * The message the wait started from: the first unanswered question or request (in a group, one
 * addressed to me). A "thanks!" from last week or a "will send it tomorrow" doesn't make today's
 * question look days old.
 */
export function firstOpenMessage<T extends { body: string }>(
  pending: T[],
  { isGroup, myName }: { isGroup: boolean; myName: string },
): T | undefined {
  const asks = (body: string) => hasQuestion(body) || hasRequest(body)
  return (
    pending.find((m) => asks(m.body) && (!isGroup || mentionsName(m.body, myName))) ??
    pending.find((m) => !isClosing(m.body)) ??
    pending[0]
  )
}

interface ReplyInput {
  isGroup: boolean
  isAutomated: boolean
  myName: string
  /** Bodies of the messages others sent since my last message, oldest first. */
  pending: string[]
}

export function expectsReply({ isGroup, isAutomated, myName, pending }: ReplyInput): boolean {
  if (pending.length === 0 || isAutomated) return false
  if (isGroup) return pending.some((b) => mentionsName(b, myName) && (hasQuestion(b) || hasRequest(b)))
  // "👍" or "Yes got it, thanks!" closes the loop rather than opening a new one.
  return !pending.every(isClosing)
}
