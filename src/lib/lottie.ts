/**
 * Animated stickers carry a Lottie animation (JSON): Telegram's .tgs files are it gzipped, and
 * WhatsApp's animated stickers (application/was) are a zip with it inside. This reads either, for
 * the app to play with lottie-web.
 *
 * Stickers come from other people, so what's read is bounded (a small file can't unpack into an
 * unbounded one), and pictures the animation would fetch from elsewhere are dropped: it only ever
 * shows what's inside the file.
 */

/** Animated sticker files: Telegram's .tgs and WhatsApp's animated stickers. */
export const isAnimatedSticker = (mime: string | undefined) => mime === 'application/x-tgsticker' || mime === 'application/was'

/** No sticker comes near this; anything bigger is refused rather than unpacked. */
const MAX_ANIMATION_BYTES = 8 * 1024 * 1024

/** A transparent pixel, standing in for any picture that isn't inside the file. */
const NOTHING = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='

export type LottieAnimation = { layers: unknown[]; assets?: Record<string, unknown>[] } & Record<string, unknown>

export async function readLottie(bytes: Uint8Array): Promise<LottieAnimation> {
  const { Gunzip, strFromU8, unzipSync } = await import('fflate')
  let json: Uint8Array
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    // Gzip: unpacked a piece at a time, and stopped once it's bigger than any sticker.
    const pieces: Uint8Array[] = []
    let size = 0
    const gunzip = new Gunzip((piece) => {
      size += piece.length
      if (size > MAX_ANIMATION_BYTES) throw new Error('This sticker is too large to play.')
      pieces.push(piece)
    })
    gunzip.push(bytes, true)
    json = join(pieces, size)
  } else if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // Zip: only its JSON files, and only if they say they're a sensible size.
    const files = unzipSync(bytes, { filter: (f) => f.name.toLowerCase().endsWith('.json') && f.originalSize <= MAX_ANIMATION_BYTES })
    const names = Object.keys(files)
    const main =
      names.find((n) => /(^|\/)animation\.json$/i.test(n)) ?? names.find((n) => !/secondary|meta|trust/i.test(n)) ?? names[0]
    if (!main) throw new Error('There is no animation in this sticker.')
    json = files[main]
  } else {
    json = bytes
  }
  if (json.length > MAX_ANIMATION_BYTES) throw new Error('This sticker is too large to play.')

  const animation = JSON.parse(strFromU8(json)) as LottieAnimation
  if (!animation || typeof animation !== 'object' || !Array.isArray(animation.layers)) throw new Error('This is not an animation.')
  if (Array.isArray(animation.assets)) {
    animation.assets = animation.assets.map((asset) =>
      typeof asset?.p === 'string' && !asset.p.startsWith('data:') ? { ...asset, u: '', p: NOTHING, e: 1 } : asset,
    )
  }
  return animation
}

function join(pieces: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size)
  let at = 0
  for (const piece of pieces) {
    out.set(piece, at)
    at += piece.length
  }
  return out
}
