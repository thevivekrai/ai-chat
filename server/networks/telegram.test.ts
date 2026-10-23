import { returnBigInt as bigInt } from 'telegram/Helpers.js'
import { Api } from 'telegram'
import { describe, expect, it } from 'vitest'
import { mediaOf, peerOf, reactionsOf, refFromId } from './telegram.ts'

describe('reading GramJS objects', () => {
  it('maps people, groups and channels to marked ids', () => {
    const user = new Api.User({ id: bigInt(5001), firstName: 'Asha', lastName: 'Rao', username: 'asha', accessHash: bigInt(9) })
    expect(peerOf(user)).toEqual({ id: '5001', kind: 'direct', name: 'Asha Rao', handle: '@asha' })
    const noName = new Api.User({ id: bigInt(5002), phone: '919800000000' })
    expect(peerOf(noName)).toMatchObject({ name: '+919800000000', handle: '+919800000000' })
    const me = new Api.User({ id: bigInt(42), self: true, firstName: 'Me' })
    expect(peerOf(me)?.skip).toBe(true)

    const chat = new Api.Chat({ id: bigInt(777), title: 'Old group', photo: new Api.ChatPhotoEmpty(), participantsCount: 3, date: 0, version: 1 })
    expect(peerOf(chat)).toEqual({ id: '-777', kind: 'group', name: 'Old group' })
    const supergroup = new Api.Channel({ id: bigInt(777), title: 'Trek crew', megagroup: true, photo: new Api.ChatPhotoEmpty(), date: 0 })
    expect(peerOf(supergroup)).toEqual({ id: '-100777', kind: 'group', name: 'Trek crew' })
    const channel = new Api.Channel({ id: bigInt(999), title: 'News', broadcast: true, photo: new Api.ChatPhotoEmpty(), date: 0 })
    expect(peerOf(channel)?.skip).toBe(true)
    expect(peerOf(undefined)).toBeNull()
  })

  it('describes media', () => {
    const message = (media?: Api.TypeMessageMedia) =>
      new Api.Message({ id: 1, peerId: new Api.PeerUser({ userId: bigInt(5001) }), date: 0, message: '', media })

    const photo = new Api.Photo({ id: bigInt(1), accessHash: bigInt(1), fileReference: Buffer.alloc(0), date: 0, sizes: [], dcId: 1 })
    expect(mediaOf(message(new Api.MessageMediaPhoto({ photo })))).toMatchObject({ attachment: { kind: 'image', name: 'Photo' } })
    // A photo that has expired (self-destructing) is just gone.
    expect(mediaOf(message(new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: bigInt(1) }) })))).toBeUndefined()
    const document = (attributes: Api.TypeDocumentAttribute[], mimeType = 'application/pdf') =>
      message(
        new Api.MessageMediaDocument({
          document: new Api.Document({
            id: bigInt(1),
            accessHash: bigInt(1),
            fileReference: Buffer.alloc(0),
            date: 0,
            mimeType,
            size: bigInt(20480),
            dcId: 1,
            attributes,
          }),
        }),
      )
    expect(mediaOf(document([new Api.DocumentAttributeFilename({ fileName: 'invoice.pdf' })]))).toEqual({
      attachment: { kind: 'file', name: 'invoice.pdf', size: '20 KB', mime: 'application/pdf' },
      file: true,
    })
    expect(mediaOf(document([new Api.DocumentAttributeAudio({ voice: true, duration: 3 })], 'audio/ogg'))).toEqual({ body: '🎤 Voice message' })
    // Stickers: WebP images, WebM videos and animated .tgs ones (Lottie) are all shown.
    const sticker = [new Api.DocumentAttributeSticker({ alt: '😂', stickerset: new Api.InputStickerSetEmpty() })]
    expect(mediaOf(document(sticker, 'image/webp'))).toEqual({ attachment: { kind: 'sticker', name: '😂 Sticker', mime: 'image/webp' }, file: true })
    expect(mediaOf(document(sticker, 'video/webm'))).toEqual({ attachment: { kind: 'sticker', name: '😂 Sticker', mime: 'video/webm' }, file: true })
    expect(mediaOf(document(sticker, 'application/x-tgsticker'))).toEqual({
      attachment: { kind: 'sticker', name: '😂 Sticker', mime: 'application/x-tgsticker' },
      file: true,
    })
    expect(mediaOf(document(sticker, 'application/unknown-sticker'))).toEqual({ body: '😂 Sticker' })
    expect(mediaOf(message(new Api.MessageMediaGeo({ geo: new Api.GeoPointEmpty() })))).toEqual({ body: '📍 Location' })
    expect(mediaOf(message())).toBeUndefined()
  })
})

describe('reactions from Telegram', () => {
  it('keeps emoji reactions, marks mine, and writes the heart like everyone else', () => {
    const reactions = new Api.MessageReactions({
      results: [
        new Api.ReactionCount({ reaction: new Api.ReactionEmoji({ emoticon: '❤' }), count: 3, chosenOrder: 0 }),
        new Api.ReactionCount({ reaction: new Api.ReactionEmoji({ emoticon: '👍' }), count: 1 }),
        new Api.ReactionCount({ reaction: new Api.ReactionCustomEmoji({ documentId: bigInt(1) }), count: 5 }),
      ],
    })
    expect(reactionsOf(reactions)).toEqual([
      { emoji: '❤️', count: 3, mine: true },
      { emoji: '👍', count: 1, mine: false },
    ])
    expect(reactionsOf(undefined)).toEqual([])
  })
})

describe("Telegram's ids of messages", () => {
  it('are read from ours, for messages the server no longer keeps', () => {
    expect(refFromId('tga:5001', 'tga:5001:12')).toBe(12)
    expect(refFromId('tga:-100777', 'tga:-100777:7')).toBe(7)
    expect(refFromId('tga:5001', 'tga:5002:12')).toBeUndefined()
    expect(refFromId('tga:5001', 'tga:5001:nope')).toBeUndefined()
  })
})
