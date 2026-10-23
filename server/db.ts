import { MongoClient, type Collection, type Db, type IndexSpecification, type MongoServerError, type ObjectId } from 'mongodb'
import type { AccountStatus, LinkedNetwork } from '../src/data/server/types.ts'
import { ConfigError } from './config.ts'
import type { Attachment, MessageStatus, NetworkId, QuotedMessage, Reaction, ThreadKind } from '../src/data/types.ts'

export type { AccountStatus, LinkedNetwork }

export interface UserDoc {
  _id: ObjectId
  email: string
  name: string
  /** scrypt hash; absent for accounts that only sign in with Google. */
  passwordHash?: string
  googleSub?: string
  avatarUrl?: string
  /** Sessions started before this are no longer accepted. */
  sessionsValidAfter?: Date
  createdAt: Date
  updatedAt: Date
}

export interface AccountDoc {
  _id: ObjectId
  userId: ObjectId
  network: LinkedNetwork
  status: AccountStatus
  /** Who it's linked as: a phone number or @username. */
  label?: string
  /** What's going on, in words for the user. */
  detail?: string
  /** Sealed session (Telegram); WhatsApp keeps its keys in `waAuth`. */
  session?: string
  /** While linking: what the user is asked for next. */
  step?: 'code' | 'qr' | 'password'
  /** Telegram's hint for the two-step verification password. */
  hint?: string
  createdAt: Date
  updatedAt: Date
}

/** One entry of a WhatsApp session's key store, sealed. */
export interface WaAuthDoc {
  userId: ObjectId
  key: string
  value: string
}

export interface ThreadDoc {
  userId: ObjectId
  id: string
  network: NetworkId
  kind: ThreadKind
  /** Sealed title. */
  title: string
  participantIds: string[]
  unreadCount: number
  lastAt: Date
  updatedAt: Date
  /** The group's picture, served by /api/avatars. */
  avatarUrl?: string
}

export interface ContactDoc {
  userId: ObjectId
  id: string
  network: NetworkId
  /** Sealed { name, handle, avatarUrl }. */
  data: string
}

/**
 * A profile or group picture: that there is one, not the image (that's kept in memory and
 * fetched from the network again when needed, so it takes no space here).
 */
export interface AvatarDoc {
  userId: ObjectId
  /** The contact or chat it belongs to. */
  id: string
  /** Short content hash, so the URL changes when the picture does; absent when there's no picture. */
  version?: string
  /** Sealed link to download it again from, where the network gives one (WhatsApp). */
  source?: string
  /** Earlier versions kept the image here; removed on start. */
  data?: string
  contentType?: string
  checkedAt: Date
}

export interface MessageDoc {
  userId: ObjectId
  id: string
  threadId: string
  senderId: string
  sentAt: Date
  status?: MessageStatus
  /** Sealed { body, attachments }. */
  payload: string
  /** Network-specific reference used to mark read or download media (e.g. a WhatsApp message key). */
  ref?: Record<string, unknown>
}

export interface MessagePayload {
  body: string
  attachments?: Attachment[]
  replyTo?: QuotedMessage
  /** Who reacted with what, by sender id ("me" for the user), where the network says (WhatsApp). */
  reactionsBy?: Record<string, string>
  /** Totals only, where that's all the network gives (Telegram). */
  reactionTotals?: Reaction[]
}

export interface Collections {
  users: Collection<UserDoc>
  accounts: Collection<AccountDoc>
  waAuth: Collection<WaAuthDoc>
  threads: Collection<ThreadDoc>
  contacts: Collection<ContactDoc>
  messages: Collection<MessageDoc>
  avatars: Collection<AvatarDoc>
}

export interface Database {
  client: MongoClient
  db: Db
  col: Collections
  close(): Promise<void>
}

/** The database named in the connection string, or "sytext" if it names none (Atlas strings often don't). */
export function databaseName(uri: string): string {
  const name = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(uri)?.[1]
  return name ? decodeURIComponent(name) : 'sytext'
}

export async function connectDatabase(uri: string, dbName = databaseName(uri)): Promise<Database> {
  const client = new MongoClient(uri, { appName: 'sytext' })
  try {
    await client.connect()
    // connect() can return before a server has answered; this waits for one.
    await client.db(dbName).command({ ping: 1 })
  } catch (error) {
    await client.close().catch(() => undefined)
    throw cannotConnect(error)
  }
  const db = client.db(dbName)
  const col: Collections = {
    users: db.collection('users'),
    accounts: db.collection('accounts'),
    waAuth: db.collection('wa_auth'),
    threads: db.collection('threads'),
    contacts: db.collection('contacts'),
    messages: db.collection('messages'),
    avatars: db.collection('avatars'),
  }
  try {
    await ensureIndexes(col)
  } catch (error) {
    await client.close()
    throw error
  }
  return { client, db, col, close: () => client.close() }
}

/**
 * Why MongoDB wouldn't talk to us, in words for whoever deployed the server. The original error is
 * kept at the end: these are the usual causes, not a diagnosis.
 */
function cannotConnect(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''
  const refused = name === 'MongoServerSelectionError' || name === 'MongoNetworkError'
  // A rejected TLS handshake, a timeout, or no route: the database never let us in.
  if (refused) {
    return new ConfigError(
      "Couldn't reach the database in MONGODB_URI. On MongoDB Atlas this is usually one of: " +
        'its IP access list (Network Access → Add IP Address → "Allow access from anywhere", 0.0.0.0/0, ' +
        'since a host like Render has no fixed address, and temporary entries expire); ' +
        'a paused cluster (Clusters → Resume); or a cluster that no longer exists. ' +
        `(MongoDB said: ${detail})`,
    )
  }
  // The handshake worked, the user didn't.
  if (/auth|credential/i.test(detail)) {
    return new ConfigError(
      'The database rejected the user or password in MONGODB_URI. Check them under Atlas → Database Access, ' +
        'and URL-encode any punctuation in the password (or set one with only letters and digits). ' +
        `(MongoDB said: ${detail})`,
    )
  }
  return error instanceof Error ? error : new Error(detail)
}

/** MongoDB's codes for "an index like this exists, set up differently". */
const INDEX_CONFLICTS = new Set([85, 86])

async function ensureIndexes(col: Collections) {
  // A collection of the same name from another app, in a database shared with it, has indexes of
  // its own: say so plainly rather than with MongoDB's error.
  const index = async <T extends object>(collection: Collection<T>, keys: IndexSpecification, options = {}) => {
    try {
      await collection.createIndex(keys, options)
    } catch (error) {
      if (!INDEX_CONFLICTS.has(Number((error as MongoServerError).code))) throw error
      throw new ConfigError(
        `The database "${collection.dbName}" already has a "${collection.collectionName}" collection, set up by another app. ` +
          'Give Sytext a database of its own: put a name for it in MONGODB_URI, after the host and before any "?", ' +
          'like mongodb+srv://USER:PASSWORD@cluster0.example.mongodb.net/sytext?retryWrites=true. ' +
          `(MongoDB said: ${(error as MongoServerError).errmsg ?? (error as Error).message})`,
      )
    }
  }
  await Promise.all([
    index(col.users, { email: 1 }, { unique: true }),
    index(col.users, { googleSub: 1 }, { unique: true, partialFilterExpression: { googleSub: { $type: 'string' } } }),
    index(col.accounts, { userId: 1, network: 1 }, { unique: true }),
    index(col.accounts, { network: 1, status: 1 }),
    index(col.waAuth, { userId: 1, key: 1 }, { unique: true }),
    index(col.threads, { userId: 1, id: 1 }, { unique: true }),
    index(col.threads, { userId: 1, lastAt: -1 }),
    index(col.contacts, { userId: 1, id: 1 }, { unique: true }),
    index(col.messages, { userId: 1, id: 1 }, { unique: true }),
    index(col.messages, { userId: 1, threadId: 1, sentAt: -1 }),
    index(col.avatars, { userId: 1, id: 1 }, { unique: true }),
  ])
}
