import type { ObjectId } from 'mongodb'
import { Api, TelegramClient, utils } from 'telegram'
import { EditedMessage, type EditedMessageEvent } from 'telegram/events/EditedMessage.js'
import { NewMessage, Raw, type NewMessageEvent } from 'telegram/events/index.js'
import { Logger, LogLevel } from 'telegram/extensions/Logger.js'
import { CustomFile } from 'telegram/client/uploads.js'
import { computeCheck } from 'telegram/Password.js'
import { StringSession } from 'telegram/sessions/index.js'
import QRCode from 'qrcode'
import { isPhotoType, type MessageHint, type ServerOlderMessages, type TelegramCodeResult, type TelegramVerifyResult } from '../../src/data/server/types.ts'
import { withMyReaction } from '../../src/data/reactions.ts'
import type { Attachment, Message, MessageAction, QuotedMessage, Reaction, Thread } from '../../src/data/types.ts'
import type { Sealer } from '../crypto.ts'
import { HttpError } from '../http.ts'
import { createLimiter, createQueue, type Avatars, type Picture } from '../inbox/avatars.ts'
import { sizeLabel, type FileBody, type FileLinks, type FileRef, type Upload } from '../inbox/files.ts'
import { messageChanges } from '../inbox/changes.ts'
import type { InboxStore, StoredMessage } from '../inbox/store.ts'
import type { Hub } from '../realtime.ts'
import type { Accounts } from './accounts.ts'

/**
 * Telegram as the user's own account (not a bot): they enter their phone number, Telegram sends a
 * login code to their Telegram app, and, if they use two-step verification, they enter their
 * password. The resulting session is stored sealed, so the link survives restarts, and shows up in
 * Telegram under Settings → Devices, where it can be ended at any time.
 *
 * This needs an API id and hash for the deployment, from https://my.telegram.org.
 *
 * Ids: thread "tga:<peer id>", message "tga:<peer id>:<message id>", contact "tga:<user id>".
 * Peer ids are Telegram's "marked" ids: people positive, groups negative.
 */

/* ── The client, as this module needs it ───────────────────────────────────── */

/** A chat or a person. */
export interface TgPeer {
  id: string
  kind: 'direct' | 'group'
  /** Empty when Telegram didn't say (the stored name is kept). */
  name: string
  /** People only: @username or phone number. */
  handle?: string
  /** Left out of the inbox: broadcast channels and "Saved Messages". */
  skip?: boolean
}

export interface TgMessage {
  id: number
  chat: TgPeer
  /** Who wrote it, for messages from others in a group. */
  sender?: TgPeer
  out: boolean
  text: string
  /** Unix seconds. */
  date: number
  /** What it carries besides text; `file` when the attachment can be downloaded from Telegram. */
  media?: { body?: string; attachment?: Attachment; file?: boolean }
  /** The message this one replies to, in the same chat. */
  replyToId?: number
  reactions?: Reaction[]
  pinned?: boolean
  /** Unix seconds, if it was edited. */
  editDate?: number
}

export interface TgDialog {
  chat: TgPeer
  unreadCount: number
  /** My messages up to this id have been read by the other side. */
  readOutboxMaxId: number
  date: number
  /** In Telegram's Archive. */
  archived?: boolean
}

export interface TgSelf {
  id: string
  /** @username, or the phone number. */
  label: string
}

export type TgUpdate =
  | { type: 'message'; message: TgMessage }
  | { type: 'edited'; message: TgMessage }
  /** Read on another device; `unreadCount` is what's left. */
  | { type: 'read'; chatId: string; unreadCount: number }
  /** The other side read my messages up to `maxId`. */
  | { type: 'read-outbox'; chatId: string; maxId: number }
  | { type: 'reactions'; chatId: string; messageId: number; reactions: Reaction[] }
  | { type: 'typing'; chatId: string; senderId: string; active: boolean }
  /** Deleted (for everyone, or for me on another device). Private chats' don't say which chat. */
  | { type: 'deleted'; chatId?: string; ids: number[] }
  | { type: 'pinned'; chatId: string; ids: number[]; pinned: boolean }
  /** Moved into or out of the Archive (on another device, or by Telegram when a message comes in). */
  | { type: 'archived'; chatId: string; archived: boolean }

/** The parts of a Telegram client this manager uses; tests pass a fake. */
export interface TgClient {
  connect(): Promise<void>
  disconnect(): Promise<void>
  /** The session to store, once signed in. */
  save(): string
  sendCode(phone: string): Promise<{ phoneCodeHash: string; viaApp: boolean }>
  signIn(phone: string, phoneCodeHash: string, code: string): Promise<TgSelf>
  passwordHint(): Promise<string | undefined>
  checkPassword(password: string): Promise<TgSelf>
  /**
   * Signs in by QR: `onQr` gets a tg://login link to show as a QR code (a new one every half
   * minute or so) until it's scanned in Telegram on a signed-in device. Rejects with
   * SESSION_PASSWORD_NEEDED when two-step verification is on; `checkPassword` finishes then.
   */
  qrLogin(onQr: (link: string) => void, signal: AbortSignal): Promise<TgSelf>
  me(): Promise<TgSelf>
  dialogs(limit: number): Promise<TgDialog[]>
  /** The latest messages, or those before `beforeId`. Newest first. */
  history(chatId: string, limit: number, beforeId?: number): Promise<TgMessage[]>
  message(chatId: string, id: number): Promise<TgMessage | null>
  send(chatId: string, text: string, replyToId?: number): Promise<{ id: number; date: number }>
  /** Sets my reaction; null removes it. */
  react(chatId: string, messageId: number, emoji: string | null): Promise<void>
  edit(chatId: string, messageId: number, text: string): Promise<void>
  /** Deletes for everyone in the chat, or only for me. */
  remove(chatId: string, messageIds: number[], forEveryone: boolean): Promise<void>
  pin(chatId: string, messageId: number, pinned: boolean): Promise<void>
  /** Moves a chat into Telegram's Archive, or back out. */
  archive(chatId: string, archived: boolean): Promise<void>
  setTyping(chatId: string, typing: boolean): Promise<void>
  /** A small profile or chat picture, if there is one. */
  picture(chatId: string): Promise<Buffer | undefined>
  /** The photo or file in a message, fetched now; null if it has none (or the message is gone). */
  download(chatId: string, messageId: number): Promise<{ data: Buffer | AsyncIterable<Buffer>; size?: number } | null>
  /** Sends a photo, or any other file as a document, with a caption. */
  sendFile(chatId: string, file: Upload, caption: string, replyToId?: number): Promise<{ id: number; date: number }>
  markRead(chatId: string, maxId: number): Promise<void>
  logOut(): Promise<void>
  onUpdate(listener: (update: TgUpdate) => void): void
}

export interface TelegramApi {
  apiId: number
  apiHash: string
}

export type CreateTgClient = (session: string, api: TelegramApi) => TgClient

/* ── GramJS ─────────────────────────────────────────────────────────────────── */

type Entity = Api.TypeUser | Api.TypeChat

const handleOf = (user: Api.User) => (user.username ? `@${user.username}` : user.phone ? `+${user.phone}` : 'Telegram')

export function peerOf(entity: Entity | undefined | null): TgPeer | null {
  if (entity instanceof Api.User) {
    const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ')
    return {
      id: utils.getPeerId(entity),
      kind: 'direct',
      name: name || handleOf(entity),
      handle: handleOf(entity),
      ...(entity.self ? { skip: true } : {}),
    }
  }
  if (entity instanceof Api.Chat || entity instanceof Api.ChatForbidden) {
    return { id: utils.getPeerId(entity), kind: 'group', name: entity.title }
  }
  if (entity instanceof Api.Channel || entity instanceof Api.ChannelForbidden) {
    return { id: utils.getPeerId(entity), kind: 'group', name: entity.title, ...(entity.broadcast ? { skip: true } : {}) }
  }
  return null
}

/** For when only the id is known (Telegram leaves the details out of some updates). */
const barePeer = (peer: Api.TypePeer): TgPeer => ({
  id: utils.getPeerId(peer),
  kind: peer instanceof Api.PeerUser ? 'direct' : 'group',
  name: '',
})

export function mediaOf(m: Api.Message): TgMessage['media'] {
  const file = (kind: Attachment['kind'], name: string, fallbackMime?: string): TgMessage['media'] => {
    const size = sizeLabel(Number(m.file?.size) || undefined)
    const mime = m.file?.mimeType || fallbackMime
    return { attachment: { kind, name, ...(size ? { size } : {}), ...(mime ? { mime } : {}) }, file: true }
  }
  if (m.photo) return { attachment: { kind: 'image', name: 'Photo', mime: 'image/jpeg' }, file: true }
  if (m.sticker) {
    const name = `${m.file?.emoji ?? ''} Sticker`.trim()
    const mime = m.file?.mimeType
    // WebP images, WebM videos, and animated .tgs ones (gzipped Lottie) the app plays.
    if (mime !== 'image/webp' && mime !== 'video/webm' && mime !== 'application/x-tgsticker') return { body: name }
    return { attachment: { kind: 'sticker', name, mime }, file: true }
  }
  if (m.voice || m.audio) {
    const about = m.document?.attributes.find((a): a is Api.DocumentAttributeAudio => a instanceof Api.DocumentAttributeAudio)
    const voice = !!m.voice
    const title = [about?.performer, about?.title].filter(Boolean).join(' – ')
    const sound = file('audio', voice ? 'Voice message' : title || m.file?.name || 'Audio', voice ? 'audio/ogg' : 'audio/mpeg')!
    const waveform = about?.waveform?.length ? telegramWaveform(about.waveform) : undefined
    return {
      ...sound,
      attachment: { ...sound.attachment!, ...(voice ? { voice } : {}), ...(about?.duration ? { duration: about.duration } : {}), ...(waveform ? { waveform } : {}) },
    }
  }
  if (m.videoNote) return { body: '📹 Video message' }
  if (m.gif) return { body: 'GIF' }
  if (m.video) return file('file', m.file?.name || 'Video', 'video/mp4')
  if (m.document) return file('file', m.file?.name || 'Document')
  if (m.geo || m.venue) return { body: '📍 Location' }
  if (m.contact) return { body: `👤 ${[m.contact.firstName, m.contact.lastName].filter(Boolean).join(' ') || 'Contact'}` }
  if (m.poll) {
    const question = m.poll.poll.question as unknown
    return { body: `📊 ${typeof question === 'string' ? question : ((question as { text?: string })?.text ?? 'Poll')}` }
  }
  if (m.dice) return { body: m.dice.emoticon }
  return undefined
}

/** A voice message's waveform as Telegram packs it (5-bit levels), as levels 0–100. */
export function telegramWaveform(bytes: Uint8Array): number[] {
  const levels: number[] = []
  for (let bit = 0; bit + 5 <= bytes.length * 8 && levels.length < 100; bit += 5) {
    const at = bit >> 3
    const value = ((bytes[at] | ((bytes[at + 1] ?? 0) << 8)) >> (bit & 7)) & 31
    levels.push(Math.round((value / 31) * 100))
  }
  return levels
}

/** Telegram writes the red heart without the emoji variation selector; everyone else with it. */
const fromTelegramEmoji = (emoji: string) => (emoji === '❤' ? '❤️' : emoji)
const toTelegramEmoji = (emoji: string) => emoji.replace(/\uFE0F/g, '')

/** Telegram's reaction totals; custom emoji and paid stars are left out. */
export function reactionsOf(reactions: Api.TypeMessageReactions | undefined): Reaction[] {
  return (reactions?.results ?? []).flatMap((r) =>
    r.reaction instanceof Api.ReactionEmoji
      ? [{ emoji: fromTelegramEmoji(r.reaction.emoticon), count: r.count, mine: r.chosenOrder !== undefined }]
      : [],
  )
}

const gramLogger = new Logger(LogLevel.ERROR)

/** Typing (or recording, uploading…) is "typing"; a cancel ends it. */
const typingAction = (action: Api.TypeSendMessageAction) => !(action instanceof Api.SendMessageCancelAction)

const SIGN_UP_REQUIRED = Object.assign(new Error('No Telegram account for this number'), { errorMessage: 'SIGN_UP_REQUIRED' })

export const createGramClient: CreateTgClient = (session, api) => {
  const client = new TelegramClient(new StringSession(session), api.apiId, api.apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
    baseLogger: gramLogger,
    deviceModel: 'Sytext',
    systemVersion: 'Server',
    appVersion: '1.0',
  })

  const selfOf = (user: Api.TypeUser): TgSelf =>
    user instanceof Api.User ? { id: utils.getPeerId(user), label: handleOf(user) } : { id: String(user.id), label: 'Telegram' }

  /** After a restart Telegram's peers aren't cached yet; listing chats fills the cache. */
  async function inputPeer(chatId: string) {
    try {
      return await client.getInputEntity(chatId)
    } catch {
      await client.getDialogs({ limit: 200 })
      return client.getInputEntity(chatId)
    }
  }

  async function messageOf(m: Api.TypeMessage): Promise<TgMessage | null> {
    if (!(m instanceof Api.Message)) return null // Service messages ("joined the group") and gaps.
    const media = mediaOf(m)
    if (!m.message && !media) return null
    const chat = peerOf(m.chat ?? (await m.getChat().catch(() => undefined))) ?? barePeer(m.peerId)
    let sender: TgPeer | undefined
    if (!m.out && chat.kind === 'group') {
      sender = peerOf(m.sender ?? (await m.getSender().catch(() => undefined))) ?? (m.fromId ? barePeer(m.fromId) : undefined)
    }
    const replyToId = m.replyTo instanceof Api.MessageReplyHeader ? m.replyTo.replyToMsgId : undefined
    const reactions = reactionsOf(m.reactions)
    return {
      id: m.id,
      chat,
      ...(sender ? { sender } : {}),
      out: !!m.out,
      text: m.message ?? '',
      date: m.date,
      ...(media ? { media } : {}),
      ...(replyToId ? { replyToId } : {}),
      ...(reactions.length ? { reactions } : {}),
      ...(m.pinned ? { pinned: true } : {}),
      ...(m.editDate && !m.editHide ? { editDate: m.editDate } : {}),
    }
  }

  /** Telegram moved the account to another data centre mid-login. */
  const switchDc = (dcId: number) => (client as unknown as { _switchDC(dcId: number): Promise<void> })._switchDC(dcId)

  /** Done when the login token was accepted: the user, or SESSION_PASSWORD_NEEDED thrown. */
  async function loginTokenResult(): Promise<TgSelf | { link: string; expires: number }> {
    const result = await client.invoke(new Api.auth.ExportLoginToken({ apiId: api.apiId, apiHash: api.apiHash, exceptIds: [] }))
    if (result instanceof Api.auth.LoginToken) {
      return { link: `tg://login?token=${Buffer.from(result.token).toString('base64url')}`, expires: result.expires }
    }
    const success =
      result instanceof Api.auth.LoginTokenMigrateTo
        ? await switchDc(result.dcId).then(() => client.invoke(new Api.auth.ImportLoginToken({ token: result.token })))
        : result
    if (success instanceof Api.auth.LoginTokenSuccess && success.authorization instanceof Api.auth.Authorization) {
      return selfOf(success.authorization.user)
    }
    throw SIGN_UP_REQUIRED
  }

  return {
    async connect() {
      await client.connect()
    },
    async disconnect() {
      await client.destroy()
    },
    save: () => (client.session as StringSession).save(),

    async sendCode(phone) {
      const { phoneCodeHash, isCodeViaApp } = await client.sendCode({ apiId: api.apiId, apiHash: api.apiHash }, phone)
      return { phoneCodeHash, viaApp: isCodeViaApp }
    },
    async signIn(phone, phoneCodeHash, code) {
      const result = await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }))
      if (result instanceof Api.auth.AuthorizationSignUpRequired) throw SIGN_UP_REQUIRED
      return selfOf(result.user)
    },
    async passwordHint() {
      const password = await client.invoke(new Api.account.GetPassword())
      return password.hint || undefined
    },
    async checkPassword(password) {
      const settings = await client.invoke(new Api.account.GetPassword())
      const result = await client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(settings, password) }))
      if (result instanceof Api.auth.AuthorizationSignUpRequired) throw SIGN_UP_REQUIRED
      return selfOf(result.user)
    },
    async qrLogin(onQr, signal) {
      let scanned = false
      let wake = () => {}
      client.addEventHandler(
        () => {
          scanned = true
          wake()
        },
        new Raw({ types: [Api.UpdateLoginToken] }),
      )
      for (;;) {
        if (signal.aborted) throw new Error('Cancelled')
        const result = await loginTokenResult()
        if (!('link' in result)) return result
        if (scanned) continue // Scanned while the token was being exported: ask again for the result.
        onQr(result.link)
        // A token lasts about 30 seconds; wait for the scan, then show a new one.
        const lifetime = Math.max(5, Math.min(30, result.expires - Date.now() / 1000)) * 1000
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, lifetime)
          wake = () => {
            clearTimeout(timer)
            resolve()
          }
          signal.addEventListener('abort', wake, { once: true })
        })
      }
    },
    async me() {
      return selfOf(await client.getMe())
    },

    async dialogs(limit) {
      const dialogs = await client.getDialogs({ limit })
      return dialogs.flatMap((d) => {
        const chat = peerOf(d.entity)
        return chat
          ? [{ chat, unreadCount: d.unreadCount, readOutboxMaxId: d.dialog.readOutboxMaxId, date: d.date, ...(d.archived ? { archived: true } : {}) }]
          : []
      })
    },
    async history(chatId, limit, beforeId) {
      const messages = await client.getMessages(await inputPeer(chatId), { limit, ...(beforeId ? { offsetId: beforeId } : {}) })
      return (await Promise.all(messages.map(messageOf))).filter((m): m is TgMessage => !!m)
    },
    async message(chatId, id) {
      const [found] = await client.getMessages(await inputPeer(chatId), { ids: id })
      return found ? messageOf(found) : null
    },
    async send(chatId, text, replyToId) {
      // Sent as typed: no Markdown, so "*" and "_" stay as they are.
      const sent = await client.sendMessage(await inputPeer(chatId), {
        message: text,
        parseMode: false,
        ...(replyToId ? { replyTo: replyToId } : {}),
      })
      return { id: sent.id, date: sent.date }
    },
    async react(chatId, messageId, emoji) {
      await client.invoke(
        new Api.messages.SendReaction({
          peer: await inputPeer(chatId),
          msgId: messageId,
          reaction: emoji ? [new Api.ReactionEmoji({ emoticon: toTelegramEmoji(emoji) })] : [],
        }),
      )
    },
    async edit(chatId, messageId, text) {
      await client.editMessage(await inputPeer(chatId), { message: messageId, text, parseMode: false })
    },
    async remove(chatId, messageIds, forEveryone) {
      await client.deleteMessages(await inputPeer(chatId), messageIds, { revoke: forEveryone })
    },
    async pin(chatId, messageId, pinned) {
      const peer = await inputPeer(chatId)
      if (pinned) await client.pinMessage(peer, messageId, { notify: false })
      else await client.unpinMessage(peer, messageId)
    },
    async archive(chatId, archived) {
      // Telegram's Archive is folder 1; the main list, 0.
      const peer = await inputPeer(chatId)
      await client.invoke(new Api.folders.EditPeerFolders({ folderPeers: [new Api.InputFolderPeer({ peer, folderId: archived ? 1 : 0 })] }))
    },
    async setTyping(chatId, typing) {
      await client.invoke(
        new Api.messages.SetTyping({
          peer: await inputPeer(chatId),
          action: typing ? new Api.SendMessageTypingAction() : new Api.SendMessageCancelAction(),
        }),
      )
    },
    async picture(chatId) {
      const data = await client.downloadProfilePhoto(await inputPeer(chatId), { isBig: false })
      return Buffer.isBuffer(data) && data.length ? data : undefined
    },
    async markRead(chatId, maxId) {
      await client.markAsRead(await inputPeer(chatId), undefined, { maxId, clearMentions: true })
    },
    async download(chatId, messageId) {
      // Fetched again for a fresh file reference: Telegram's expire after a while.
      const [m] = await client.getMessages(await inputPeer(chatId), { ids: messageId })
      if (!(m instanceof Api.Message) || !m.media) return null
      if (m.photo) {
        const data = await client.downloadMedia(m, {})
        return Buffer.isBuffer(data) ? { data } : null
      }
      if (!m.document) return null
      // Documents can be large: streamed a piece at a time rather than held in memory.
      return { data: client.iterDownload({ file: m.media, requestSize: 512 * 1024 }), size: Number(m.document.size) }
    },
    async sendFile(chatId, file, caption, replyToId) {
      const photo = isPhotoType(file.mime)
      const sticker = file.sticker && file.mime === 'image/webp'
      const sent = await client.sendFile(await inputPeer(chatId), {
        file: new CustomFile(file.name, file.data.length, '', file.data),
        caption: sticker ? '' : caption,
        parseMode: false,
        // A sticker is a WebP marked as one; anything but a photo or MP4 video arrives as a file, as
        // sent, rather than recompressed.
        ...(sticker ? { attributes: [new Api.DocumentAttributeSticker({ alt: '🙂', stickerset: new Api.InputStickerSetEmpty() })] } : {}),
        forceDocument: !(sticker || photo || file.mime === 'video/mp4'),
        workers: 1,
        ...(replyToId ? { replyTo: replyToId } : {}),
      })
      return { id: sent.id, date: sent.date }
    },
    async logOut() {
      await client.invoke(new Api.auth.LogOut())
    },

    onUpdate(listener) {
      const forward = (type: 'message' | 'edited') => (event: NewMessageEvent | EditedMessageEvent) =>
        void messageOf(event.message)
          .then((message) => message && listener({ type, message }))
          .catch(report)
      client.addEventHandler(forward('message'), new NewMessage({}))
      client.addEventHandler(forward('edited'), new EditedMessage({}))
      client.addEventHandler(
        (update: Api.TypeUpdate) => {
          if (update instanceof Api.UpdateReadHistoryInbox) {
            listener({ type: 'read', chatId: utils.getPeerId(update.peer), unreadCount: update.stillUnreadCount })
          } else if (update instanceof Api.UpdateReadChannelInbox) {
            const peer = new Api.PeerChannel({ channelId: update.channelId })
            listener({ type: 'read', chatId: utils.getPeerId(peer), unreadCount: update.stillUnreadCount })
          } else if (update instanceof Api.UpdateReadHistoryOutbox) {
            listener({ type: 'read-outbox', chatId: utils.getPeerId(update.peer), maxId: update.maxId })
          } else if (update instanceof Api.UpdateReadChannelOutbox) {
            const peer = new Api.PeerChannel({ channelId: update.channelId })
            listener({ type: 'read-outbox', chatId: utils.getPeerId(peer), maxId: update.maxId })
          } else if (update instanceof Api.UpdateMessageReactions) {
            const chatId = utils.getPeerId(update.peer)
            listener({ type: 'reactions', chatId, messageId: update.msgId, reactions: reactionsOf(update.reactions) })
          } else if (update instanceof Api.UpdateUserTyping) {
            const userId = utils.getPeerId(new Api.PeerUser({ userId: update.userId }))
            listener({ type: 'typing', chatId: userId, senderId: userId, active: typingAction(update.action) })
          } else if (update instanceof Api.UpdateChatUserTyping) {
            const chatId = utils.getPeerId(new Api.PeerChat({ chatId: update.chatId }))
            listener({ type: 'typing', chatId, senderId: utils.getPeerId(update.fromId), active: typingAction(update.action) })
          } else if (update instanceof Api.UpdateChannelUserTyping) {
            const chatId = utils.getPeerId(new Api.PeerChannel({ channelId: update.channelId }))
            listener({ type: 'typing', chatId, senderId: utils.getPeerId(update.fromId), active: typingAction(update.action) })
          } else if (update instanceof Api.UpdateDeleteMessages) {
            listener({ type: 'deleted', ids: update.messages })
          } else if (update instanceof Api.UpdateDeleteChannelMessages) {
            const chatId = utils.getPeerId(new Api.PeerChannel({ channelId: update.channelId }))
            listener({ type: 'deleted', chatId, ids: update.messages })
          } else if (update instanceof Api.UpdatePinnedMessages) {
            listener({ type: 'pinned', chatId: utils.getPeerId(update.peer), ids: update.messages, pinned: !!update.pinned })
          } else if (update instanceof Api.UpdatePinnedChannelMessages) {
            const chatId = utils.getPeerId(new Api.PeerChannel({ channelId: update.channelId }))
            listener({ type: 'pinned', chatId, ids: update.messages, pinned: !!update.pinned })
          } else if (update instanceof Api.UpdateFolderPeers) {
            for (const f of update.folderPeers) listener({ type: 'archived', chatId: utils.getPeerId(f.peer), archived: f.folderId === 1 })
          }
        },
        new Raw({
          types: [
            Api.UpdateReadHistoryInbox,
            Api.UpdateReadChannelInbox,
            Api.UpdateReadHistoryOutbox,
            Api.UpdateReadChannelOutbox,
            Api.UpdateMessageReactions,
            Api.UpdateUserTyping,
            Api.UpdateChatUserTyping,
            Api.UpdateChannelUserTyping,
            Api.UpdateDeleteMessages,
            Api.UpdateDeleteChannelMessages,
            Api.UpdatePinnedMessages,
            Api.UpdatePinnedChannelMessages,
            Api.UpdateFolderPeers,
          ],
        }),
      )
    },
  }
}

/* ── Manager ─────────────────────────────────────────────────────────────────── */

/** How much of each account is copied in when it's linked (and caught up after a restart). */
const DIALOGS_TO_SYNC = 30
const MESSAGES_PER_CHAT = 20
/**
 * How often a linked session is checked: to notice it was ended from another device, and to catch
 * up on messages missed while the connection was down (the Telegram library doesn't).
 */
const CHECK_EVERY_MS = 10 * 60_000
/** Checks in a row that couldn't reach Telegram before the connection is started over. */
const FAILED_CHECKS_TO_RESTART = 2

/** Telegram's own id of a message, from ours ("tga:<peer id>:<message id>"). */
export function refFromId(threadId: string, id: string): number | undefined {
  if (!id.startsWith(`${threadId}:`)) return undefined
  const ref = Number(id.slice(threadId.length + 1))
  return Number.isInteger(ref) && ref > 0 ? ref : undefined
}

/** Errors meaning the session is gone for good: ended from Settings → Devices, or the account deleted. */
const ENDED = new Set(['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'USER_DEACTIVATED', 'USER_DEACTIVATED_BAN'])

const errorCode = (error: unknown) => (error as { errorMessage?: string } | null)?.errorMessage

function report(error: unknown) {
  console.error('[telegram]', error instanceof Error ? error.message : error)
}

function wait(seconds: number) {
  if (seconds < 90) return `${seconds} seconds`
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} minutes`
  return `${Math.round(seconds / 3600)} hours`
}

/** Telegram's error codes, in words for the user. */
function telegramError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  const seconds = (error as { seconds?: number } | null)?.seconds
  if (typeof seconds === 'number') return new HttpError(429, `Telegram asks you to wait ${wait(seconds)} before trying again.`)
  switch (errorCode(error)) {
    case 'PHONE_NUMBER_INVALID':
      return new HttpError(400, 'Telegram doesn\'t recognise that number. Include the country code, like +91 98765 43210.')
    case 'PHONE_NUMBER_BANNED':
      return new HttpError(400, 'Telegram has banned this number.')
    case 'PHONE_NUMBER_FLOOD':
      return new HttpError(429, 'Telegram has sent too many codes to this number. Try again later.')
    case 'PHONE_CODE_INVALID':
    case 'PHONE_CODE_EMPTY':
      return new HttpError(400, 'That code isn\'t right. Check it and try again.')
    case 'PHONE_CODE_EXPIRED':
      return new HttpError(400, 'That code has expired. Get a new one.')
    case 'PASSWORD_HASH_INVALID':
      return new HttpError(400, 'That password isn\'t right.')
    case 'SIGN_UP_REQUIRED':
      return new HttpError(400, 'There\'s no Telegram account for this number. Create one in the Telegram app first.')
    case 'REACTION_INVALID':
    case 'REACTION_EMPTY':
      return new HttpError(400, 'This chat doesn\'t allow that reaction.')
    case 'CHAT_WRITE_FORBIDDEN':
      return new HttpError(403, 'You can\'t write in this chat.')
    case 'MESSAGE_EDIT_TIME_EXPIRED':
      return new HttpError(400, 'This message is too old to edit.')
    case 'MESSAGE_NOT_MODIFIED':
      return new HttpError(400, 'Nothing changed.')
    case 'MESSAGE_DELETE_FORBIDDEN':
      return new HttpError(403, 'Telegram doesn\'t let you delete this message.')
    case 'CHAT_ADMIN_REQUIRED':
      return new HttpError(403, 'Only the chat\'s admins can do that.')
  }
  report(error)
  return new HttpError(502, 'Telegram didn\'t accept that. Try again in a moment.')
}

interface PendingLogin {
  client: TgClient
  /** Empty when signing in by QR. */
  phone: string
  phoneCodeHash: string
  needsPassword: boolean
  timer: ReturnType<typeof setTimeout>
  /** Stops a QR sign-in. */
  abort?: AbortController
}

/** How many old stickers, photos and files without a link are fetched again per connection. */
const FILES_TO_REPAIR = 40

/** How many older messages one "Load earlier" fetches. */
const OLDER_PAGE = 30

interface Session {
  userId: ObjectId
  client: TgClient
  stopped: boolean
  check: ReturnType<typeof setInterval>
  /** Checks in a row that couldn't reach Telegram. */
  failedChecks: number
  /** Chats moved into or out of the Archive, remembered for chats that have no messages here yet. */
  archived: Map<string, boolean>
}

export interface TelegramDeps {
  sealer: Sealer
  store: InboxStore
  accounts: Accounts
  hub: Hub
  avatars: Avatars
  /** Links to photos and files, fetched from Telegram when opened. */
  files: FileLinks
  /** Without it, linking Telegram is switched off. */
  api: TelegramApi | undefined
  createClient?: CreateTgClient
  /** How long a login code can be used. */
  codeTtlMs?: number
}

type CodeResult = TelegramCodeResult
type VerifyResult = TelegramVerifyResult

export function createTelegram(deps: TelegramDeps) {
  const { sealer, store, accounts, hub, avatars, files, api } = deps
  const { changeMessage, removeForMe, addFileLinks } = messageChanges({ store, hub })
  const createClient = deps.createClient ?? createGramClient
  const pending = new Map<string, PendingLogin>()
  const pictures = createQueue()
  const sessions = new Map<string, Session>()
  const retries = new Map<string, ReturnType<typeof setTimeout>>()
  /** Users whose session is being started, so two starts never overlap. */
  const starting = new Set<string>()
  /** Pictures someone is waiting to see, fetched a few at a time. */
  const live = createLimiter(3)
  const keyOf = (userId: ObjectId) => userId.toHexString()
  const publish = (s: Session, event: Parameters<Hub['publish']>[1]) => hub.publish(keyOf(s.userId), event)

  function requireApi(): TelegramApi {
    if (!api) throw new HttpError(404, 'Telegram sign-in is not set up on this server.')
    return api
  }

  async function dropPending(userId: ObjectId) {
    const p = pending.get(keyOf(userId))
    if (!p) return
    pending.delete(keyOf(userId))
    clearTimeout(p.timer)
    p.abort?.abort()
    await p.client.disconnect().catch(() => undefined)
  }

  /** Checks a person's or chat's picture, in the background. */
  function fetchPicture(s: Session, peer: TgPeer) {
    const id = `tga:${peer.id}`
    pictures.add(`${keyOf(s.userId)}:${id}`, async () => {
      if (s.stopped || (await avatars.fresh(s.userId, id))) return
      await lookUpPicture(s, peer)
    })
  }

  /** Downloads a picture, records it, and puts its URL on the contact or chat. */
  async function lookUpPicture(s: Session, peer: TgPeer): Promise<Picture | null> {
    const id = `tga:${peer.id}`
    const data = await s.client.picture(peer.id).catch(() => undefined)
    if (s.stopped) return null
    const picture = data ? { data, contentType: 'image/jpeg' } : null
    const url = await avatars.save(s.userId, id, picture)
    if (!url) return null
    if (peer.kind === 'group') {
      const thread = await store.setThreadAvatar(s.userId, id, url)
      if (thread) publish(s, { type: 'thread.updated', thread })
    } else {
      // The picture can be ready before the contact is: make sure there's one to put it on.
      if (!(await store.contact(s.userId, id))) await upsertContact(s, peer)
      const contact = await store.setContactAvatar(s.userId, id, url)
      if (contact) publish(s, { type: 'contact.updated', contact })
    }
    return picture
  }

  /** What a reply quotes: the stored message, or Telegram's copy if it isn't stored. */
  async function quotedFor(s: Session, m: TgMessage): Promise<QuotedMessage | undefined> {
    if (!m.replyToId) return undefined
    const id = `tga:${m.chat.id}:${m.replyToId}`
    const stored = await store.message(s.userId, id)
    if (stored) return { id, senderId: stored.senderId, body: stored.body || stored.attachments?.[0]?.name || '' }
    const original = await s.client.message(m.chat.id, m.replyToId).catch(() => null)
    if (!original) return { id, senderId: 'unknown', body: '' }
    const senderId = original.out ? 'me' : `tga:${(m.chat.kind === 'direct' ? m.chat : (original.sender ?? m.chat)).id}`
    return { id, senderId, body: original.text || original.media?.body || original.media?.attachment?.name || '' }
  }

  /* ── Incoming data ───────────────────────────────────────────────────────── */

  async function upsertContact(s: Session, peer: TgPeer) {
    if (!peer.name) return
    const contact = { id: `tga:${peer.id}`, name: peer.name, network: 'telegram' as const, handle: peer.handle ?? '' }
    if (await store.upsertContact(s.userId, contact)) publish(s, { type: 'contact.updated', contact })
  }

  /** Stores a message; returns it, and whether it's new to the server. */
  async function saveMessage(
    s: Session,
    m: TgMessage,
    { live, readOutboxMaxId = 0 }: { live: boolean; readOutboxMaxId?: number },
  ): Promise<{ message: Message; added: boolean } | null> {
    if (m.chat.skip) return null
    const threadId = `tga:${m.chat.id}`
    const sentAt = new Date(m.date * 1000)
    const direct = m.chat.kind === 'direct'
    const known = await store.thread(s.userId, threadId)
    if (!known) fetchPicture(s, m.chat)
    await store.upsertThread(s.userId, {
      id: threadId,
      network: 'telegram',
      kind: m.chat.kind,
      // Keep the stored name when this update didn't carry one.
      ...(m.chat.name ? { title: m.chat.name } : known ? {} : { title: 'Telegram chat' }),
      ...(direct ? { participantIds: [threadId] } : {}),
      ...(!known && s.archived.get(m.chat.id) ? { archived: true } : {}),
      lastAt: sentAt,
    })
    if (direct) await upsertContact(s, m.chat)

    let senderId = 'me'
    if (!m.out) {
      // In a group, a post with no known author (an anonymous admin, say) is shown as the group's.
      const sender = direct ? m.chat : (m.sender ?? m.chat)
      senderId = `tga:${sender.id}`
      if (!direct) {
        await upsertContact(s, sender.name ? sender : { ...sender, name: known?.title ?? 'Telegram' })
        await store.addParticipant(s.userId, threadId, senderId)
        if (sender.kind === 'direct') fetchPicture(s, sender)
      }
    }
    const replyTo = await quotedFor(s, m)

    const message: StoredMessage = {
      id: `tga:${m.chat.id}:${m.id}`,
      threadId,
      senderId,
      body: m.text || m.media?.body || '',
      sentAt: sentAt.toISOString(),
      ...(m.out ? { status: m.id <= readOutboxMaxId ? 'read' : 'sent' } : {}),
      ...(m.media?.attachment ? { attachments: [attachmentOf(s.userId, m.chat.id, m.id, m.media)] } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(m.reactions?.length ? { reactions: m.reactions } : {}),
      ...(m.pinned ? { pinned: true } : {}),
      ...(m.editDate ? { editedAt: new Date(m.editDate * 1000).toISOString() } : {}),
      ref: { id: m.id },
    }
    const { ref, ...wire } = message
    void ref
    const added = await store.addMessage(s.userId, message)
    // Already kept, but without a link to its sticker, photo or file (kept before they could be opened).
    if (!added && message.attachments?.some((a) => a.url)) await addFileLinks(s.userId, message.id, message.body, message.attachments)
    if (!added || !live) return { message: wire, added }

    if (!m.out) await store.incrementUnread(s.userId, threadId)
    const thread = await store.thread(s.userId, threadId)
    if (thread) publish(s, { type: 'thread.updated', thread })
    publish(s, { type: 'message.created', message: wire })
    return { message: wire, added }
  }

  /**
   * Stickers, photos and files kept before they could be opened (a sticker was only named) are
   * fetched from Telegram again, newest first, and gain their link. Once per connection.
   */
  async function repairFiles(s: Session) {
    // Each is asked for at most once a day, found or not (a chat left since may refuse every
    // time), so the ones after it get their turn.
    const asked: string[] = []
    try {
      for (const m of await store.missingFiles(s.userId, 'tga:', FILES_TO_REPAIR)) {
        if (s.stopped) break
        asked.push(m.id)
        const id = Number(m.ref?.id)
        if (!id) continue
        const fresh = await s.client.message(m.threadId.slice('tga:'.length), id).catch(() => null)
        if (fresh) await saveMessage(s, fresh, { live: false }).catch(report)
      }
    } finally {
      await store.markFilesAsked(s.userId, asked)
    }
  }

  /** A message's attachment, linked so it can be opened when Telegram has it as a file. */
  function attachmentOf(userId: ObjectId, chatId: string, messageId: number, media: NonNullable<TgMessage['media']>): Attachment {
    const attachment = media.attachment!
    if (!media.file) return attachment
    const ref: FileRef = { n: 'tg', chat: chatId, id: messageId, name: attachment.name, ...(attachment.mime ? { mime: attachment.mime } : {}) }
    return { ...attachment, url: files.urlFor(userId, ref) }
  }

  async function onUpdate(s: Session, update: TgUpdate) {
    if (s.stopped) return
    switch (update.type) {
      case 'message':
        await saveMessage(s, update.message, { live: true })
        return
      case 'edited': {
        const m = update.message
        // Telegram also reports changes that aren't edits (a link preview loading, say): those have no edit date.
        return changeMessage(s.userId, `tga:${m.chat.id}:${m.id}`, {
          body: m.text || m.media?.body || '',
          ...(m.editDate ? { editedAt: new Date(m.editDate * 1000).toISOString() } : {}),
          pinned: !!m.pinned,
        })
      }
      case 'deleted': {
        // Private chats' and small groups' deletions name only the messages (their ids are the account's own).
        const gone = update.chatId
          ? update.ids.map((id) => ({ id: `tga:${update.chatId}:${id}`, threadId: `tga:${update.chatId}` }))
          : (await store.byRefIds(s.userId, 'tga:', update.ids)).filter((m) => !m.threadId.startsWith('tga:-100'))
        for (const m of gone) await removeForMe(s.userId, m.threadId, m.id)
        return
      }
      case 'pinned':
        for (const id of update.ids) await changeMessage(s.userId, `tga:${update.chatId}:${id}`, { pinned: update.pinned })
        return
      case 'archived': {
        s.archived.set(update.chatId, update.archived)
        const thread = await store.setArchived(s.userId, `tga:${update.chatId}`, update.archived)
        if (thread) publish(s, { type: 'thread.updated', thread })
        return
      }
      case 'read': {
        const threadId = `tga:${update.chatId}`
        if (!(await store.thread(s.userId, threadId))) return
        await store.setUnread(s.userId, threadId, Math.max(0, update.unreadCount))
        const thread = await store.thread(s.userId, threadId)
        if (thread) publish(s, { type: 'thread.updated', thread })
        return
      }
      case 'read-outbox':
        for (const message of await store.markSentRead(s.userId, `tga:${update.chatId}`, update.maxId)) {
          publish(s, { type: 'message.updated', message })
        }
        return
      case 'reactions': {
        const message = await store.setReactionTotals(s.userId, `tga:${update.chatId}:${update.messageId}`, update.reactions)
        if (message) publish(s, { type: 'message.updated', message })
        return
      }
      case 'typing': {
        const threadId = `tga:${update.chatId}`
        if (await store.thread(s.userId, threadId)) {
          publish(s, { type: 'typing', threadId, senderId: `tga:${update.senderId}`, active: update.active })
        }
      }
    }
  }

  /**
   * Copies in the latest chats; on later runs (catching up) only the ones with something new.
   * The browser is told to reload when anything changed, or always with `announce`.
   */
  async function sync(s: Session, { announce = true } = {}) {
    const dialogs = await s.client.dialogs(DIALOGS_TO_SYNC)
    let added = 0
    for (const d of dialogs) {
      if (s.stopped) return
      if (d.chat.skip) continue
      const threadId = `tga:${d.chat.id}`
      const latest = await store.latestMessageAt(s.userId, threadId)
      await store.upsertThread(s.userId, {
        id: threadId,
        network: 'telegram',
        kind: d.chat.kind,
        title: d.chat.name || 'Telegram chat',
        ...(d.chat.kind === 'direct' ? { participantIds: [threadId] } : {}),
        archived: !!d.archived,
        lastAt: new Date(d.date * 1000),
      })
      if (d.chat.kind === 'direct') await upsertContact(s, d.chat)
      fetchPicture(s, d.chat)
      if (!latest || latest.getTime() < d.date * 1000) {
        for (const m of await s.client.history(d.chat.id, MESSAGES_PER_CHAT)) {
          if ((await saveMessage(s, m, { live: false, readOutboxMaxId: d.readOutboxMaxId }))?.added) added++
        }
      }
      // Counted once the new messages are in, so those since an Incognito read all count.
      await store.setUnread(s.userId, threadId, d.unreadCount)
    }
    if (s.stopped) return
    if (announce || added) publish(s, { type: 'reloaded' })
    const account = await accounts.get(s.userId, 'telegram')
    if (account?.status === 'connected' && account.detail) await accounts.set(s.userId, 'telegram', { status: 'connected' })
  }

  /* ── Lifecycle ───────────────────────────────────────────────────────────── */

  function start(userId: ObjectId, client: TgClient): Session {
    const s: Session = {
      userId,
      client,
      stopped: false,
      check: setInterval(() => void check(s).catch(report), CHECK_EVERY_MS),
      failedChecks: 0,
      archived: new Map(),
    }
    s.check.unref()
    sessions.set(keyOf(userId), s)
    client.onUpdate((update) => void onUpdate(s, update).catch(report))
    return s
  }

  async function stop(s: Session) {
    s.stopped = true
    clearInterval(s.check)
    if (sessions.get(keyOf(s.userId)) === s) sessions.delete(keyOf(s.userId))
    await s.client.disconnect().catch(() => undefined)
  }

  /** Notices a session that was ended from another device, and catches up on missed messages. */
  async function check(s: Session) {
    try {
      await s.client.me()
    } catch (error) {
      if (ENDED.has(errorCode(error) ?? '')) {
        await stop(s)
        await ended(s.userId)
        return
      }
      // A network problem: the client reconnects on its own, but if it keeps failing, start over.
      if (++s.failedChecks < FAILED_CHECKS_TO_RESTART) return
      await stop(s)
      await accounts.set(s.userId, 'telegram', { status: 'error', detail: 'Can\'t reach Telegram. Retrying…' })
      const account = await accounts.get(s.userId, 'telegram')
      if (account?.session) await resume(s.userId, account.session)
      return
    }
    s.failedChecks = 0
    await sync(s, { announce: false })
  }

  async function ended(userId: ObjectId) {
    await accounts.set(userId, 'telegram', {
      status: 'disconnected',
      session: '',
      detail: 'This session was ended in Telegram (Settings → Devices). Link it again to keep syncing.',
    })
  }

  async function resume(userId: ObjectId, sealedSession: string, attempt = 0) {
    const key = keyOf(userId)
    retries.delete(key)
    if (sessions.has(key) || starting.has(key) || !api) return
    starting.add(key)
    try {
      await connectAndSync(userId, sealedSession, attempt)
    } finally {
      starting.delete(key)
    }
  }

  async function connectAndSync(userId: ObjectId, sealedSession: string, attempt: number) {
    if (!api) return
    let session: string
    try {
      session = sealer.open(sealedSession)
    } catch {
      await accounts.set(userId, 'telegram', {
        status: 'disconnected',
        session: '',
        detail: "The server's encryption key changed, so the session can't be used. Link Telegram again.",
      })
      return
    }
    const client = createClient(session, api)
    try {
      await client.connect()
      await client.me() // Confirms the session still works, and asks Telegram for updates.
    } catch (error) {
      await client.disconnect().catch(() => undefined)
      if (ENDED.has(errorCode(error) ?? '')) return ended(userId)
      report(error)
      await accounts.set(userId, 'telegram', { status: 'error', detail: 'Can\'t reach Telegram. Retrying…' })
      const delay = Math.min(15 * 60_000, 30_000 * 2 ** attempt)
      retries.set(keyOf(userId), setTimeout(() => void resume(userId, sealedSession, attempt + 1).catch(report), delay))
      return
    }
    const account = await accounts.get(userId, 'telegram')
    if (account?.status !== 'connected') await accounts.set(userId, 'telegram', { status: 'connected' })
    const s = start(userId, client)
    await sync(s)
    void repairFiles(s).catch(report)
  }

  return {
    enabled: !!api,

    /** Step 1: Telegram sends a login code to the user's Telegram app (or by SMS). */
    async requestCode(userId: ObjectId, rawPhone: string): Promise<CodeResult> {
      const credentials = requireApi()
      if (sessions.has(keyOf(userId))) throw new HttpError(409, 'Telegram is already linked. Unlink it first.')
      const digits = rawPhone.replace(/\D/g, '')
      if (digits.length < 8 || digits.length > 15) {
        throw new HttpError(400, 'Enter your Telegram number with its country code, like +91 98765 43210.')
      }
      const phone = `+${digits}`
      await dropPending(userId)

      const client = createClient('', credentials)
      let sent: { phoneCodeHash: string; viaApp: boolean }
      try {
        await client.connect()
        sent = await client.sendCode(phone)
      } catch (error) {
        await client.disconnect().catch(() => undefined)
        throw telegramError(error)
      }
      pending.set(keyOf(userId), {
        client,
        phone,
        phoneCodeHash: sent.phoneCodeHash,
        needsPassword: false,
        timer: setTimeout(() => void expire(userId).catch(report), deps.codeTtlMs ?? 10 * 60_000),
      })
      await accounts.set(userId, 'telegram', {
        status: 'linking',
        step: 'code',
        label: phone,
        detail: sent.viaApp ? 'Enter the code Telegram sent to your Telegram app.' : 'Enter the code Telegram sent you by SMS.',
      })
      return { via: sent.viaApp ? 'app' : 'sms' }
    },

    /**
     * Signing in by QR instead: resolves with the first QR code (a data: URL). Fresh ones follow as
     * `account.qr` events until it's scanned in Telegram (Settings → Devices → Link Desktop
     * Device); then the account connects, or asks for the two-step password.
     */
    async startQr(userId: ObjectId): Promise<{ qr: string }> {
      const credentials = requireApi()
      if (sessions.has(keyOf(userId))) throw new HttpError(409, 'Telegram is already linked. Unlink it first.')
      await dropPending(userId)

      const client = createClient('', credentials)
      try {
        await client.connect()
      } catch (error) {
        await client.disconnect().catch(() => undefined)
        throw telegramError(error)
      }
      const p: PendingLogin = {
        client,
        phone: '',
        phoneCodeHash: '',
        needsPassword: false,
        timer: setTimeout(() => void expire(userId).catch(report), deps.codeTtlMs ?? 10 * 60_000),
        abort: new AbortController(),
      }
      pending.set(keyOf(userId), p)
      await accounts.set(userId, 'telegram', { status: 'linking', step: 'qr', detail: 'Waiting for you to scan the QR code in Telegram…' })

      return new Promise((resolve, reject) => {
        let first = true
        const show = async (link: string) => {
          const qr = await QRCode.toDataURL(link, { margin: 1, width: 288 })
          if (first) {
            first = false
            resolve({ qr })
          } else hub.publish(keyOf(userId), { type: 'account.qr', network: 'telegram', qr })
        }
        client
          .qrLogin((link) => void show(link).catch(report), p.abort!.signal)
          .then((self) => finishLink(userId, p, self))
          .catch(async (error) => {
            if (pending.get(keyOf(userId)) !== p) return // Cancelled, or replaced by a new attempt.
            if (errorCode(error) === 'SESSION_PASSWORD_NEEDED') {
              p.needsPassword = true
              const hint = await client.passwordHint().catch(() => undefined)
              await accounts.set(userId, 'telegram', {
                status: 'linking',
                step: 'password',
                detail: 'Enter your two-step verification password.',
                ...(hint ? { hint } : {}),
              })
              return
            }
            const problem = telegramError(error)
            await dropPending(userId)
            await accounts.set(userId, 'telegram', { status: 'disconnected', detail: problem.message })
            if (first) reject(problem)
          })
      })
    },

    /** Step 2: the code. Accounts with two-step verification then need their password. */
    async verifyCode(userId: ObjectId, code: string): Promise<VerifyResult> {
      const p = pending.get(keyOf(userId))
      if (!p) throw new HttpError(400, 'That code has expired. Get a new one.')
      if (p.needsPassword) throw new HttpError(400, 'Enter your two-step verification password.')
      try {
        const self = await p.client.signIn(p.phone, p.phoneCodeHash, code.replace(/\D/g, ''))
        await finishLink(userId, p, self)
        return { status: 'connected' }
      } catch (error) {
        if (errorCode(error) === 'SESSION_PASSWORD_NEEDED') {
          p.needsPassword = true
          const hint = await p.client.passwordHint().catch(() => undefined)
          await accounts.set(userId, 'telegram', {
            status: 'linking',
            step: 'password',
            label: p.phone,
            detail: 'Enter your two-step verification password.',
            ...(hint ? { hint } : {}),
          })
          return { status: 'password', ...(hint ? { hint } : {}) }
        }
        if (errorCode(error) === 'PHONE_CODE_EXPIRED') await expire(userId)
        throw telegramError(error)
      }
    },

    /** Step 3, only with two-step verification. */
    async verifyPassword(userId: ObjectId, password: string): Promise<VerifyResult> {
      const p = pending.get(keyOf(userId))
      if (!p?.needsPassword) throw new HttpError(400, 'Start again: get a new code or QR code first.')
      try {
        await finishLink(userId, p, await p.client.checkPassword(password))
        return { status: 'connected' }
      } catch (error) {
        throw telegramError(error)
      }
    },

    async unlink(userId: ObjectId) {
      await dropPending(userId)
      clearTimeout(retries.get(keyOf(userId)))
      retries.delete(keyOf(userId))
      const s = sessions.get(keyOf(userId))
      if (s) {
        s.stopped = true
        await withTimeout(s.client.logOut(), 10_000).catch(() => undefined) // Ends it in Telegram's Devices list too.
        await stop(s)
      } else {
        // Not connected right now (say, Telegram was unreachable): still try to end the session.
        const account = await accounts.get(userId, 'telegram')
        let session = ''
        try {
          session = account?.session ? sealer.open(account.session) : ''
        } catch {
          // Sealed with another key: nothing to log out with.
        }
        if (session && api) {
          const client = createClient(session, api)
          await withTimeout(
            client.connect().then(() => client.logOut()),
            10_000,
          ).catch(() => undefined)
          await client.disconnect().catch(() => undefined)
        }
      }
      await pictures.settled()
      await store.forgetNetwork(userId, 'tga:')
      avatars.forget(userId, 'tga:')
      await accounts.remove(userId, 'telegram')
      hub.publish(keyOf(userId), { type: 'reloaded' })
    },

    /** `quotedHint` is what the device knows of the message replied to, in case the server no longer has it. */
    async send(userId: ObjectId, threadId: string, body: string, replyToId?: string, quotedHint?: MessageHint): Promise<Message> {
      const s = connected(userId)
      const chatId = threadId.slice('tga:'.length)
      const stored = replyToId ? await store.message(userId, replyToId) : null
      const hint = !stored && quotedHint?.id === replyToId ? quotedHint : undefined
      const quoted = stored ?? (hint ? { id: hint.id, senderId: hint.senderId, body: hint.body ?? '' } : null)
      const quotedRef = Number(stored?.ref?.id) || (hint ? refFromId(threadId, hint.id) : undefined)
      let sent: { id: number; date: number }
      try {
        sent = await s.client.send(chatId, body, quotedRef)
      } catch (error) {
        throw telegramError(error)
      }
      const message: StoredMessage = {
        id: `tga:${chatId}:${sent.id}`,
        threadId,
        senderId: 'me',
        body,
        sentAt: new Date(sent.date * 1000).toISOString(),
        status: 'sent',
        ...(quoted && quotedRef ? { replyTo: { id: quoted.id, senderId: quoted.senderId, body: quoted.body } } : {}),
        ref: { id: sent.id },
      }
      await store.addMessage(userId, message)
      const { ref, ...wire } = message
      void ref
      return wire
    },

    /**
     * Edits, deletes, pins or stars a message. Telegram has no stars: those are kept in Sytext.
     * Deleted messages go, for everyone or only for me, as in Telegram's own apps. Returns the
     * message as the server now keeps it (null when it doesn't: the device changes its own copy),
     * or that it was removed.
     */
    async act(userId: ObjectId, threadId: string, messageId: string, action: MessageAction, hint?: MessageHint): Promise<{ message: Message | null; removed?: true }> {
      const s = connected(userId)
      const chatId = threadId.slice('tga:'.length)
      const target = await store.message(userId, messageId)
      if (target && target.threadId !== threadId) throw new HttpError(404, 'That message is gone.')
      const ref = Number(target?.ref?.id) || refFromId(threadId, messageId)
      if (!ref) throw new HttpError(404, 'That message is gone.')
      const mine = (target?.senderId ?? (hint?.id === messageId ? hint.senderId : undefined)) === 'me'
      // A pin or star of a message the server no longer keeps keeps it again, once it's done.
      const keepCopy = async () => {
        if (!target && hint?.id === messageId) await store.keepFlagged(userId, threadId, hint, action, { id: ref })
      }
      try {
        switch (action.type) {
          case 'edit':
            if (!mine) throw new HttpError(403, 'Only your own messages can be edited.')
            await s.client.edit(chatId, ref, action.body)
            return { message: await changeMessage(userId, messageId, { body: action.body, editedAt: new Date().toISOString() }) }
          case 'delete':
            if (action.forEveryone && !mine) throw new HttpError(403, 'Only your own messages can be deleted for everyone.')
            // Supergroups and channels have no "delete for me" (deleting there deletes for everyone), so
            // there it's only removed from Sytext.
            if (action.forEveryone || !chatId.startsWith('-100')) await s.client.remove(chatId, [ref], action.forEveryone)
            await removeForMe(userId, threadId, messageId)
            return { message: null, removed: true }
          case 'pin':
            await s.client.pin(chatId, ref, action.pinned)
            await keepCopy()
            return { message: await changeMessage(userId, messageId, { pinned: action.pinned }) }
          case 'star':
            await keepCopy()
            return { message: await changeMessage(userId, messageId, { starred: action.starred }) }
        }
      } catch (error) {
        throw telegramError(error)
      }
    },

    /** Moves a chat into Telegram's Archive or back out, as Telegram's own apps do. */
    async archive(userId: ObjectId, threadId: string, archived: boolean): Promise<Thread> {
      const s = connected(userId)
      try {
        await s.client.archive(threadId.slice('tga:'.length), archived)
      } catch (error) {
        throw telegramError(error)
      }
      const thread = await store.setArchived(userId, threadId, archived)
      if (!thread) throw new HttpError(404, 'No such chat.')
      hub.publish(keyOf(userId), { type: 'thread.updated', thread })
      return thread
    },

    /** Sends a photo or file, with the text as its caption. Telegram keeps it; Sytext only passes it on. */
    async sendFile(userId: ObjectId, threadId: string, upload: Upload, caption: string, replyToId?: string, quotedHint?: MessageHint): Promise<Message> {
      const s = connected(userId)
      const chatId = threadId.slice('tga:'.length)
      const stored = replyToId ? await store.message(userId, replyToId) : null
      const hint = !stored && quotedHint?.id === replyToId ? quotedHint : undefined
      const quoted = stored ?? (hint ? { id: hint.id, senderId: hint.senderId, body: hint.body ?? '' } : null)
      const quotedRef = Number(stored?.ref?.id) || (hint ? refFromId(threadId, hint.id) : undefined)
      let sent: { id: number; date: number }
      try {
        sent = await s.client.sendFile(chatId, upload, caption, quotedRef)
      } catch (error) {
        throw telegramError(error)
      }
      const photo = isPhotoType(upload.mime)
      const size = sizeLabel(upload.data.length)
      const media = {
        // Telegram keeps every photo as a JPEG, whatever was sent.
        attachment: { kind: photo ? ('image' as const) : ('file' as const), name: photo ? 'Photo' : upload.name, mime: photo ? 'image/jpeg' : upload.mime, ...(size ? { size } : {}) },
        file: true,
      }
      const message: StoredMessage = {
        id: `tga:${chatId}:${sent.id}`,
        threadId,
        senderId: 'me',
        body: caption,
        sentAt: new Date(sent.date * 1000).toISOString(),
        status: 'sent',
        attachments: [attachmentOf(userId, chatId, sent.id, media)],
        ...(quoted && quotedRef ? { replyTo: { id: quoted.id, senderId: quoted.senderId, body: quoted.body } } : {}),
        ref: { id: sent.id },
      }
      await store.addMessage(userId, message)
      const { ref, ...wire } = message
      void ref
      return wire
    },

    /** A photo or file from a link, fetched from Telegram now. */
    async openFile(userId: ObjectId, ref: FileRef): Promise<FileBody> {
      if (ref.n !== 'tg') throw new HttpError(404, 'No such file.')
      const s = sessions.get(keyOf(userId))
      if (!s) throw new HttpError(409, "Telegram isn't connected right now, so this can't be fetched. Try again in a minute.")
      let found: Awaited<ReturnType<TgClient['download']>>
      try {
        found = await s.client.download(ref.chat, ref.id)
      } catch (error) {
        throw telegramError(error)
      }
      if (!found) throw new HttpError(410, 'This is no longer available on Telegram.')
      return { data: found.data, name: ref.name, ...(ref.mime ? { mime: ref.mime } : {}), ...(found.size ? { size: found.size } : {}) }
    },

    /**
     * Reacts to a message. Returns it as stored, or null when the server no longer keeps it (the
     * device then updates its own copy).
     */
    async react(userId: ObjectId, threadId: string, messageId: string, emoji: string | null): Promise<Message | null> {
      const s = connected(userId)
      const target = await store.message(userId, messageId)
      if (target && target.threadId !== threadId) throw new HttpError(404, 'That message is gone.')
      const ref = Number(target?.ref?.id) || refFromId(threadId, messageId)
      if (!ref) throw new HttpError(404, 'That message is gone.')
      if (target?.deleted) throw new HttpError(409, 'That message was deleted.')
      try {
        await s.client.react(threadId.slice('tga:'.length), ref, emoji)
      } catch (error) {
        throw telegramError(error)
      }
      // Telegram sends the new totals too; until then, assume mine changed as asked.
      return target ? store.setReactionTotals(userId, messageId, withMyReaction(target.reactions, emoji)) : null
    },

    async setTyping(userId: ObjectId, threadId: string, typing: boolean) {
      const s = sessions.get(keyOf(userId))
      if (s) await s.client.setTyping(threadId.slice('tga:'.length), typing).catch(report)
    },

    /** Older messages, fetched from Telegram (or, while it can't be reached, what's stored). */
    async loadOlder(userId: ObjectId, threadId: string, before: { id: string } & Partial<MessageHint>): Promise<ServerOlderMessages> {
      const s = sessions.get(keyOf(userId))
      const ref = refFromId(threadId, before.id)
      if (!s || !ref) return store.older(userId, threadId, before, OLDER_PAGE)
      let older: TgMessage[]
      try {
        older = await s.client.history(threadId.slice('tga:'.length), OLDER_PAGE, ref)
      } catch (error) {
        throw telegramError(error)
      }
      const messages: Message[] = []
      // Oldest first, so replies find what they quote.
      for (const m of [...older].reverse()) {
        const saved = await saveMessage(s, m, { live: false })
        if (saved) messages.push(saved.message)
      }
      return { messages, hasMore: older.length === OLDER_PAGE }
    },

    /** Marks a chat read in Sytext and, with `receipt`, on Telegram too (where they see it read). */
    async markRead(userId: ObjectId, threadId: string, { receipt = true, strict = false }: { receipt?: boolean; strict?: boolean } = {}) {
      await store.markReadHere(userId, threadId, { receipt })
      const s = sessions.get(keyOf(userId))
      if (!s) {
        if (strict) throw new HttpError(409, "Telegram isn't connected right now, so it can't be told. Try again in a minute.")
        return
      }
      if (!receipt) return
      const [latest] = await store.recentIncoming(userId, threadId, 1)
      const maxId = Number(latest?.ref?.id)
      if (!maxId) return
      try {
        await s.client.markRead(threadId.slice('tga:'.length), maxId)
      } catch (error) {
        if (strict) throw telegramError(error)
        report(error)
      }
    },

    /**
     * Reconnects every linked account that isn't connected in this server, and catches up on
     * missed messages: after a restart, and every few minutes after that, so a link that stopped
     * for any reason picks up again by itself.
     */
    async resumeAll() {
      if (!api) return
      for (const account of await accounts.toResume('telegram')) {
        if (retries.has(keyOf(account.userId))) continue // Already set to try again.
        if (account.session) await resume(account.userId, account.session).catch(report)
      }
    },

    /** A picture someone is waiting to see that's no longer at hand: downloaded again. */
    async picture(userId: ObjectId, id: string): Promise<Picture | null> {
      const s = sessions.get(keyOf(userId))
      if (!s || !id.startsWith('tga:')) return null
      const peerId = id.slice('tga:'.length)
      return live(() => lookUpPicture(s, { id: peerId, kind: Number(peerId) < 0 ? 'group' : 'direct', name: '' }))
    },

    async stopAll() {
      for (const t of retries.values()) clearTimeout(t)
      retries.clear()
      for (const userKey of [...pending.keys()]) {
        const p = pending.get(userKey)!
        pending.delete(userKey)
        clearTimeout(p.timer)
        await p.client.disconnect().catch(() => undefined)
      }
      for (const s of [...sessions.values()]) await stop(s)
    },

    isConnected: (userId: ObjectId) => sessions.has(keyOf(userId)),

    /** Resolves once queued picture downloads are done (for tests). */
    picturesIdle: () => pictures.idle(),

    /** Runs the regular check of every session now, instead of waiting for it (for tests). */
    checkAll: () => Promise.all([...sessions.values()].map((s) => check(s))),
  }

  function connected(userId: ObjectId): Session {
    const s = sessions.get(keyOf(userId))
    if (!s) throw new HttpError(409, 'Telegram is not connected right now.')
    return s
  }

  async function finishLink(userId: ObjectId, p: PendingLogin, self: TgSelf) {
    clearTimeout(p.timer)
    pending.delete(keyOf(userId))
    await accounts.set(userId, 'telegram', {
      status: 'connected',
      label: self.label,
      session: sealer.seal(p.client.save()),
      detail: 'Syncing your recent chats…',
    })
    const s = start(userId, p.client)
    void sync(s).catch(async (error) => {
      report(error)
      if (!s.stopped) await accounts.set(userId, 'telegram', { status: 'connected' }).catch(report)
    })
  }

  async function expire(userId: ObjectId) {
    if (!pending.has(keyOf(userId))) return
    await dropPending(userId)
    await accounts.set(userId, 'telegram', { status: 'disconnected', detail: 'The code expired. Get a new one to link Telegram.' })
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export type Telegram = ReturnType<typeof createTelegram>
