import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHoldingApp } from './holding.ts'

describe('the server while it has no database', () => {
  let server: Server
  let url: string
  const reason = "Sytext can't reach its database, so accounts are unavailable. It's trying again."

  beforeAll(async () => {
    const app = createHoldingApp({ reason, problem: () => 'unreachable' })
    server = await new Promise<Server>((ready) => {
      const s = app.listen(0, '127.0.0.1', () => ready(s))
    })
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server.close()
  })

  it("passes the host's health check, so the site stays up", async () => {
    const res = await fetch(`${url}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, database: false })
  })

  it('tells the app that accounts are unavailable', async () => {
    const res = await fetch(`${url}/api/config`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      database: false,
      whatsapp: false,
      telegram: false,
      googleClientId: null,
      databaseProblem: 'unreachable',
    })
  })

  it('answers everything else with why, rather than pretending', async () => {
    for (const path of ['/api/inbox', '/api/auth/me']) {
      const res = await fetch(`${url}${path}`)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: reason })
    }
  })
})
