import { beforeEach, describe, expect, it } from 'vitest'
import { useToasts } from './toasts'

describe('toasts', () => {
  beforeEach(() => useToasts.setState({ toasts: [] }))

  it('replaces older toasts of the same group, so only the latest undo shows', () => {
    const { push } = useToasts.getState()
    push({ title: 'Marked done', description: 'Priya', group: 'queue' })
    push({ title: 'New message from Rohan' })
    push({ title: 'Marked done', description: 'Divya', group: 'queue' })
    expect(useToasts.getState().toasts.map((t) => t.description ?? t.title)).toEqual(['New message from Rohan', 'Divya'])
  })

  it('keeps at most three on screen', () => {
    const { push } = useToasts.getState()
    for (let i = 0; i < 5; i++) push({ title: `t${i}` })
    expect(useToasts.getState().toasts.map((t) => t.title)).toEqual(['t2', 't3', 't4'])
  })
})
