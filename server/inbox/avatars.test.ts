import { expect, it } from 'vitest'
import { createLimiter } from './avatars.ts'

it('runs no more jobs at once than allowed, and all of them in the end', async () => {
  const run = createLimiter(2)
  let active = 0
  let most = 0
  const job = (n: number) =>
    run(async () => {
      most = Math.max(most, ++active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return n
    })
  expect(await Promise.all([1, 2, 3, 4, 5].map(job))).toEqual([1, 2, 3, 4, 5])
  expect(most).toBe(2)
  // A failing job frees its slot too.
  await expect(run(() => Promise.reject(new Error('nope')))).rejects.toThrow('nope')
  expect(await Promise.all([job(6), job(7), job(8)])).toEqual([6, 7, 8])
})
