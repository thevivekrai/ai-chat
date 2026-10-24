import type { Attachment, Contact, Message } from '@/data/types'
import { ME_ID } from '@/data/types'

const EMOJI = /\p{Extended_Pictographic}/u

/** "Priya Nair" → "PN", "Mr. Desai" → "D", "Rajmachi Trek 🏔️" → "🏔️", "#studio-ops" → "#". */
export function initials(name: string): string {
  const emoji = name.match(/\p{Extended_Pictographic}️?/u)
  if (emoji) return emoji[0]
  if (name.startsWith('#')) return '#'
  const words = name
    .replace(/\(.*?\)/g, '')
    .replace(/^(mr|mrs|ms|dr)\.?\s+/i, '')
    .split(/\s+/)
    .filter((w) => /^\p{L}/u.test(w))
  return words
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')
}

export const isEmojiAvatar = (text: string) => EMOJI.test(text)

/** "Priya Nair" → "Priya", "Ramesh (Courier)" → "Ramesh", "Mr. Desai" stays "Mr. Desai". */
export function shortName(name: string): string {
  const clean = name.replace(/\s*\(.*\)\s*$/, '').trim()
  if (/^(mr|mrs|ms|dr)\.?\s/i.test(clean)) return clean
  return clean.split(/\s+/)[0]
}

/** Stable small hash for picking avatar colours. */
export function hashString(value: string): number {
  let h = 0
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** One-line preview for the thread list. */
export function messagePreview(message: Message | undefined, contacts: Record<string, Contact>, isGroup: boolean) {
  if (!message) return 'No messages yet'
  if (message.deleted) return message.senderId === ME_ID ? 'You deleted this message' : 'This message was deleted'
  const text = message.body.replace(/\s+/g, ' ').trim() || attachmentPreview(message.attachments?.[0])
  if (message.senderId === ME_ID) return `You: ${text}`
  if (isGroup) return `${contacts[message.senderId]?.name.split(' ')[0] ?? 'Someone'}: ${text}`
  return text
}

const PLACEHOLDER = /\[[^\]\n]{1,40}\]/g

/** "[price]"-style blanks the AI leaves for facts it can't know. */
export function findPlaceholders(text: string): string[] {
  return text.match(PLACEHOLDER) ?? []
}

export const placeholderPattern = () => new RegExp(PLACEHOLDER.source, 'g')

/** "typing…" in a 1:1 chat; who is, in a group. */
export function typingLabel(names: string[], group: boolean): string {
  if (!group) return 'typing…'
  if (names.length === 1) return `${shortName(names[0])} is typing…`
  return `${names.length} people are typing…`
}

/** "📷 Photo", "Sticker", "📎 Invoice.pdf": a message that's only an attachment, in one line. */
function attachmentPreview(attachment: Attachment | undefined): string {
  if (!attachment) return ''
  if (attachment.kind === 'sticker') return attachment.name
  if (attachment.kind === 'audio') {
    const length = attachment.duration ? ` (${formatDuration(attachment.duration)})` : ''
    return attachment.voice ? `🎤 Voice message${length}` : `🎵 ${attachment.name}${length}`
  }
  return `${attachment.kind === 'image' ? '📷' : '📎'} ${attachment.name}`
}

/** "0:07", "1:05", "1:02:09": how long audio plays, as players show it. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const s = String(total % 60).padStart(2, '0')
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
