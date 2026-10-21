/** Fake "model is thinking" delays for the demo AI, so its results feel like a model's. */
const RANGES = {
  classify: [350, 1100],
  summarize: [700, 1400],
  tasks: [600, 1200],
  draft: [700, 1700],
  answer: [900, 1700],
} as const

export type LatencyKind = keyof typeof RANGES

const IS_TEST = import.meta.env.MODE === 'test'

export function simulateLatency(kind: LatencyKind): Promise<void> {
  if (IS_TEST) return Promise.resolve()
  const [min, max] = RANGES[kind]
  const ms = min + Math.random() * (max - min)
  return new Promise((resolve) => setTimeout(resolve, ms))
}
