import { describe, expect, it } from 'vitest'
import { waveBars } from './waveform'

describe('voice message waveform', () => {
  it('fits the levels the network sent into the bars drawn, loudest at full height', () => {
    const bars = waveBars([0, 50, 100, 50], 2, 'x')
    expect(bars).toEqual([0.25, 0.75])
    expect(waveBars(Array.from({ length: 64 }, (_, i) => i), 36, 'x')).toHaveLength(36)
    // Silence still draws a line.
    expect(waveBars([0, 0], 2, 'x')).toEqual([0.08, 0.08])
  })

  it('makes up a steady shape when there are no levels', () => {
    const made = waveBars(undefined, 36, 'voice-1')
    expect(made).toHaveLength(36)
    expect(made).toEqual(waveBars(undefined, 36, 'voice-1'))
    expect(made.every((h) => h > 0 && h <= 1)).toBe(true)
  })
})
