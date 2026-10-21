import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk'
import type { Attachment, Contact, Message, NetworkId, Thread } from '../../types'
import { ME_ID } from '../../types'
import { Emitter, type Connector, type ConnectorEvent, type ConnectorSnapshot, type ConnectorStatus } from '../types'

/**
 * A Matrix account. On a homeserver running bridges (mautrix-whatsapp, -meta, -slack, -gmessages,
 * -telegram…), each bridged chat is a "portal" room: it shows up under its own network, and
 * replying in it sends on WhatsApp, Instagram and so on.
 *
 * matrix-js-sdk is large, so it is only downloaded once Matrix is connected. Encryption is not set
 * up: messages in end-to-end encrypted rooms show as a placeholder and replies there are refused.
 *
 * Ids: thread "mx:<roomId>", message "mx:<eventId>", contact "mx:<userId>".
 */

type Sdk = typeof import('matrix-js-sdk')

export interface MatrixConfig {
  baseUrl: string
  userId: string
  accessToken: string
  deviceId?: string
  /** Whether this app created the session (password login), so disconnecting should sign it out. */
  ownsSession: boolean
}

export interface MatrixLogin {
  /** "example.org", or a full homeserver URL. */
  homeserver: string
  user?: string
  password?: string
  accessToken?: string
}

/** Bridges announce the network they connect in a room state event. */
const BRIDGE_STATE_TYPES = ['m.bridge', 'uk.half-shot.bridge']

const PROTOCOLS: Record<string, NetworkId> = {
  whatsapp: 'whatsapp',
  telegram: 'telegram',
  instagram: 'instagram',
  slack: 'slack',
  slackgo: 'slack',
  gmessages: 'sms',
  sms: 'sms',
}

const SHOWN_EVENT_TYPES = new Set(['m.room.message', 'm.sticker', 'm.room.encrypted'])

const loadSdk = (): Promise<Sdk> => import('matrix-js-sdk')

/** Signs in and returns what's needed to reconnect later. Throws an Error with a readable message. */
export async function signInToMatrix(login: MatrixLogin): Promise<MatrixConfig> {
  const sdk = await loadSdk()
  const baseUrl = await resolveHomeserver(sdk, login.homeserver.trim(), login.user)
  try {
    if (login.accessToken?.trim()) {
      const accessToken = login.accessToken.trim()
      const who = await sdk.createClient({ baseUrl, accessToken }).whoami()
      return { baseUrl, userId: who.user_id, accessToken, deviceId: who.device_id, ownsSession: false }
    }
    const response = await sdk.createClient({ baseUrl }).loginRequest({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: login.user?.trim() ?? '' },
      password: login.password ?? '',
      initial_device_display_name: 'Tidings inbox',
    })
    return {
      baseUrl,
      userId: response.user_id,
      accessToken: response.access_token,
      deviceId: response.device_id,
      ownsSession: true,
    }
  } catch (error) {
    throw new Error(describeMatrixError(sdk, error))
  }
}

async function resolveHomeserver(sdk: Sdk, input: string, user?: string): Promise<string> {
  if (/^https?:\/\//i.test(input)) return input.replace(/\/+$/, '')
  // "example.org", or nothing but a full user id like "@aarav:example.org".
  const domain = input || user?.split(':').slice(1).join(':') || ''
  if (!domain) throw new Error('Enter your homeserver, like matrix.example.org.')
  try {
    const found = await sdk.AutoDiscovery.findClientConfig(domain)
    const homeserver = found['m.homeserver']
    if (homeserver.state === sdk.AutoDiscoveryAction.SUCCESS && homeserver.base_url) return homeserver.base_url.replace(/\/+$/, '')
  } catch {
    // No .well-known: assume the domain hosts the homeserver itself.
  }
  return `https://${domain}`
}

function describeMatrixError(sdk: Sdk, error: unknown): string {
  if (error instanceof sdk.MatrixError) {
    if (error.errcode === 'M_FORBIDDEN') return 'Wrong username or password.'
    if (error.errcode === 'M_UNKNOWN_TOKEN') return 'This access token is not valid (it may have been signed out).'
    if (error.errcode === 'M_USER_DEACTIVATED') return 'This account has been deactivated.'
    if (error.errcode === 'M_LIMIT_EXCEEDED') return 'Too many attempts. Wait a minute and try again.'
    return error.error ?? error.message
  }
  if (error instanceof sdk.ConnectionError || error instanceof TypeError) {
    return "Couldn't reach the homeserver. Check the address, and that it allows this site (CORS)."
  }
  return error instanceof Error ? error.message : 'Matrix sign-in failed.'
}

export class MatrixConnector implements Connector {
  readonly id = 'matrix' as const
  private readonly config: MatrixConfig
  private readonly events = new Emitter<ConnectorEvent>()
  private readonly statuses = new Emitter<ConnectorStatus>()
  private current: ConnectorStatus
  private sdk: Sdk | null = null
  private client: MatrixClient | null = null
  private ready = false
  private selfName: string | undefined
  /** Unread counts as last reported, to notice changes after each sync. */
  private readonly unread = new Map<string, number>()
  private readonly knownContacts = new Set<string>()

  constructor(config: MatrixConfig) {
    this.config = config
    this.current = { state: 'connecting', account: config.userId }
  }

  /* ── Connector ─────────────────────────────────────────────────────────── */

  snapshot(): ConnectorSnapshot {
    const client = this.client
    if (!client || !this.ready) return { contacts: [], threads: [], messages: [], selfName: this.selfName }
    const rooms = this.rooms()
    const contacts = new Map<string, Contact>()
    for (const room of rooms) for (const c of this.roomContacts(room)) contacts.set(c.id, c)
    this.knownContacts.clear()
    for (const id of contacts.keys()) this.knownContacts.add(id)
    return {
      contacts: [...contacts.values()],
      threads: rooms.map((room) => this.thread(room)),
      messages: rooms.flatMap((room) =>
        room
          .getLiveTimeline()
          .getEvents()
          .map((event) => this.message(event, room))
          .filter((m): m is Message => !!m),
      ),
      selfName: this.selfName,
    }
  }

  start() {
    if (this.client) return
    void this.run()
  }

  stop() {
    this.client?.stopClient()
    this.client?.removeAllListeners()
    this.client = null
    this.ready = false
  }

  async sendMessage(threadId: string, body: string): Promise<Message> {
    const client = this.requireClient()
    const roomId = threadId.slice('mx:'.length)
    if (client.getRoom(roomId)?.hasEncryptionStateEvent()) {
      throw new Error("This chat is end-to-end encrypted, and Tidings can't send encrypted messages yet. Reply from a Matrix app.")
    }
    const { event_id } = await client.sendTextMessage(roomId, body)
    return { id: `mx:${event_id}`, threadId, senderId: ME_ID, body, sentAt: new Date().toISOString(), status: 'sent' }
  }

  async markRead(threadId: string): Promise<Thread | null> {
    const client = this.requireClient()
    const room = client.getRoom(threadId.slice('mx:'.length))
    if (!room) return null
    const last = room
      .getLiveTimeline()
      .getEvents()
      .findLast((e) => !e.isSending() && !!e.getId())
    if (last) await client.setRoomReadMarkers(room.roomId, last.getId()!, last)
    // The homeserver recounts on the next sync; show it as read straight away.
    this.unread.set(room.roomId, 0)
    return { ...this.thread(room), unreadCount: 0 }
  }

  subscribe(listener: (event: ConnectorEvent) => void) {
    return this.events.on(listener)
  }

  status() {
    return this.current
  }

  onStatus(listener: (status: ConnectorStatus) => void) {
    return this.statuses.on(listener)
  }

  async forget() {
    const client = this.client
    this.stop()
    if (client && this.config.ownsSession) {
      // Sign out the session this app created. A pasted token belongs to another app: leave it alone.
      await client.logout(true).catch(() => undefined)
    }
  }

  /* ── Sync ──────────────────────────────────────────────────────────────── */

  private async run() {
    this.setStatus({ state: 'connecting', account: this.config.userId })
    let sdk: Sdk
    try {
      sdk = this.sdk ??= await loadSdk()
    } catch {
      this.setStatus({ state: 'error', account: this.config.userId, detail: "Couldn't load the Matrix client. Reload the page." })
      return
    }
    const client = sdk.createClient({
      baseUrl: this.config.baseUrl,
      accessToken: this.config.accessToken,
      userId: this.config.userId,
      deviceId: this.config.deviceId,
    })
    this.client = client

    client.on(sdk.ClientEvent.Sync, (state, _prev, data) => {
      if (state === sdk.SyncState.Prepared) {
        this.ready = true
        for (const room of this.rooms()) this.unread.set(room.roomId, this.unreadOf(room))
        this.setStatus(this.onlineStatus())
        this.events.emit({ type: 'reloaded' })
        void this.loadSelfName(client)
      } else if (state === sdk.SyncState.Syncing) {
        if (this.current.state !== 'online') this.setStatus(this.onlineStatus())
        this.emitUnreadChanges()
      } else if (state === sdk.SyncState.Reconnecting || state === sdk.SyncState.Catchup) {
        this.setStatus({ state: 'connecting', account: this.config.userId, detail: 'Reconnecting…' })
      } else if (state === sdk.SyncState.Error) {
        const error = data?.error
        if (error instanceof sdk.MatrixError && error.errcode === 'M_UNKNOWN_TOKEN') {
          this.stop()
          this.setStatus({ state: 'error', account: this.config.userId, detail: 'This session was signed out. Connect Matrix again.' })
        } else {
          this.setStatus({ state: 'error', account: this.config.userId, detail: "Can't reach your homeserver. Retrying…" })
        }
      }
    })

    client.on(sdk.RoomEvent.Timeline, (event, room, toStartOfTimeline, _removed, data) => {
      if (!this.ready || !room || toStartOfTimeline || !data?.liveEvent || event.isSending()) return
      this.onLiveEvent(event, room)
    })
    client.on(sdk.RoomEvent.Name, (room) => {
      if (this.ready && this.isShown(room)) this.events.emit({ type: 'thread.updated', thread: this.thread(room) })
    })
    client.on(sdk.RoomEvent.MyMembership, () => {
      // Joined or left a room: the room list changed.
      if (this.ready) {
        this.setStatus(this.onlineStatus())
        this.events.emit({ type: 'reloaded' })
      }
    })

    try {
      await client.startClient({
        initialSyncLimit: 30,
        lazyLoadMembers: true,
        pendingEventOrdering: sdk.PendingEventOrdering.Detached,
      })
    } catch {
      this.setStatus({ state: 'error', account: this.config.userId, detail: "Couldn't start syncing with your homeserver." })
    }
  }

  private onLiveEvent(event: MatrixEvent, room: Room) {
    if (!this.isShown(room)) return
    if (event.getType() === 'm.room.member') {
      for (const contact of this.roomContacts(room)) this.announceContact(contact)
      this.events.emit({ type: 'thread.updated', thread: this.thread(room) })
      return
    }
    if (event.isRelation('m.replace')) {
      const original = room.findEventById(event.getContent()['m.relates_to']?.event_id ?? '')
      const updated = original && this.message(original, room)
      if (updated) this.events.emit({ type: 'message.updated', message: updated })
      return
    }
    const message = this.message(event, room)
    if (!message) return
    const sender = event.getSender()
    if (sender && sender !== this.config.userId) {
      const member = room.getMember(sender)
      this.announceContact(this.contactFor(sender, member?.name ?? sender))
    }
    this.events.emit({ type: 'message.created', message })
  }

  private announceContact(contact: Contact) {
    if (this.knownContacts.has(contact.id)) return
    this.knownContacts.add(contact.id)
    this.events.emit({ type: 'contact.updated', contact })
  }

  private emitUnreadChanges() {
    for (const room of this.rooms()) {
      const count = this.unreadOf(room)
      if (this.unread.get(room.roomId) === count) continue
      this.unread.set(room.roomId, count)
      this.events.emit({ type: 'thread.updated', thread: this.thread(room) })
    }
  }

  private async loadSelfName(client: MatrixClient) {
    try {
      const profile = await client.getProfileInfo(this.config.userId)
      this.selfName = profile.displayname || undefined
    } catch {
      this.selfName = undefined
    }
  }

  /* ── Mapping ───────────────────────────────────────────────────────────── */

  /** Joined rooms that hold conversations (spaces are only folders). */
  private rooms(): Room[] {
    return (this.client?.getRooms() ?? []).filter((room) => this.isShown(room))
  }

  private isShown(room: Room) {
    return room.getMyMembership() === 'join' && room.getType() !== 'm.space'
  }

  private bridgeInfo(room: Room): { network: NetworkId; bots: Set<string> } {
    let network: NetworkId = 'matrix'
    const bots = new Set<string>()
    for (const type of BRIDGE_STATE_TYPES) {
      for (const state of room.currentState.getStateEvents(type)) {
        const content = state.getContent() as { protocol?: { id?: string }; bridgebot?: string }
        const mapped = PROTOCOLS[content.protocol?.id?.toLowerCase() ?? '']
        if (mapped) network = mapped
        if (content.bridgebot) bots.add(content.bridgebot)
      }
    }
    return { network, bots }
  }

  private thread(room: Room): Thread {
    const { network, bots } = this.bridgeInfo(room)
    const others = room.getJoinedMembers().filter((m) => m.userId !== this.config.userId && !bots.has(m.userId))
    const joinedOthers = room.getJoinedMemberCount() - 1 - [...bots].filter((b) => room.getMember(b)?.membership === 'join').length
    const direct = this.isDirect(room) || joinedOthers <= 1
    return {
      id: `mx:${room.roomId}`,
      network,
      kind: direct ? 'direct' : 'group',
      title: room.name || 'Matrix room',
      participantIds: others.map((m) => `mx:${m.userId}`),
      unreadCount: this.unreadOf(room),
      doneAt: null,
      snoozedUntil: null,
    }
  }

  private isDirect(room: Room): boolean {
    if (!this.sdk) return false
    const direct = this.client?.getAccountData(this.sdk.EventType.Direct)?.getContent() as
      | Record<string, string[]>
      | undefined
    return !!direct && Object.values(direct).some((ids) => ids.includes(room.roomId))
  }

  private unreadOf(room: Room): number {
    return this.sdk ? room.getUnreadNotificationCount(this.sdk.NotificationCountType.Total) : 0
  }

  private roomContacts(room: Room): Contact[] {
    const { bots } = this.bridgeInfo(room)
    return room
      .getJoinedMembers()
      .filter((m) => m.userId !== this.config.userId && !bots.has(m.userId))
      .map((m) => this.contactFor(m.userId, m.name))
  }

  private contactFor(userId: string, name: string): Contact {
    // Bridged "ghost" users often carry the phone number in their id: @whatsapp_919812345678:server
    const phone = /_(\+?\d{8,15})(?::|$)/.exec(userId)?.[1]
    return {
      id: `mx:${userId}`,
      name: name || userId,
      network: 'matrix',
      handle: phone ? `+${phone.replace(/^\+/, '')}` : userId,
    }
  }

  private message(event: MatrixEvent, room: Room): Message | null {
    if (!SHOWN_EVENT_TYPES.has(event.getType()) || event.isRedacted() || event.isRelation('m.replace')) return null
    const id = event.getId()
    const sender = event.getSender()
    if (!id || !sender) return null
    const parts = this.content(event, room)
    if (!parts) return null
    const fromMe = sender === this.config.userId
    return {
      id: `mx:${id}`,
      threadId: `mx:${room.roomId}`,
      senderId: fromMe ? ME_ID : `mx:${sender}`,
      body: parts.body,
      sentAt: new Date(event.getTs()).toISOString(),
      ...(fromMe ? { status: 'sent' as const } : {}),
      ...(parts.attachments ? { attachments: parts.attachments } : {}),
    }
  }

  private content(event: MatrixEvent, room: Room): { body: string; attachments?: Attachment[] } | null {
    if (event.getType() === 'm.room.encrypted') {
      return { body: '🔒 Encrypted message. Open it in a Matrix app to read it.' }
    }
    // getContent() already reflects the latest edit, if any.
    const c = event.getContent() as {
      msgtype?: string
      body?: string
      info?: { size?: number }
      'm.relates_to'?: { 'm.in_reply_to'?: unknown }
    }
    const body = typeof c.body === 'string' ? c.body : ''
    if (event.getType() === 'm.sticker') return { body: body || 'Sticker' }
    switch (c.msgtype) {
      case 'm.image':
        return { body: '', attachments: [{ kind: 'image', name: body || 'Image' }] }
      case 'm.file':
      case 'm.video':
      case 'm.audio': {
        const size = c.info?.size ? `${Math.max(1, Math.round(c.info.size / 1024))} KB` : undefined
        return { body: '', attachments: [{ kind: 'file', name: body || 'File', size }] }
      }
      case 'm.emote':
        return { body: `* ${room.getMember(event.getSender() ?? '')?.name ?? ''} ${body}`.trim() }
      case 'm.location':
        return { body: `📍 ${body}` }
      default:
        if (!body) return null
        // Replies carry a quoted copy of the original ("> <@user> …") for older clients; drop it.
        return { body: c['m.relates_to']?.['m.in_reply_to'] ? stripReplyFallback(body) : body }
    }
  }

  /* ── Status ────────────────────────────────────────────────────────────── */

  private onlineStatus(): ConnectorStatus {
    const invites = (this.client?.getRooms() ?? []).filter((room) => room.getMyMembership() === 'invite').length
    return {
      state: 'online',
      account: this.config.userId,
      detail: invites ? `${invites} room invite${invites === 1 ? '' : 's'} waiting. Accept them in a Matrix app.` : undefined,
    }
  }

  private setStatus(status: ConnectorStatus) {
    this.current = status
    this.statuses.emit(status)
  }

  private requireClient(): MatrixClient {
    if (!this.client || !this.ready) throw new Error('Matrix is still connecting. Try again in a moment.')
    return this.client
  }
}

export function stripReplyFallback(body: string): string {
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length && lines[i].startsWith('>')) i++
  if (i === 0) return body
  while (i < lines.length && lines[i].trim() === '') i++
  return lines.slice(i).join('\n') || body
}
