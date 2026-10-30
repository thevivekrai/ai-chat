import { readJson, writeJson } from '@/data/storage'

/**
 * Stickers to send: a built-in pack, the user's own, and the ones used lately.
 *
 * Each is turned into a 512×512 WebP when it's sent — the shape WhatsApp and Telegram expect of a
 * sticker. A browser that can't make WebP (Safari) makes a PNG, which goes as a picture instead.
 */

export interface Sticker {
  /** "emoji:😂" for the built-in pack, "own:<id>" for the user's own. */
  id: string
  /** What it shows, for screen readers and as its name. */
  label: string
  /** The emoji it's drawn from (built-in), or the picture (the user's own). */
  emoji?: string
  url?: string
}

export const BUILT_IN: Sticker[] = [
  ['😂', 'Laughing'],
  ['❤️', 'Love'],
  ['👍', 'Thumbs up'],
  ['🙏', 'Thank you'],
  ['🔥', 'Fire'],
  ['🎉', 'Party'],
  ['😍', 'Heart eyes'],
  ['😢', 'Sad'],
  ['😮', 'Wow'],
  ['👋', 'Hello'],
  ['🤝', 'Deal'],
  ['✅', 'Done'],
  ['☕', 'Coffee'],
  ['🎂', 'Birthday'],
  ['💯', 'Hundred'],
  ['🤔', 'Thinking'],
  ['😴', 'Sleepy'],
  ['🥳', 'Celebrating'],
  ['😎', 'Cool'],
  ['🙌', 'Hooray'],
].map(([emoji, label]) => ({ id: `emoji:${emoji}`, label: label!, emoji: emoji! }))

const OWN_KEY = 'tidings.stickers.own'
const RECENT_KEY = 'tidings.stickers.recent'
/** Kept on this device, in its storage: a few dozen small pictures at most. */
export const MAX_OWN = 24
const MAX_RECENT = 12
const SIZE = 512
/** Past this, a picture is shrunk harder to make it fit as a sticker. */
const MAX_OWN_BYTES = 200 * 1024

export const ownStickers = (): Sticker[] => readJson<Sticker[]>(OWN_KEY) ?? []

export function recentStickers(): Sticker[] {
  const all = new Map([...BUILT_IN, ...ownStickers()].map((s) => [s.id, s]))
  return (readJson<string[]>(RECENT_KEY) ?? []).map((id) => all.get(id)).filter((s): s is Sticker => !!s)
}

export function noteUsed(sticker: Sticker) {
  const recent = (readJson<string[]>(RECENT_KEY) ?? []).filter((id) => id !== sticker.id)
  writeJson(RECENT_KEY, [sticker.id, ...recent].slice(0, MAX_RECENT))
}

export function removeOwn(id: string) {
  writeJson(OWN_KEY, ownStickers().filter((s) => s.id !== id))
  writeJson(RECENT_KEY, (readJson<string[]>(RECENT_KEY) ?? []).filter((r) => r !== id))
}

const canvas = () => {
  const c = document.createElement('canvas')
  c.width = SIZE
  c.height = SIZE
  return c
}

const blobOf = (c: HTMLCanvasElement, quality = 0.9) =>
  new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make the sticker."))), 'image/webp', quality))

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("That picture couldn't be opened."))
    img.src = url
  })

/** A picture as a square sticker, the whole of it showing on a clear background. */
async function drawPicture(url: string): Promise<Blob> {
  const img = await loadImage(url)
  const c = canvas()
  const scale = Math.min(SIZE / img.width, SIZE / img.height)
  const w = img.width * scale
  const h = img.height * scale
  c.getContext('2d')!.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h)
  return blobOf(c)
}

/** An emoji drawn large on a clear background. */
async function drawEmoji(emoji: string): Promise<Blob> {
  const c = canvas()
  const ctx = c.getContext('2d')!
  ctx.font = `${SIZE * 0.8}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(emoji, SIZE / 2, SIZE / 2 + SIZE * 0.04)
  return blobOf(c)
}

/** The file that is sent for a sticker. */
export async function stickerFile(sticker: Sticker): Promise<File> {
  const blob = sticker.emoji ? await drawEmoji(sticker.emoji) : await drawPicture(sticker.url!)
  const ext = blob.type === 'image/webp' ? 'webp' : 'png'
  return new File([blob], `${sticker.label}.${ext}`, { type: blob.type || 'image/png' })
}

const dataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the picture."))
    reader.readAsDataURL(blob)
  })

/** Adds a picture of the user's to their own stickers, made square and small enough to keep. */
export async function addOwn(file: File): Promise<Sticker> {
  if (!file.type.startsWith('image/')) throw new Error('A sticker has to be a picture.')
  const own = ownStickers()
  if (own.length >= MAX_OWN) throw new Error(`You can keep ${MAX_OWN} stickers of your own. Remove one to add another.`)
  const source = URL.createObjectURL(file)
  try {
    const img = await loadImage(source)
    const c = canvas()
    const scale = Math.min(SIZE / img.width, SIZE / img.height)
    c.getContext('2d')!.drawImage(img, (SIZE - img.width * scale) / 2, (SIZE - img.height * scale) / 2, img.width * scale, img.height * scale)
    let blob = await blobOf(c)
    if (blob.size > MAX_OWN_BYTES) blob = await blobOf(c, 0.6)
    if (blob.size > MAX_OWN_BYTES) throw new Error('That picture is too detailed to keep as a sticker.')
    const label = file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Sticker'
    const sticker: Sticker = { id: `own:${Date.now().toString(36)}`, label, url: await dataUrl(blob) }
    writeJson(OWN_KEY, [...own, sticker])
    return sticker
  } finally {
    URL.revokeObjectURL(source)
  }
}
