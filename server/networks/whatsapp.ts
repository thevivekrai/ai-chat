import makeWASocket, {
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  getContentType,
  initAuthCreds,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  proto,
  toNumber,
  type AuthenticationCreds,
  type AuthenticationState,
  type BaileysEventMap,
  type Chat as WaChat,
  type Contact as WaContact,
  type SignalDataSet,
  type SignalDataTypeMap,
  type WAMessage,
  type WAMessageKey,
  type WAVersion,
} from '@whiskeysockets/baileys'
import type { AnyBulkWriteOperation, ObjectId } from 'mongodb'
import QRCode from 'qrcode'
import type { MessageHint, ServerOlderMessages, WhatsAppLinkResult } from '../../src/data/server/types.ts'
import type { Attachment, Message, MessageStatus, QuotedMessage } from '../../src/data/types.ts'
import type { Sealer } from '../crypto.ts'
import type { Collections, WaAuthDoc } from '../db.ts'
import { HttpError } from '../http.ts'
import { createLimiter, createQueue, downloadImage, type Avatars, type Picture } from '../inbox/avatars.ts'
import type { InboxStore, StoredMessage } from '../inbox/store.ts'
import type { Media } from '../media.ts'
import type { Hub } from '../realtime.ts'
import type { Accounts } from './accounts.ts'

/**
 * WhatsApp through "Linked devices", the same way WhatsApp Web works: the user links this server
 * with an 8-character code (or a QR code) from WhatsApp on their phone. The session keys live in
 * MongoDB, sealed, so the link survives restarts.
 *
 * This uses Baileys, an unofficial WhatsApp Web client. WhatsApp doesn't sanction third-party
 * clients and can restrict numbers that use them; the app says so before linking.
 *
 * Ids: thread "wa:<chat jid>", message "wa:<chat jid>:<message id>", contact "wa:<user jid>".
 */

/** The parts of a Baileys socket this manager uses; tests pass a fake. */
export interface WaSocket {
  ev: { on<E extends keyof BaileysEventMap>(event: E, listener: (arg: BaileysEventMap[E]) => void): void }
  user?: { id: string; name?: string; lid?: string }
  authState: { creds: AuthenticationCreds }
  requestPairingCode(phoneNumber: string): Promise<string>
  sendMessage(
    jid: string,
    content: { text: string } | { react: { text: string; key: WAMessageKey } },
    options?: { quoted?: WAMessage },
  ): Promise<WAMessage | undefined>
  readMessages(keys: WAMessageKey[]): Promise<void>
  groupMetadata(jid: string): Promise<{ subject: string }>
  sendPresenceUpdate(type: 'composing' | 'paused', jid?: string): Promise<void>
  presenceSubscribe(jid: string): Promise<void>
  profilePictureUrl(jid: string, type?: 'preview' | 'image'): Promise<string | undefined>
  /** Asks the phone for older messages; they arrive later as an on-demand history batch. */
  fetchMessageHistory(count: number, oldestKey: WAMessageKey, oldestTimestamp: number): Promise<string>
  logout(message?: string): Promise<void>
  end(error: Error | undefined): Promise<void> | void
  updateMediaMessage?(message: WAMessage): Promise<WAMessage>
  /** Which private id (LID) goes with which phone number, as WhatsApp has told this device. */
  signalRepository?: {
    lidMapping: { getPNForLID(lid: string): Promise<string | null>; getLIDForPN(pn: string): Promise<string | null> }
  }
}

type ILogger = NonNullable<Parameters<typeof makeCacheableSignalKeyStore>[1]>

export type CreateWaSocket = (auth: AuthenticationState, logger: ILogger) => WaSocket | Promise<WaSocket>

const quiet: ILogger = {
  level: 'silent',
  child: () => quiet,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: (obj, msg) => console.error('[whatsapp]', msg ?? '', obj instanceof Error ? obj.message : ''),
}

/** WhatsApp turns away clients that are too far behind, so the current web version is looked up daily. */
let knownVersion: { version: WAVersion; at: number } | null = null

async function currentVersion(): Promise<WAVersion | undefined> {
  if (knownVersion && Date.now() - knownVersion.at < 24 * 60 * 60_000) return knownVersion.version
  // Falls back to the version Baileys ships with when WhatsApp can't be asked.
  const latest = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(5000) }).catch(() => null)
  if (latest?.isLatest) knownVersion = { version: latest.version, at: Date.now() }
  return latest?.version
}

export const createBaileysSocket: CreateWaSocket = async (auth, logger) =>
  makeWASocket({
    auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, logger) },
    logger,
    ...(await currentVersion().then((version) => (version ? { version } : {}))),
    // Leave the phone getting notifications; this is a background reader, not the open app.
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  }) as unknown as WaSocket

/* ── Session keys in MongoDB ──────────────────────────────────────────────────── */

async function mongoAuthState(col: Collections, sealer: Sealer, userId: ObjectId) {
  const encode = (value: unknown) => sealer.seal(JSON.stringify(value, BufferJSON.replacer))
  const decode = (doc: WaAuthDoc) => JSON.parse(sealer.open(doc.value), BufferJSON.reviver)

  const credsDoc = await col.waAuth.findOne({ userId, key: 'creds' })
  const creds: AuthenticationCreds = credsDoc ? decode(credsDoc) : initAuthCreds()

  const state: AuthenticationState = {
    creds,
    keys: {
      async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
        const docs = await col.waAuth.find({ userId, key: { $in: ids.map((id) => `${type}-${id}`) } }).toArray()
        const found = new Map(docs.map((d) => [d.key, d]))
        const result: { [id: string]: SignalDataTypeMap[T] } = {}
        for (const id of ids) {
          const doc = found.get(`${type}-${id}`)
          if (!doc) continue
          let value = decode(doc)
          if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value)
          result[id] = value
        }
        return result
      },
      async set(data: SignalDataSet) {
        const ops: AnyBulkWriteOperation<WaAuthDoc>[] = []
        for (const [category, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries ?? {})) {
            const key = `${category}-${id}`
            ops.push(
              value
                ? { updateOne: { filter: { userId, key }, update: { $set: { value: encode(value) } }, upsert: true } }
                : { deleteOne: { filter: { userId, key } } },
            )
          }
        }
        if (ops.length) await col.waAuth.bulkWrite(ops, { ordered: false })
      },
    },
  }

  return {
    state,
    saveCreds: () => col.waAuth.updateOne({ userId, key: 'creds' }, { $set: { value: encode(creds) } }, { upsert: true }),
    clear: () => col.waAuth.deleteMany({ userId }),
  }
}

/* ── Mapping ─────────────────────────────────────────────────────────────────── */

/** Chats worth showing: people and groups, not status updates, broadcast lists or channels. */
const isChatJid = (jid: string | null | undefined): jid is string =>
  !!jid && !isJidBroadcast(jid) && !isJidNewsletter(jid) && !jid.endsWith('@broadcast')

/** WhatsApp is moving to private ids (LIDs); prefer the phone-number id when both are known. */
function canonicalJid(jid: string, alt?: string | null): string {
  if (isLidUser(jid) && alt && isPnUser(alt)) return jidNormalizedUser(alt)
  return isJidGroup(jid) ? jid : jidNormalizedUser(jid)
}

/** The phone number in a phone-number id; private ids (LIDs) have none. */
const phoneOf = (jid: string): string | undefined => (isPnUser(jid) ? `+${jid.split('@')[0]}` : undefined)

/** What a person or chat is called when neither a name nor a number is known. */
const UNNAMED = 'WhatsApp contact'
/** Names used when nothing better was known, now and in earlier versions. */
const PLACEHOLDERS = new Set(['Chat', 'WhatsApp', UNNAMED])

/** How good a name is: a real name beats a phone number, which beats a placeholder. */
const nameRank = (name: string | undefined) => (!name || PLACEHOLDERS.has(name) ? 0 : /^\+\d+$/.test(name) ? 1 : 2)

const STATUS: Record<number, MessageStatus> = { 0: 'failed', 1: 'sending', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' }

function describe(message: proto.IMessage | null | undefined): { body: string; attachments?: Attachment[]; image?: boolean } | null {
  const content = normalizeMessageContent(message)
  if (!content) return null
  const kb = (n: Parameters<typeof toNumber>[0]) => (n ? `${Math.max(1, Math.round(toNumber(n) / 1024))} KB` : undefined)
  switch (getContentType(content)) {
    case 'conversation':
      return content.conversation ? { body: content.conversation } : null
    case 'extendedTextMessage':
      return content.extendedTextMessage?.text ? { body: content.extendedTextMessage.text } : null
    case 'imageMessage':
      return { body: content.imageMessage?.caption ?? '', attachments: [{ kind: 'image', name: 'Photo' }], image: true }
    case 'videoMessage':
      return { body: content.videoMessage?.caption ?? '', attachments: [{ kind: 'file', name: 'Video', size: kb(content.videoMessage?.fileLength) }] }
    case 'documentMessage':
      return {
        body: content.documentMessage?.caption ?? '',
        attachments: [{ kind: 'file', name: content.documentMessage?.fileName ?? 'Document', size: kb(content.documentMessage?.fileLength) }],
      }
    case 'documentWithCaptionMessage':
      return describe(content.documentWithCaptionMessage?.message)
    case 'audioMessage':
      return { body: content.audioMessage?.ptt ? '🎤 Voice message' : '🎵 Audio' }
    case 'stickerMessage':
      return { body: 'Sticker' }
    case 'locationMessage':
    case 'liveLocationMessage':
      return { body: '📍 Location' }
    case 'contactMessage':
      return { body: `👤 ${content.contactMessage?.displayName ?? 'Contact'}` }
    case 'contactsArrayMessage':
      return { body: '👥 Contacts' }
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3': {
      const poll = content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3
      return { body: `📊 ${poll?.name ?? 'Poll'}` }
    }
    default:
      return null
  }
}

/** The reply details WhatsApp attaches to a message that quotes another. */
function quoteOf(message: proto.IMessage | null | undefined): proto.IContextInfo | null {
  const content = normalizeMessageContent(message)
  const type = content && getContentType(content)
  const inner = type ? (content[type] as { contextInfo?: proto.IContextInfo } | undefined) : undefined
  return inner && typeof inner === 'object' && inner.contextInfo?.stanzaId ? inner.contextInfo : null
}

/** How many older messages one "Load earlier" asks for. */
const OLDER_PAGE = 30
/** After another copy of the server took the link over (a deploy), leave it alone this long. */
const REPLACED_GRACE_MS = 10 * 60_000

/**
 * The WhatsApp key of a message from what a device knows about it, for messages the server no
 * longer keeps. Ids are "wa:<chat jid>:<message id>".
 */
export function keyFromHint(threadId: string, hint: Pick<MessageHint, 'id' | 'senderId'>): WAMessageKey | null {
  if (!hint.id.startsWith(`${threadId}:`)) return null
  const chatJid = threadId.slice('wa:'.length)
  const fromMe = hint.senderId === 'me'
  const participant = isJidGroup(chatJid) && !fromMe && hint.senderId.startsWith('wa:') ? hint.senderId.slice('wa:'.length) : undefined
  return { remoteJid: chatJid, fromMe, id: hint.id.slice(threadId.length + 1), ...(participant ? { participant } : {}) }
}

/* ── Manager ─────────────────────────────────────────────────────────────────── */

interface Session {
  userId: ObjectId
  socket: WaSocket | null
  auth: Awaited<ReturnType<typeof mongoAuthState>>
  /** Set while linking: how, and who is waiting for the code or QR. */
  linking: null | { method: 'code' | 'qr'; phone?: string; requested: boolean; settle(result: LinkResult | Error): void }
  opened: boolean
  retries: number
  stopped: boolean
  names: Map<string, string>
  groupTitles: Map<string, string>
  /**
   * Each person's other id: their private id (LID) for their phone-number id, and the reverse.
   * WhatsApp may send a chat under one and their name under the other.
   */
  aliases: Map<string, string>
  /** Chats whose older history was last asked of the phone, and from which message. */
  historyAsked: Map<string, string>
  repairTimer?: ReturnType<typeof setTimeout>
}

type LinkResult = WhatsAppLinkResult

export interface WhatsAppDeps {
  col: Collections
  sealer: Sealer
  store: InboxStore
  accounts: Accounts
  hub: Hub
  media: Media | null
  avatars: Avatars
  createSocket?: CreateWaSocket
  /** How long to wait for WhatsApp to offer a code or QR. */
  linkTimeoutMs?: number
}

export function createWhatsApp(deps: WhatsAppDeps) {
  const { col, sealer, store, accounts, hub, media, avatars } = deps
  const createSocket = deps.createSocket ?? createBaileysSocket
  const sessions = new Map<string, Session>()
  /** Users whose session is being started, so two starts never overlap. */
  const starting = new Set<string>()
  /** When another copy of the server last took each user's link over. */
  const replacedAt = new Map<string, number>()
  const pictures = createQueue()
  /** Pictures someone is waiting to see, fetched a couple at a time. */
  const live = createLimiter(2)
  const keyOf = (userId: ObjectId) => userId.toHexString()
  const publish = (s: Session, event: Parameters<Hub['publish']>[1]) => hub.publish(keyOf(s.userId), event)

  let reloadTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** History arrives in many batches; tell the browser once things settle. */
  const reloadSoon = (s: Session) => {
    const key = keyOf(s.userId)
    clearTimeout(reloadTimers.get(key))
    reloadTimers.set(key, setTimeout(() => publish(s, { type: 'reloaded' }), 800))
  }

  async function connect(s: Session) {
    if (s.stopped) return
    const socket = await createSocket(s.auth.state, quiet)
    if (s.stopped) {
      await Promise.resolve(socket.end(undefined)).catch(() => undefined)
      return
    }
    s.socket = socket
    socket.ev.on('creds.update', () => void s.auth.saveCreds())
    socket.ev.on('connection.update', (update) => void onConnection(s, socket, update).catch(report))
    socket.ev.on('messaging-history.set', (h) => {
      // Older messages fetched for "Load earlier" go straight to the open chat.
      const requested = h.syncType === proto.HistorySync.HistorySyncType.ON_DEMAND
      void onHistory(s, h, requested).catch(report)
    })
    socket.ev.on('lid-mapping.update', ({ lid, pn }) => {
      learnAlias(s, lid, pn)
      repairSoon(s)
    })
    socket.ev.on('messages.upsert', ({ messages, type }) => {
      for (const m of messages) void onMessage(s, m, type === 'notify' ? 'live' : 'history').catch(report)
    })
    socket.ev.on('presence.update', (update) => void onPresence(s, update).catch(report))
    socket.ev.on('messages.update', (updates) => {
      for (const u of updates) void onMessageUpdate(s, u.key, u.update).catch(report)
    })
    socket.ev.on('contacts.upsert', (contacts) => void onContacts(s, contacts).catch(report))
    socket.ev.on('contacts.update', (contacts) => void onContacts(s, contacts as WaContact[]).catch(report))
    socket.ev.on('chats.upsert', (chats) => void onChats(s, chats).catch(report))
    socket.ev.on('chats.update', (chats) => void onChats(s, chats as WaChat[]).catch(report))
    socket.ev.on('groups.update', (groups) => {
      for (const g of groups) if (g.id && g.subject) void setGroupTitle(s, g.id, g.subject).catch(report)
    })
  }

  async function onConnection(s: Session, socket: WaSocket, update: BaileysEventMap['connection.update']) {
    if (s.socket !== socket || s.stopped) return

    if (update.qr && s.linking) {
      const linking = s.linking
      if (linking.method === 'code' && !linking.requested) {
        linking.requested = true
        try {
          const code = await socket.requestPairingCode(linking.phone!)
          linking.settle({ code: code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code })
        } catch (error) {
          linking.settle(new HttpError(502, `WhatsApp didn't give a code: ${(error as Error).message}`))
        }
      } else if (linking.method === 'qr') {
        const qr = await QRCode.toDataURL(update.qr, { margin: 1, width: 288 })
        linking.settle({ qr })
        publish(s, { type: 'account.qr', network: 'whatsapp', qr })
      }
    }

    if (update.connection === 'open') {
      const wasLinking = !!s.linking
      s.linking = null
      s.opened = true
      s.retries = 0
      const me = socket.user?.id ? jidNormalizedUser(socket.user.id) : undefined
      await accounts.set(s.userId, 'whatsapp', {
        status: 'connected',
        label: me ? phoneOf(me) : undefined,
        ...(wasLinking ? { detail: 'Syncing your recent chats…' } : {}),
      })
      if (wasLinking) setTimeout(() => void finishSync(s), 90_000)
      repairSoon(s)
      return
    }

    if (update.connection === 'close') {
      const status = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
      s.socket = null

      if (status === DisconnectReason.restartRequired) return connect(s) // Normal right after linking.

      if (s.linking) {
        s.linking.settle(new HttpError(504, 'WhatsApp closed the connection while linking. Try again.'))
        s.linking = null
        await stop(s)
        await accounts.set(s.userId, 'whatsapp', { status: 'disconnected', detail: 'Linking didn\'t finish. Get a new code to try again.' })
        return
      }
      if (status === DisconnectReason.loggedOut) {
        await stop(s)
        await s.auth.clear()
        await accounts.set(s.userId, 'whatsapp', {
          status: 'disconnected',
          detail: 'This device was logged out from WhatsApp on your phone. Link it again to keep syncing.',
        })
        return
      }
      if (status === DisconnectReason.connectionReplaced) {
        // Another copy of this server took over the link, as happens during a deploy: let it have it.
        replacedAt.set(keyOf(s.userId), Date.now())
        await stop(s)
        return
      }
      // A dropped network connection: try again, backing off.
      await reconnectLater(s)
    }
  }

  /** Tries to connect again, backing off, for as long as the link is wanted. */
  async function reconnectLater(s: Session) {
    if (s.stopped) return
    s.retries++
    if (s.retries === 3) await accounts.set(s.userId, 'whatsapp', { status: 'error', detail: 'Can\'t reach WhatsApp. Retrying…' })
    setTimeout(() => {
      // A failed attempt (WhatsApp unreachable while setting up) is retried like a dropped connection.
      connect(s).catch((error) => {
        report(error)
        void reconnectLater(s).catch(report)
      })
    }, Math.min(60_000, 1000 * 2 ** s.retries))
  }

  async function finishSync(s: Session) {
    if (!s.stopped && s.opened) {
      const account = await accounts.get(s.userId, 'whatsapp')
      if (account?.status === 'connected' && account.detail) await accounts.set(s.userId, 'whatsapp', { status: 'connected' })
    }
  }

  /* ── Incoming data ───────────────────────────────────────────────────────── */

  /* ── Who's who ───────────────────────────────────────────────────────────── */

  /** Records that a private id (LID) and a phone-number id are the same person. */
  function learnAlias(s: Session, a: string | null | undefined, b: string | null | undefined) {
    if (!a || !b) return
    const [x, y] = [jidNormalizedUser(a), jidNormalizedUser(b)]
    const lid = isLidUser(x) ? x : isLidUser(y) ? y : null
    const pn = isPnUser(x) ? x : isPnUser(y) ? y : null
    if (!lid || !pn) return
    s.aliases.set(lid, pn)
    s.aliases.set(pn, lid)
  }

  /** Learns a person's other id from what WhatsApp stored on this device, if it isn't known yet. */
  async function lookUpAlias(s: Session, jid: string): Promise<string | undefined> {
    const known = s.aliases.get(jid)
    const lids = s.socket?.signalRepository?.lidMapping
    if (known || !lids) return known
    const other = isLidUser(jid) ? await lids.getPNForLID(jid).catch(() => null) : isPnUser(jid) ? await lids.getLIDForPN(jid).catch(() => null) : null
    learnAlias(s, jid, other)
    return s.aliases.get(jid)
  }

  /** A person's id as this app uses it: the phone-number one when it's known. */
  function personId(s: Session, jid: string, alt?: string | null): string {
    learnAlias(s, jid, alt)
    const canonical = canonicalJid(jid, alt)
    const alias = s.aliases.get(canonical)
    return isLidUser(canonical) && alias && isPnUser(alias) ? alias : canonical
  }

  /**
   * The id a direct chat is kept under: the one it's already stored under, if it is (by phone
   * number or by private id), so a chat never splits in two; otherwise the person's id.
   */
  async function chatIdOf(s: Session, jid: string, alt?: string | null): Promise<string> {
    if (isJidGroup(jid)) return jid
    const preferred = personId(s, jid, alt)
    const other = s.aliases.get(preferred)
    if (!other || (await store.thread(s.userId, `wa:${preferred}`))) return preferred
    return (await store.thread(s.userId, `wa:${other}`)) ? other : preferred
  }

  /** A person's phone number, from their id or its alias. */
  const phoneFor = (s: Session, jid: string) => phoneOf(jid) ?? phoneOf(s.aliases.get(jid) ?? '')

  /** What to call a person: their name (under either id), else their number. */
  const nameFor = (s: Session, jid: string) => s.names.get(jid) ?? s.names.get(s.aliases.get(jid) ?? '') ?? phoneFor(s, jid) ?? UNNAMED

  /** The best name known for a person, including what's stored for either of their ids. */
  async function bestNameFor(s: Session, jid: string): Promise<string> {
    const alias = await lookUpAlias(s, jid)
    const fromMemory = nameFor(s, jid)
    if (nameRank(fromMemory) === 2) return fromMemory
    for (const id of [jid, alias]) {
      const stored = id ? await store.contact(s.userId, `wa:${id}`) : null
      if (stored && nameRank(stored.name) === 2) return stored.name
    }
    return fromMemory
  }

  /** Renames a stored chat if `title` is better than what it has (never a name with a number). */
  async function improveTitle(s: Session, threadId: string, title: string, { force = false } = {}) {
    const thread = await store.thread(s.userId, threadId)
    if (!thread || thread.title === title) return
    if (!force && nameRank(title) <= nameRank(thread.title)) return
    const renamed = await store.upsertThread(s.userId, { id: thread.id, network: 'whatsapp', kind: thread.kind, title })
    publish(s, { type: 'thread.updated', thread: renamed })
  }

  /** Re-checks names shortly, once a burst of contacts or id pairs has arrived. */
  function repairSoon(s: Session) {
    clearTimeout(s.repairTimer)
    s.repairTimer = setTimeout(() => void repairNames(s).catch(report), 3000)
  }

  /**
   * Direct chats and contacts stored without a name (shown as "WhatsApp" by earlier versions, or
   * a bare number): named from whatever is known now, under either of the person's ids.
   */
  async function repairNames(s: Session) {
    if (s.stopped) return
    for (const thread of await store.threadsOf(s.userId, 'wa:')) {
      if (s.stopped) return
      if (thread.kind !== 'direct' || nameRank(thread.title) === 2) continue
      await improveTitle(s, thread.id, await bestNameFor(s, thread.id.slice('wa:'.length)))
    }
    for (const contact of await store.contactsOf(s.userId, 'wa:')) {
      if (s.stopped) return
      const jid = contact.id.slice('wa:'.length)
      // Only those still without a real name, or with the placeholder where the number goes.
      if (isJidGroup(jid) || (nameRank(contact.name) === 2 && !PLACEHOLDERS.has(contact.handle))) continue
      const name = await bestNameFor(s, jid)
      const handle = phoneFor(s, jid) ?? ''
      const better = nameRank(name) > nameRank(contact.name) ? name : contact.name
      if (better === contact.name && handle === contact.handle) continue
      const updated = { ...contact, name: better, handle }
      if (await store.upsertContact(s.userId, updated)) publish(s, { type: 'contact.updated', contact: updated })
    }
  }

  async function ensureThread(s: Session, chatJid: string, lastAt?: Date) {
    const group = isJidGroup(chatJid)
    let title: string | undefined
    if (group) {
      title = s.groupTitles.get(chatJid)
      if (!title && s.socket) {
        title = await s.socket
          .groupMetadata(chatJid)
          .then((m) => m.subject)
          .catch(() => undefined)
        if (title) s.groupTitles.set(chatJid, title)
      }
    } else {
      title = nameFor(s, chatJid)
    }
    const existing = await store.thread(s.userId, `wa:${chatJid}`)
    if (!existing) fetchPicture(s, chatJid)
    return store.upsertThread(s.userId, {
      id: `wa:${chatJid}`,
      network: 'whatsapp',
      kind: group ? 'group' : 'direct',
      // Only ever a better title: a name over a number, a number over a placeholder.
      ...(title && (!existing || nameRank(title) > nameRank(existing.title)) ? { title } : {}),
      ...(group ? {} : { participantIds: [`wa:${chatJid}`] }),
      lastAt,
    })
  }

  /** Checks a person's or group's picture, in the background. */
  function fetchPicture(s: Session, jid: string) {
    const id = `wa:${jid}`
    pictures.add(`${keyOf(s.userId)}:${id}`, async () => {
      if (s.stopped || !s.socket || (await avatars.fresh(s.userId, id))) return
      await lookUpPicture(s, jid)
    })
  }

  /** Asks WhatsApp for a picture, records it, and puts its URL on the contact or group. */
  async function lookUpPicture(s: Session, jid: string): Promise<Picture | null> {
    const id = `wa:${jid}`
    // WhatsApp answers "not found" for no picture, and for pictures hidden by privacy settings.
    const link = await s.socket?.profilePictureUrl(jid, 'preview').catch(() => undefined)
    const image = link ? await downloadImage(link).catch(() => null) : null
    if (s.stopped) return null
    const url = await avatars.save(s.userId, id, image, link)
    if (!url) return null
    if (isJidGroup(jid)) {
      const thread = await store.setThreadAvatar(s.userId, id, url)
      if (thread) publish(s, { type: 'thread.updated', thread })
    } else {
      // The picture can be ready before the contact is: make sure there's one to put it on.
      if (!(await store.contact(s.userId, id))) await upsertContact(s, jid)
      const contact = await store.setContactAvatar(s.userId, id, url)
      if (contact) publish(s, { type: 'contact.updated', contact })
    }
    return image
  }

  /** Typing ("composing") and recording show as typing; anything else ends it. */
  async function onPresence(s: Session, { id, presences }: BaileysEventMap['presence.update']) {
    if (!isChatJid(id)) return
    const threadId = `wa:${await chatIdOf(s, id)}`
    if (!(await store.thread(s.userId, threadId))) return
    for (const [participant, presence] of Object.entries(presences)) {
      const senderId = senderIdOf(s, participant)
      if (senderId === 'me') continue
      const active = presence.lastKnownPresence === 'composing' || presence.lastKnownPresence === 'recording'
      publish(s, { type: 'typing', threadId, senderId, active })
    }
  }

  /** Who a jid is in this account's chats: "me", or a contact id. */
  function senderIdOf(s: Session, jid: string, alt?: string | null): string {
    const me = s.socket?.user
    const mine = [me?.id, me?.lid].filter(Boolean).map((j) => jidNormalizedUser(j!))
    if (mine.includes(canonicalJid(jid))) return 'me'
    return `wa:${personId(s, jid, alt)}`
  }

  /** What a reply quotes: from the stored message when there is one, else from WhatsApp's copy. */
  async function quotedFor(s: Session, chatJid: string, context: proto.IContextInfo): Promise<QuotedMessage> {
    const id = `wa:${chatJid}:${context.stanzaId}`
    const stored = await store.message(s.userId, id)
    if (stored) return { id, senderId: stored.senderId, body: stored.body || stored.attachments?.[0]?.name || '' }
    const senderId = context.participant ? senderIdOf(s, context.participant) : isJidGroup(chatJid) ? 'unknown' : `wa:${chatJid}`
    const quoted = describe(context.quotedMessage)
    return { id, senderId, body: quoted?.body || quoted?.attachments?.[0]?.name || '' }
  }

  /**
   * A message, as it arrives: `live` ones count as unread; `history` ones are an initial sync;
   * `requested` ones are older messages the user asked for.
   */
  async function onMessage(s: Session, msg: WAMessage, mode: 'live' | 'history' | 'requested') {
    const live = mode === 'live'
    const remote = msg.key.remoteJid
    if (!isChatJid(remote)) return
    learnAlias(s, msg.key.participant, msg.key.participantAlt)
    const chatJid = await chatIdOf(s, remote, msg.key.remoteJidAlt)
    const content = normalizeMessageContent(msg.message)

    // A reaction points at the message it reacts to; an empty one takes it back.
    const reaction = content?.reactionMessage
    if (reaction?.key?.id) {
      const group = isJidGroup(chatJid)
      const who = msg.key.fromMe
        ? 'me'
        : group
          ? senderIdOf(s, msg.key.participant ?? remote, msg.key.participantAlt)
          : `wa:${chatJid}`
      const updated = await store.setReaction(s.userId, `wa:${chatJid}:${reaction.key.id}`, who, reaction.text || null)
      if (updated) publish(s, { type: 'message.updated', message: updated })
      return
    }

    // Edits and deletions arrive as protocol messages pointing at the original.
    const protocol = content?.protocolMessage
    if (protocol?.key?.id) {
      const target = `wa:${chatJid}:${protocol.key.id}`
      if (protocol.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
        const edited = describe(protocol.editedMessage)
        if (edited) await updateAndPublish(s, target, { body: edited.body })
      } else if (protocol.type === proto.Message.ProtocolMessage.Type.REVOKE) {
        await updateAndPublish(s, target, { body: '🚫 This message was deleted', attachments: [] })
      }
      return
    }

    const parts = describe(msg.message)
    if (!parts) return
    const fromMe = !!msg.key.fromMe
    const group = isJidGroup(chatJid)
    // In a direct chat the sender is the chat; in a group, whoever wrote it.
    const senderJid = fromMe ? null : group ? personId(s, msg.key.participant ?? remote, msg.key.participantAlt) : chatJid
    // The name they gave themselves on WhatsApp, until a saved contact name turns up.
    if (senderJid && msg.pushName && !s.names.has(senderJid) && !s.names.has(s.aliases.get(senderJid) ?? '')) {
      s.names.set(senderJid, msg.pushName)
      await upsertContact(s, senderJid)
    }

    const sentAt = new Date((toNumber(msg.messageTimestamp) || Date.now() / 1000) * 1000)
    const thread = await ensureThread(s, chatJid, sentAt)
    if (senderJid && group) {
      await store.addParticipant(s.userId, thread.id, `wa:${senderJid}`)
      fetchPicture(s, senderJid)
    }
    const context = quoteOf(msg.message)

    const message: StoredMessage = {
      id: `wa:${chatJid}:${msg.key.id}`,
      threadId: thread.id,
      senderId: senderJid ? `wa:${senderJid}` : 'me',
      body: parts.body,
      sentAt: sentAt.toISOString(),
      ...(fromMe ? { status: STATUS[msg.status ?? 2] ?? 'sent' } : {}),
      ...(parts.attachments ? { attachments: parts.attachments } : {}),
      ...(context ? { replyTo: await quotedFor(s, chatJid, context) } : {}),
      ref: { key: { remoteJid: remote, fromMe, id: msg.key.id, participant: msg.key.participant ?? undefined } },
    }
    if (!(await store.addMessage(s.userId, message))) return
    if (live && !fromMe) await store.incrementUnread(s.userId, thread.id)
    const updated = await store.thread(s.userId, thread.id)
    if (updated) publish(s, { type: 'thread.updated', thread: updated })
    const { ref, ...wire } = message
    void ref
    publish(s, { type: 'message.created', message: wire })

    // Pictures that arrive live are copied to Cloudinary so the browser can show them.
    if (parts.image && live && media && s.socket) void saveImage(s, msg, message.id).catch(report)
  }

  async function saveImage(s: Session, msg: WAMessage, messageId: string) {
    const socket = s.socket
    if (!socket || !media) return
    const data = await downloadMediaMessage(msg, 'buffer', {}, {
      logger: quiet,
      reuploadRequest: (m) => (socket.updateMediaMessage ? socket.updateMediaMessage(m) : Promise.resolve(m)),
    })
    const url = await media.uploadBuffer(data, `chats/${keyOf(s.userId)}`)
    await updateAndPublish(s, messageId, { attachments: [{ kind: 'image', name: 'Photo', url }] })
  }

  async function updateAndPublish(s: Session, id: string, patch: Parameters<InboxStore['updateMessage']>[2]) {
    const message = await store.updateMessage(s.userId, id, patch)
    if (message) publish(s, { type: 'message.updated', message })
  }

  async function onMessageUpdate(s: Session, key: WAMessageKey, update: Partial<WAMessage>) {
    if (!isChatJid(key.remoteJid)) return
    const id = `wa:${await chatIdOf(s, key.remoteJid, key.remoteJidAlt)}:${key.id}`
    if (typeof update.status === 'number' && key.fromMe && STATUS[update.status]) {
      await updateAndPublish(s, id, { status: STATUS[update.status] })
    }
    const edited = update.message ? describe(update.message.editedMessage?.message ?? update.message) : null
    if (edited) await updateAndPublish(s, id, { body: edited.body })
  }

  async function upsertContact(s: Session, jid: string) {
    const contact = { id: `wa:${jid}`, name: nameFor(s, jid), network: 'whatsapp' as const, handle: phoneFor(s, jid) ?? '' }
    if (await store.upsertContact(s.userId, contact)) publish(s, { type: 'contact.updated', contact })
  }

  /** Learns both ids of a contact (they can come with their private id, phone number, or both). */
  function learnContact(s: Session, c: WaContact): string | null {
    if (!c.id || isJidGroup(c.id)) return null
    learnAlias(s, c.id, c.lid)
    learnAlias(s, c.id, c.phoneNumber)
    learnAlias(s, c.lid, c.phoneNumber)
    return personId(s, c.id, c.phoneNumber)
  }

  async function onContacts(s: Session, contacts: WaContact[]) {
    for (const c of contacts) {
      const jid = learnContact(s, c)
      const name = c.name || c.notify || c.verifiedName
      if (!jid || !name) continue
      // A name saved in the phone's contacts wins over the one they gave themselves.
      if (c.name || !s.names.has(jid)) s.names.set(jid, name)
      await upsertContact(s, jid)
      // The chat with them, under whichever of their ids it's kept: a saved name renames it.
      for (const id of [jid, s.aliases.get(jid)]) {
        if (id) await improveTitle(s, `wa:${id}`, nameFor(s, jid), { force: !!c.name })
      }
    }
    repairSoon(s)
  }

  async function onChats(s: Session, chats: WaChat[]) {
    for (const chat of chats) {
      if (!isChatJid(chat.id)) continue
      learnChat(s, chat)
      const jid = await chatIdOf(s, chat.id, chat.pnJid)
      if (chat.name && isJidGroup(jid)) await setGroupTitle(s, jid, chat.name)
      if (typeof chat.unreadCount === 'number' && (await store.thread(s.userId, `wa:${jid}`))) {
        await store.setUnread(s.userId, `wa:${jid}`, Math.max(0, chat.unreadCount))
        const thread = await store.thread(s.userId, `wa:${jid}`)
        if (thread) publish(s, { type: 'thread.updated', thread })
      }
    }
  }

  async function setGroupTitle(s: Session, jid: string, title: string) {
    s.groupTitles.set(jid, title)
    if (await store.thread(s.userId, `wa:${jid}`)) {
      const thread = await store.upsertThread(s.userId, { id: `wa:${jid}`, network: 'whatsapp', kind: 'group', title })
      publish(s, { type: 'thread.updated', thread })
    }
  }

  /** Learns a chat's other id, and the name WhatsApp shows for it. */
  function learnChat(s: Session, chat: WaChat) {
    if (!chat.id) return
    if (isJidGroup(chat.id)) {
      if (chat.name) s.groupTitles.set(chat.id, chat.name)
      return
    }
    learnAlias(s, chat.id, chat.pnJid)
    learnAlias(s, chat.id, chat.lidJid)
    const name = chat.name || chat.displayName
    const jid = personId(s, chat.id, chat.pnJid)
    if (name && !s.names.has(jid) && !s.names.has(s.aliases.get(jid) ?? '')) s.names.set(jid, name)
  }

  async function onHistory(
    s: Session,
    { chats, contacts, messages, lidPnMappings }: Pick<BaileysEventMap['messaging-history.set'], 'chats' | 'contacts' | 'messages' | 'lidPnMappings'>,
    requested = false,
  ) {
    // Who's who first, so chats and messages find their names.
    for (const { lid, pn } of lidPnMappings ?? []) learnAlias(s, lid, pn)
    for (const c of contacts) {
      const jid = learnContact(s, c)
      const name = c.name || c.notify || c.verifiedName
      if (jid && name && (c.name || !s.names.has(jid))) s.names.set(jid, name)
    }
    for (const chat of chats) learnChat(s, chat)
    // Only the latest few messages per chat: enough to see where each conversation stands. They're
    // stored oldest first, so replies and reactions find the messages they point at.
    const perChat = new Map<string, number>()
    const recent = [...messages].sort((a, b) => toNumber(b.messageTimestamp) - toNumber(a.messageTimestamp))
    const picked = recent.filter((m) => {
      const jid = m.key.remoteJid
      if (!isChatJid(jid)) return false
      const n = perChat.get(jid) ?? 0
      perChat.set(jid, n + 1)
      return n < 40
    })
    for (const m of picked.reverse()) await onMessage(s, m, requested ? 'requested' : 'history')
    if (requested) return
    for (const chat of chats) {
      if (!isChatJid(chat.id)) continue
      const jid = await chatIdOf(s, chat.id, chat.pnJid)
      if (typeof chat.unreadCount === 'number' && (await store.thread(s.userId, `wa:${jid}`))) {
        await store.setUnread(s.userId, `wa:${jid}`, Math.max(0, chat.unreadCount))
      }
    }
    for (const [jid] of s.names) if (!isJidGroup(jid)) await upsertContact(s, jid)
    reloadSoon(s)
    repairSoon(s)
    await finishSync(s)
  }

  /* ── Lifecycle ───────────────────────────────────────────────────────────── */

  async function stop(s: Session) {
    s.stopped = true
    clearTimeout(s.repairTimer)
    const socket = s.socket
    s.socket = null
    await Promise.resolve(socket?.end(undefined)).catch(() => undefined)
    if (sessions.get(keyOf(s.userId)) === s) sessions.delete(keyOf(s.userId))
  }

  async function startSession(userId: ObjectId, linking: Session['linking']): Promise<Session> {
    const s: Session = {
      userId,
      socket: null,
      auth: await mongoAuthState(col, sealer, userId),
      linking,
      opened: false,
      retries: 0,
      stopped: false,
      names: new Map(),
      groupTitles: new Map(),
      aliases: new Map(),
      historyAsked: new Map(),
    }
    sessions.set(keyOf(userId), s)
    if (linking) await connect(s)
    else {
      // Resuming: if WhatsApp can't be reached now, keep trying rather than give up on the link.
      await connect(s).catch((error) => {
        report(error)
        void reconnectLater(s).catch(report)
      })
    }
    return s
  }

  function report(error: unknown) {
    console.error('[whatsapp]', error instanceof Error ? error.message : error)
  }

  function connected(userId: ObjectId): WaSocket {
    const s = sessions.get(keyOf(userId))
    if (!s?.socket || !s.opened) throw new HttpError(409, 'WhatsApp is not connected right now.')
    return s.socket
  }

  return {
    /**
     * Starts linking. With a phone number, resolves with the code to type into WhatsApp
     * (Linked devices → Link with phone number); without, with a QR code to scan.
     */
    async link(userId: ObjectId, request: { method: 'code'; phone: string } | { method: 'qr' }): Promise<LinkResult> {
      const existing = sessions.get(keyOf(userId))
      if (existing?.opened && !existing.stopped) throw new HttpError(409, 'WhatsApp is already linked. Unlink it first.')
      if (existing) await stop(existing)

      const phone = request.method === 'code' ? request.phone.replace(/\D/g, '') : undefined
      if (request.method === 'code' && (!phone || phone.length < 8 || phone.length > 15)) {
        throw new HttpError(400, 'Enter your WhatsApp number with its country code, like +91 98765 43210.')
      }
      // Linking always starts from a clean slate.
      await col.waAuth.deleteMany({ userId })
      await accounts.set(userId, 'whatsapp', {
        status: 'linking',
        step: request.method,
        ...(phone ? { label: `+${phone}` } : {}),
        detail: request.method === 'code' ? 'Waiting for you to enter the code in WhatsApp…' : 'Waiting for you to scan the QR code…',
      })

      return new Promise<LinkResult>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => settle(new HttpError(504, 'WhatsApp didn\'t respond. Try again in a moment.')), deps.linkTimeoutMs ?? 30_000)
        function settle(result: LinkResult | Error) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (result instanceof Error) {
            const s = sessions.get(keyOf(userId))
            if (s && !s.opened) void stop(s)
            void accounts.set(userId, 'whatsapp', { status: 'disconnected', detail: result.message })
            reject(result)
          } else resolve(result)
        }
        void startSession(userId, { method: request.method, phone, requested: false, settle }).catch((e) => settle(e as Error))
      })
    },

    async unlink(userId: ObjectId) {
      const s = sessions.get(keyOf(userId))
      if (s?.socket && s.opened) await s.socket.logout().catch(() => undefined) // Removes the device from the phone too.
      if (s) await stop(s)
      await pictures.settled()
      await col.waAuth.deleteMany({ userId })
      await store.forgetNetwork(userId, 'wa:')
      avatars.forget(userId, 'wa:')
      await accounts.remove(userId, 'whatsapp')
      hub.publish(keyOf(userId), { type: 'reloaded' })
    },

    /** `quoted` is what the device knows of the message replied to, in case the server no longer has it. */
    async send(userId: ObjectId, threadId: string, body: string, replyToId?: string, quotedHint?: MessageHint): Promise<Message> {
      const socket = connected(userId)
      const jid = threadId.slice('wa:'.length)
      const stored = replyToId ? await store.message(userId, replyToId) : null
      const hint = !stored && quotedHint?.id === replyToId ? quotedHint : undefined
      const quoted = stored ?? (hint ? { id: hint.id, senderId: hint.senderId, body: hint.body ?? '' } : null)
      const quotedKey = (stored?.ref as { key?: WAMessageKey } | undefined)?.key ?? (hint ? keyFromHint(threadId, hint) : null)
      const sent = await socket.sendMessage(
        jid,
        { text: body },
        // WhatsApp shows the quote from the message given here, so it needs the original's text.
        quotedKey ? { quoted: { key: quotedKey, message: { conversation: quoted!.body } } } : undefined,
      )
      if (!sent?.key.id) throw new HttpError(502, 'WhatsApp didn\'t accept the message.')
      const message: StoredMessage = {
        id: `wa:${jid}:${sent.key.id}`,
        threadId,
        senderId: 'me',
        body,
        sentAt: new Date().toISOString(),
        status: 'sent',
        ...(quoted ? { replyTo: { id: quoted.id, senderId: quoted.senderId, body: quoted.body } } : {}),
        ref: { key: { remoteJid: jid, fromMe: true, id: sent.key.id } },
      }
      await store.addMessage(userId, message)
      const { ref, ...wire } = message
      void ref
      return wire
    },

    /**
     * Reacts to a message. Returns it as stored, or null when the server no longer keeps it (the
     * device then updates its own copy); `hint` is what the device knows of it.
     */
    async react(userId: ObjectId, threadId: string, messageId: string, emoji: string | null, hint?: MessageHint): Promise<Message | null> {
      const socket = connected(userId)
      const target = await store.message(userId, messageId)
      if (target && target.threadId !== threadId) throw new HttpError(404, 'That message is gone.')
      const key =
        (target?.ref as { key?: WAMessageKey } | undefined)?.key ?? (hint?.id === messageId ? keyFromHint(threadId, hint) : null)
      if (!key) throw new HttpError(404, 'That message is gone.')
      await socket.sendMessage(threadId.slice('wa:'.length), { react: { text: emoji ?? '', key } })
      return target ? store.setReaction(userId, messageId, 'me', emoji) : null
    },

    async setTyping(userId: ObjectId, threadId: string, typing: boolean) {
      const s = sessions.get(keyOf(userId))
      if (!s?.socket || !s.opened) return
      const jid = threadId.slice('wa:'.length)
      await s.socket.presenceSubscribe(jid).catch(() => undefined)
      await s.socket.sendPresenceUpdate(typing ? 'composing' : 'paused', jid).catch(report)
    },

    /**
     * Older messages: what's stored first. Beyond that, the phone is asked for more; they arrive
     * a little later as new messages in the chat.
     */
    async loadOlder(userId: ObjectId, threadId: string, before: { id: string } & Partial<MessageHint>): Promise<ServerOlderMessages> {
      const stored = await store.older(userId, threadId, before, OLDER_PAGE)
      if (stored.hasMore) return stored
      const s = sessions.get(keyOf(userId))
      const oldestId = stored.messages[0]?.id ?? before.id
      // Asking again from the same message means the phone had nothing more.
      if (!s?.socket || !s.opened || s.historyAsked.get(threadId) === oldestId) return stored
      // The phone is asked from the oldest message known, as the server has it or as the device does.
      const oldest = await store.message(userId, oldestId)
      const hint = !oldest && before.senderId && before.sentAt ? { id: before.id, senderId: before.senderId, sentAt: before.sentAt } : null
      const key = (oldest?.ref as { key?: WAMessageKey } | undefined)?.key ?? (hint ? keyFromHint(threadId, hint) : null)
      const sentAt = Date.parse(oldest?.sentAt ?? hint?.sentAt ?? '')
      if (!key || Number.isNaN(sentAt)) return stored
      s.historyAsked.set(threadId, oldestId)
      await s.socket.fetchMessageHistory(50, key, Math.floor(sentAt / 1000)).catch(report)
      return { messages: stored.messages, hasMore: true }
    },

    async markRead(userId: ObjectId, threadId: string) {
      await store.setUnread(userId, threadId, 0)
      const s = sessions.get(keyOf(userId))
      if (!s?.socket || !s.opened) return
      // Opening a chat is when its typing notices start to matter.
      void s.socket.presenceSubscribe(threadId.slice('wa:'.length)).catch(() => undefined)
      const keys = (await store.recentIncoming(userId, threadId))
        .map((m) => (m.ref as { key?: WAMessageKey } | undefined)?.key)
        .filter((k): k is WAMessageKey => !!k?.id)
      if (keys.length) await s.socket.readMessages(keys).catch(report)
    },

    /**
     * Reconnects every linked account that isn't connected in this server: after a restart, and
     * every few minutes after that, so a link that stopped for any reason picks up again by itself.
     */
    async resumeAll() {
      for (const account of await accounts.toResume('whatsapp')) {
        const key = keyOf(account.userId)
        if (sessions.has(key) || starting.has(key)) continue
        if (Date.now() - (replacedAt.get(key) ?? 0) < REPLACED_GRACE_MS) continue
        starting.add(key)
        try {
          await resume(account)
        } finally {
          starting.delete(key)
        }
      }
    },

    /** A picture someone is waiting to see that's no longer at hand: asked of WhatsApp again. */
    async picture(userId: ObjectId, id: string): Promise<Picture | null> {
      const s = sessions.get(keyOf(userId))
      if (!s?.socket || !s.opened || !id.startsWith('wa:')) return null
      return live(() => lookUpPicture(s, id.slice('wa:'.length)))
    },

    async stopAll() {
      for (const s of [...sessions.values()]) await stop(s)
      for (const t of reloadTimers.values()) clearTimeout(t)
      reloadTimers = new Map()
    },

    isConnected: (userId: ObjectId) => !!sessions.get(keyOf(userId))?.opened,

    /** Resolves once queued picture downloads are done (for tests). */
    picturesIdle: () => pictures.idle(),
  }

  /** Reconnects one linked account from its stored keys. */
  async function resume(account: { userId: ObjectId }) {
    let auth: Awaited<ReturnType<typeof mongoAuthState>>
    try {
      auth = await mongoAuthState(col, sealer, account.userId)
    } catch {
      // Sealed with another key: the link can't be used any more.
      await col.waAuth.deleteMany({ userId: account.userId })
      await accounts.set(account.userId, 'whatsapp', {
        status: 'disconnected',
        detail: "The server's encryption key changed, so the link can't be used. Link WhatsApp again.",
      })
      return
    }
    if (!auth.state.creds.registered) {
      await accounts.set(account.userId, 'whatsapp', { status: 'disconnected', detail: 'The link was never finished. Link again.' })
      return
    }
    await startSession(account.userId, null).catch(report)
  }
}

export type WhatsApp = ReturnType<typeof createWhatsApp>
