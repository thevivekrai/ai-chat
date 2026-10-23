import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { keepAwake } from './keepAwake.ts'
import { waitFor } from './testing/helpers.ts'

it('visits the server while accounts are linked, and not otherwise', async () => {
  let visits = 0
  const server = createServer((req, res) => {
    if (req.url === '/api/health') visits++
    res.end('{"ok":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  let linked = false
  const stop = keepAwake({ url, everyMs: 20, wanted: async () => linked })
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(visits).toBe(0)

  linked = true
  await waitFor(() => expect(visits).toBeGreaterThanOrEqual(2))
  stop()
  const after = visits
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(visits).toBe(after)
  server.close()
})
