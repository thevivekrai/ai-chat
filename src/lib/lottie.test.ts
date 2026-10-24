import { gzipSync, strToU8, Zip, ZipDeflate, zipSync } from 'fflate'
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
    // Inside the file, but put after a path of its own.
    { id: 'disguised', w: 10, h: 10, u: 'https://tracker.example/', p: 'data:x', e: 0 },
  ],
  fonts: {
    list: [
      { fName: 'Linked', fFamily: 'Linked', origin: 1, fPath: 'https://evil.example/x.css' },
      { fName: 'Styled', fFamily: "x; } body { display: none } @font-face { font-family: 'y", origin: 3, fPath: "https://evil.example/f.woff');}" },
      { fName: 'Gilroy', fFamily: 'Gilroy.Bold', origin: 0 },
    ],
  },
  chars: [{ ch: 'A', fFamily: 'Gilroy.Bold', size: 40, data: {} }, 'stray'],
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

  it('never fetches a picture or font from elsewhere', async () => {
    const { assets, fonts } = await readLottie(gzipSync(bytes(animation)))
    expect(assets?.[0]).toMatchObject({ id: 'outside', u: '', e: 1 })
    expect(String(assets?.[0].p)).toMatch(/^data:/)
    expect(assets?.[1]).toMatchObject({ p: 'data:image/png;base64,AAAA' })
    expect(assets?.[2]).toEqual({ id: 'precomp', layers: [] })
    expect(assets?.[3]).toMatchObject({ id: 'disguised', u: '', p: 'data:x', e: 1 })
    // Fonts are the device's own: no path to a style sheet, and a name that can't be CSS.
    expect(fonts).toEqual({
      list: [
        { fName: 'Linked', fFamily: 'Linked', origin: 0 },
        { fName: 'Styled', fFamily: 'x  body  display none  font-face  font-family y', origin: 0 },
        { fName: 'Gilroy', fFamily: 'GilroyBold', origin: 0 },
      ],
    })
    // Its glyphs still find it.
    const { chars } = await readLottie(gzipSync(bytes(animation)))
    expect(chars).toEqual([{ ch: 'A', fFamily: 'GilroyBold', size: 40, data: {} }, 'stray'])
  })

  it('refuses what is not an animation, or would unpack into something huge', async () => {
    await expect(readLottie(bytes({ hello: 'world' }))).rejects.toThrow(/not an animation/)
    await expect(readLottie(zipSync({ 'readme.txt': strToU8('hi') }))).rejects.toThrow(/no animation/)
    // 20 MB of spaces gzips into a few kilobytes.
    const bomb = gzipSync(new Uint8Array(20 * 1024 * 1024).fill(32))
    expect(bomb.length).toBeLessThan(100_000)
    await expect(readLottie(bomb)).rejects.toThrow(/too large/)
    // Stopped early: never unpacked whole first.
    const huge = gzipSync(new Uint8Array(100 * 1024 * 1024))
    const before = process.memoryUsage().arrayBuffers
    await expect(readLottie(huge)).rejects.toThrow(/too large/)
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(32 * 1024 * 1024)
    // A zip only ever has its animation unpacked, not every JSON file in it.
    const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`extra${i}.json`, new Uint8Array(8 * 1024 * 1024)]))
    const zipped = zipSync({ ...many, 'animation/animation.json': bytes(animation) })
    const beforeZip = process.memoryUsage().arrayBuffers
    expect((await readLottie(zipped)).layers).toHaveLength(1)
    expect(process.memoryUsage().arrayBuffers - beforeZip).toBeLessThan(32 * 1024 * 1024)

    // Two entries by the animation's name, the second huge: only the first is unpacked.
    const chunks: Uint8Array[] = []
    const twice = new Zip((error, data) => {
      if (error) throw error
      chunks.push(data)
    })
    const entry = (data: Uint8Array) => {
      const file = new ZipDeflate('animation.json')
      twice.add(file)
      file.push(data, true)
    }
    entry(bytes(animation))
    entry(new Uint8Array(20 * 1024 * 1024))
    twice.end()
    const beforeTwice = process.memoryUsage().arrayBuffers
    expect((await readLottie(new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer()))).layers).toHaveLength(1)
    expect(process.memoryUsage().arrayBuffers - beforeTwice).toBeLessThan(16 * 1024 * 1024)
  }, 30_000)
})
