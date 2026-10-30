import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveApp } from './app.ts'

describe('the site, as search engines see it', () => {
  let base = ''
  let close = () => {}
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'site-'))
    writeFileSync(join(dir, 'index.html'), '<link rel="canonical" href="__SITE_ORIGIN__/" /><div id="root"></div>')
    const app = express()
    serveApp(app, dir)
    const server = app.listen(0)
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    close = () => server.close()
  })
  afterAll(() => close())

  it('names its own address in the page, and won’t take a forged one', async () => {
    expect(await (await fetch(`${base}/`)).text()).toContain(`<link rel="canonical" href="${base}/" />`)
    const forged = await fetch(`${base}/`, { headers: { host: 'evil.example"><script>' } })
    expect(await forged.text()).not.toContain('evil')
  })

  it('answers 404 for an address the app doesn’t have, 200 for one it does', async () => {
    for (const path of ['/', '/demo', '/tasks', '/chat/wa:1', '/settings/profile']) expect((await fetch(base + path)).status).toBe(200)
    for (const path of ['/wp-admin', '/no-such-page', '/404']) expect((await fetch(base + path)).status).toBe(404)
  })

  it('has a robots.txt, a sitemap and an llms.txt', async () => {
    const robots = await (await fetch(`${base}/robots.txt`)).text()
    expect(robots).toContain('Disallow: /api/')
    expect(robots).toContain(`Sitemap: ${base}/sitemap.xml`)
    const sitemap = await (await fetch(`${base}/sitemap.xml`)).text()
    for (const path of ['/info', '/help', '/privacy', '/terms']) expect(sitemap).toContain(`<loc>${base}${path}</loc>`)
    expect(await (await fetch(`${base}/llms.txt`)).text()).toMatch(/^# Sytext/)
  })
})
