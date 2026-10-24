import { fileSize, isPhotoType } from '@/data/server/types'
import type { Attachment } from '@/data/types'

/** Photos the networks send as photos (anything else goes as a file). */
export const isPhoto = (file: Pick<File, 'type'>) => isPhotoType(file.type)

/** How a file being sent shows in the chat until the network has it: a local preview. */
export function previewOf(file: File): Attachment {
  const photo = isPhoto(file)
  return {
    kind: photo ? 'image' : 'file',
    name: photo ? 'Photo' : file.name,
    size: fileSize(file.size),
    ...(file.type ? { mime: file.type } : {}),
    ...(photo ? { url: URL.createObjectURL(file) } : {}),
  }
}

/** The link that saves an attachment, rather than showing it. */
export function downloadUrl(url: string): string {
  return url.startsWith('/api/files/') ? `${url}?download=1` : url
}
