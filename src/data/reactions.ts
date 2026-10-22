import type { Reaction } from './types'

/**
 * The reactions after mine changes to `emoji` (null removes it). Each person has at most one
 * reaction per message, as on WhatsApp, so a new one replaces the old.
 */
export function withMyReaction(reactions: Reaction[] = [], emoji: string | null): Reaction[] {
  const next = reactions
    .map((r) => (r.mine ? { ...r, count: r.count - 1, mine: false } : r))
    .filter((r) => r.count > 0)
  if (!emoji) return next
  const same = next.find((r) => r.emoji === emoji)
  return same
    ? next.map((r) => (r === same ? { ...r, count: r.count + 1, mine: true } : r))
    : [...next, { emoji, count: 1, mine: true }]
}

/** My current reaction to a message, if any. */
export const myReaction = (reactions: Reaction[] | undefined) => reactions?.find((r) => r.mine)?.emoji ?? null
