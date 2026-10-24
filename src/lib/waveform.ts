import { hashString } from './format'

/** `levels` (0–100) as `count` bars, 0–1; a made-up but steady shape when the network sent none. */
export function waveBars(levels: number[] | undefined, count: number, seed: string): number[] {
  if (!levels?.length) {
    let h = hashString(seed)
    return Array.from({ length: count }, () => {
      h = (h * 1103515245 + 12345) & 0x7fffffff
      return 0.25 + ((h >> 8) % 60) / 100
    })
  }
  const loudest = Math.max(...levels, 1)
  return Array.from({ length: count }, (_, i) => {
    const from = Math.floor((i * levels.length) / count)
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / count))
    const slice = levels.slice(from, to)
    return Math.max(0.08, slice.reduce((a, b) => a + b, 0) / slice.length / loudest)
  })
}
