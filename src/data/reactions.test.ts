import { describe, expect, it } from 'vitest'
import { myReaction, withMyReaction, withMyReactionOn } from './reactions'

describe('my reaction', () => {
  it('adds, switches and removes my one reaction', () => {
    const start = [{ emoji: '👍', count: 2, mine: false }]
    const liked = withMyReaction(start, '👍')
    expect(liked).toEqual([{ emoji: '👍', count: 3, mine: true }])
    const switched = withMyReaction(liked, '❤️')
    expect(switched).toEqual([
      { emoji: '👍', count: 2, mine: false },
      { emoji: '❤️', count: 1, mine: true },
    ])
    expect(myReaction(switched)).toBe('❤️')
    expect(withMyReaction(switched, null)).toEqual(start)
    expect(withMyReaction(undefined, null)).toEqual([])
    expect(myReaction(undefined)).toBeNull()
  })

  it('keeps who reacted up to date, where that is known', () => {
    const message = { reactions: [{ emoji: '👍', count: 2, mine: true }], reactedBy: { me: '👍', 'wa:ravi': '👍' } }
    expect(withMyReactionOn(message, '❤️')).toEqual({
      reactions: [
        { emoji: '👍', count: 1, mine: false },
        { emoji: '❤️', count: 1, mine: true },
      ],
      reactedBy: { 'wa:ravi': '👍', me: '❤️' },
    })
    expect(withMyReactionOn(message, null).reactedBy).toEqual({ 'wa:ravi': '👍' })
    expect(withMyReactionOn({ reactions: [] }, '👍')).toEqual({ reactions: [{ emoji: '👍', count: 1, mine: true }] })
  })
})
