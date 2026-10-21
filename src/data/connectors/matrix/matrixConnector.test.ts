import { describe, expect, it } from 'vitest'
import { stripReplyFallback } from './matrixConnector'

describe('stripReplyFallback', () => {
  it('drops the quoted original that replies carry for older clients', () => {
    expect(stripReplyFallback('> <@priya:example.org> Is it still available?\n\nYes, it is!')).toBe('Yes, it is!')
    expect(stripReplyFallback('> line one\n> line two\n\nAnswer\nwith two lines')).toBe('Answer\nwith two lines')
  })

  it('leaves ordinary messages alone', () => {
    expect(stripReplyFallback('Hello there')).toBe('Hello there')
    expect(stripReplyFallback('> just a quote')).toBe('> just a quote')
  })
})
