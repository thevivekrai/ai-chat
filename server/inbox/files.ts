import { Readable } from 'node:stream'
import type { Response } from 'express'
import type { ObjectId } from 'mongodb'
import type { Sealer } from '../crypto.ts'
import { HttpError } from '../http.ts'
import { fileSize } from '../../src/data/server/types.ts'

/**
 * Photos and files in linked chats. Nothing is stored: each one gets a link on this server that
 * fetches it from WhatsApp or Telegram when it's opened, and streams it through. The link carries
 * (sealed) what the network needs to find the file again, so it keeps working for messages the
 * server no longer keeps, from the device's own copy.
 *
 * A link only works for the user it was made for, and is useless to anyone without this server's
 * key. Files people send can be anything, so only plain images, video and audio are shown in the
 * page; everything else is always a download, and never runs as part of the site.
 */

/**
  * What a network needs to fetch a file again: WhatsApp's media keys, Telegram's message, or the
  * address Guffshuff keeps a photo at.
  */
export type FileSource =
  | { n: 'wa'; key: { remoteJid: string; id: string; fromMe: boolean; participant?: string }; type: string; media: Record<string, string | number> }
  | { n: 'tg'; chat: string; id: number }
  | { n: 'gs'; url: string }
  | { n: 'ig'; url: string }

export type FileRef = FileSource & { name: string; mime?: string }

/** A file on its way to the browser. */
export interface FileBody {
  data: Buffer | Readable | AsyncIterable<Buffer>
  name: string
  mime?: string
  /** Its exact size, where the network knows it (Telegram's documents). */
  size?: number
  /**
   * Its size as the network reported it when it was sent (WhatsApp's `fileLength`): given for saved
   * downloads, where a progress bar matters, but not for what's shown in the page.
   */
  reportedSize?: number
  /** Told when it turns out not to be the size it was said to be, so it's sent without one next time. */
  sizeWrong?(): void
}

export { MAX_FILE_BYTES } from '../../src/data/server/types.ts'

/** Shown in the page; anything else is served as a download. */
const INLINE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
  'audio/x-m4a',
  'audio/wav',
  'audio/webm',
  'audio/flac',
])

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'audio/flac': 'flac',
  'application/pdf': 'pdf',
}

export function createFileLinks(sealer: Sealer) {
  return {
    /** The link a message's attachment points at. */
    urlFor(userId: ObjectId, ref: FileRef): string {
      const sealed = sealer.sealJson({ ...ref, u: userId.toHexString() })
      return `/api/files/${Buffer.from(sealed.slice(sealed.indexOf(':') + 1), 'base64').toString('base64url')}`
    },

    /** What a link points at, if it's a real link made for this user. */
    open(userId: ObjectId, token: string): FileRef | null {
      try {
        const ref = sealer.openJson<FileRef & { u?: string }>(`v1:${Buffer.from(token, 'base64url').toString('base64')}`)
        if (ref.u !== userId.toHexString()) return null
        delete ref.u
        return ref
      } catch {
        return null
      }
    },
  }
}

export type FileLinks = ReturnType<typeof createFileLinks>

/** A file name that's safe in a header and on disk, with an extension that matches its type. */
export function fileName(name: string, mime?: string): string {
  // Control characters, path separators, and characters Windows refuses in names.
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'file'
  const extension = mime ? EXTENSIONS[mime] : undefined
  return extension && !/\.[a-z0-9]{1,5}$/i.test(clean) ? `${clean}.${extension}` : clean
}

/** Sends a file to the browser: shown in the page if it's a plain image or media, else downloaded. */
export async function serveFile(res: Response, file: FileBody, { download = false } = {}) {
  const mime = file.mime?.split(';')[0]?.trim().toLowerCase()
  const inline = !download && !!mime && INLINE_TYPES.has(mime)
  const name = fileName(file.name, mime)
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  res.setHeader('Content-Type', mime && INLINE_TYPES.has(mime) ? mime : 'application/octet-stream')
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`)
  // Even opened on its own, a file can't run anything as part of this site.
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox")
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
  if (Buffer.isBuffer(file.data)) {
    res.setHeader('Content-Length', file.data.length)
    res.end(file.data)
    return
  }
  const stream = file.data instanceof Readable ? file.data : Readable.from(file.data)
  // Its size, so the browser shows how far a download has got: where the network knows it exactly,
  // or, for a saved download, as it was reported. One that turns out longer or shorter fails,
  // rather than saving a broken file.
  const declared = [file.size, download ? file.reportedSize : undefined].find((n): n is number => !!n && n > 0)
  if (declared) res.setHeader('Content-Length', declared)
  await new Promise<void>((resolve) => {
    let started = false
    let sent = 0
    stream.on('data', (chunk: Buffer) => {
      started = true
      sent += chunk.length
      if (declared && sent > declared) {
        console.error('[files]', `longer than the ${declared} bytes it was said to be`)
        file.sizeWrong?.()
        stream.destroy()
        res.destroy()
        return resolve()
      }
      if (!res.write(chunk)) {
        stream.pause()
        res.once('drain', () => stream.resume())
      }
    })
    stream.on('end', () => {
      if (declared && sent !== declared) {
        console.error('[files]', `${sent} bytes, not the ${declared} it was said to be`)
        file.sizeWrong?.()
        res.destroy()
      } else res.end()
      resolve()
    })
    stream.on('error', (error) => {
      console.error('[files]', error instanceof Error ? error.message : error)
      if (!started && !res.headersSent) {
        res.removeHeader('Content-Disposition')
        res.removeHeader('Content-Length')
        // A failure isn't the file: it mustn't be kept in place of it.
        res.setHeader('Cache-Control', 'no-store')
        res.status(502).type('application/json').json({ error: "The file couldn't be fetched. Try again in a moment." })
      } else res.destroy(error)
      resolve()
    })
    res.on('close', () => {
      if (!res.writableEnded) stream.destroy()
      resolve()
    })
  })
}

/** A file the user is sending, as the browser uploaded it. */
export interface Upload {
  data: Buffer
  name: string
  mime: string
}

/** Reads the upload's description from its headers (the body is the file itself). */
export function uploadOf(headers: Record<string, string | string[] | undefined>, body: unknown): Upload {
  const header = (name: string) => {
    const value = headers[name]
    return typeof value === 'string' ? value : undefined
  }
  const encodedName = header('x-file-name')
  if (!encodedName) throw new HttpError(400, 'Missing the file name.')
  let name: string
  try {
    name = decodeURIComponent(encodedName)
  } catch {
    throw new HttpError(400, 'The file name is malformed.')
  }
  if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'The file is empty.')
  // The body is sent as application/octet-stream whatever the file is (a .json file would otherwise
  // be read as a request); its real type comes separately.
  const type = header('x-file-type')?.split(';')[0]?.trim().toLowerCase()
  const mime = type && /^[a-z]+\/[a-z0-9.+-]+$/.test(type) ? type : 'application/octet-stream'
  return { data: body, name: fileName(name, mime), mime }
}

/** An optional header the browser encoded with encodeURIComponent. */
export function decodedHeader(headers: Record<string, string | string[] | undefined>, name: string, max: number): string | undefined {
  const value = headers[name]
  if (typeof value !== 'string' || !value) return undefined
  let text: string
  try {
    text = decodeURIComponent(value)
  } catch {
    throw new HttpError(400, `The ${name} header is malformed.`)
  }
  if (text.length > max) throw new HttpError(400, `${name} is too long.`)
  return text
}

/** How big a file is, for the chat (as the app shows a file being sent); nothing when unknown. */
export const sizeLabel = (bytes: number | undefined): string | undefined => (bytes && bytes > 0 ? fileSize(bytes) : undefined)
