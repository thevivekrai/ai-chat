import { randomUUID } from 'node:crypto'
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary'
import type { Config } from './config.ts'

/**
 * Images on Cloudinary: profile photos, and pictures received in linked chats (so the browser can
 * show them without talking to WhatsApp or Telegram). Each file gets a random, unguessable id.
 */
export interface Media {
  uploadDataUrl(dataUrl: string, folder: string): Promise<string>
  uploadBuffer(data: Buffer, folder: string): Promise<string>
}

export function createMedia(settings: Config['cloudinary']): Media | null {
  if (!settings) return null
  cloudinary.config({
    cloud_name: settings.cloudName,
    api_key: settings.apiKey,
    api_secret: settings.apiSecret,
    secure: true,
  })
  const options = (folder: string) => ({ folder: `tidings/${folder}`, public_id: randomUUID(), resource_type: 'image' as const })

  return {
    async uploadDataUrl(dataUrl, folder) {
      const result = await cloudinary.uploader.upload(dataUrl, options(folder))
      return result.secure_url
    },
    uploadBuffer(data, folder) {
      return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(options(folder), (error, result?: UploadApiResponse) =>
          error || !result ? reject(error ?? new Error('Upload failed')) : resolve(result.secure_url),
        )
        stream.end(data)
      })
    },
  }
}
