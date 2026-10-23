import { gzipSync, strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { readLottie } from './lottie'

const animation = {
  v: '5.7.4',
  fr: 30,
  ip: 0,
  op: 30,
  w: 128,
  h: 128,
  layers: [{ ty: 4, ip: 0, op: 30, st: 0, ks: {}, shapes: [] }],
  assets: [
    { id: 'outside', w: 10, h: 10, u: 'https://tracker.example/', p: 'pixel.png', e: 0 },
    { id: 'inside', w: 10, h: 10, u: '', p: 'data:image/png;base64,AAAA', e: 1 },
    { id: 'precomp', layers: [] },
  ],
}
const bytes = (value: unknown) => strToU8(JSON.stringify(value))

describe('animated stickers', () => {
  it("reads Telegram's .tgs (gzipped) and WhatsApp's (zipped) the same", async () => {
    const tgs = await readLottie(gzipSync(bytes(animation)))
    expect(tgs.layers).toHaveLength(1)
    const was = await readLottie(zipSync({ 'animation/animation.json': bytes(animation), 'animation/animation.json.overridden_metadata': strToU8('{}') }))
    expect(was.layers).toHaveLength(1)
    // Plain JSON too.
    expect((await readLottie(bytes(animation))).w).toBe(128)
  })

  it('never fetches a picture from elsewhere', async () => {
    const { assets } = await readLottie(gzipSync(bytes(animation)))
    expect(assets?.[0]).toMatchObject({ id: 'outside', u: '', e: 1 })
    expect(String(assets?.[0].p)).toMatch(/^data:/)
    expect(assets?.[1]).toMatchObject({ p: 'data:image/png;base64,AAAA' })
    expect(assets?.[2]).toEqual({ id: 'precomp', layers: [] })
  })

  it('refuses what is not an animation, or would unpack into something huge', async () => {
    await expect(readLottie(bytes({ hello: 'world' }))).rejects.toThrow(/not an animation/)
    await expect(readLottie(zipSync({ 'readme.txt': strToU8('hi') }))).rejects.toThrow(/no animation/)
    // 20 MB of spaces gzips into a few kilobytes.
    const bomb = gzipSync(new Uint8Array(20 * 1024 * 1024).fill(32))
    expect(bomb.length).toBeLessThan(100_000)
    await expect(readLottie(bomb)).rejects.toThrow(/too large/)
  })
})
