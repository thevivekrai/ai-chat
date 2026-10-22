import { MongoClient, type Collection, type Db, type ObjectId } from 'mongodb'
import type { AccountStatus, LinkedNetwork } from '../src/data/server/types.ts'
import type { Attachment, MessageStatus, NetworkId, ThreadKind } from '../src/data/types.ts'

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
}

export interface ContactDoc {
  userId: ObjectId
  id: string
  network: NetworkId
  /** Sealed { name, handle }. */
  data: string
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
}

export interface Collections {
  users: Collection<UserDoc>
  accounts: Collection<AccountDoc>
  waAuth: Collection<WaAuthDoc>
  threads: Collection<ThreadDoc>
  contacts: Collection<ContactDoc>
  messages: Collection<MessageDoc>
}

export interface Database {
  client: MongoClient
  db: Db
  col: Collections
  close(): Promise<void>
}

/** The database named in the connection string, or "tidings" if it names none (Atlas strings often don't). */
export function databaseName(uri: string): string {
  const name = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(uri)?.[1]
  return name ? decodeURIComponent(name) : 'tidings'
}

export async function connectDatabase(uri: string, dbName = databaseName(uri)): Promise<Database> {
  const client = new MongoClient(uri, { appName: 'tidings' })
  await client.connect()
  const db = client.db(dbName)
  const col: Collections = {
    users: db.collection('users'),
    accounts: db.collection('accounts'),
    waAuth: db.collection('wa_auth'),
    threads: db.collection('threads'),
    contacts: db.collection('contacts'),
    messages: db.collection('messages'),
  }
  await ensureIndexes(col)
  return { client, db, col, close: () => client.close() }
}

async function ensureIndexes(col: Collections) {
  await Promise.all([
    col.users.createIndex({ email: 1 }, { unique: true }),
    col.users.createIndex({ googleSub: 1 }, { unique: true, partialFilterExpression: { googleSub: { $type: 'string' } } }),
    col.accounts.createIndex({ userId: 1, network: 1 }, { unique: true }),
    col.accounts.createIndex({ network: 1, status: 1 }),
    col.waAuth.createIndex({ userId: 1, key: 1 }, { unique: true }),
    col.threads.createIndex({ userId: 1, id: 1 }, { unique: true }),
    col.threads.createIndex({ userId: 1, lastAt: -1 }),
    col.contacts.createIndex({ userId: 1, id: 1 }, { unique: true }),
    col.messages.createIndex({ userId: 1, id: 1 }, { unique: true }),
    col.messages.createIndex({ userId: 1, threadId: 1, sentAt: -1 }),
  ])
}
