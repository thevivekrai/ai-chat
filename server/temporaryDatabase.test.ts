import { ObjectId } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { connectDatabase, copyDatabase } from './db.ts'
import { startTemporaryDatabase } from './temporaryDatabase.ts'
import { TEST_MONGODB_URI } from './testing/helpers.ts'

describe.skipIf(!TEST_MONGODB_URI)('moving from temporary storage to the database', () => {
  it('copies everything with its ids, and leaves alone what the database already has', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const from = await connectDatabase(TEST_MONGODB_URI!, `sytext_from_${suffix}`)
    const to = await connectDatabase(TEST_MONGODB_URI!, `sytext_to_${suffix}`)
    try {
      const now = new Date()
      const aarav = { _id: new ObjectId(), email: 'aarav@example.com', name: 'Aarav', createdAt: now, updatedAt: now }
      const meera = { _id: new ObjectId(), email: 'meera@example.com', name: 'Meera', createdAt: now, updatedAt: now }
      await from.col.users.insertMany([aarav, meera])
      await from.col.waAuth.insertOne({ userId: aarav._id, key: 'creds', value: 'sealed' })
      // The database already has Meera (signed up there before).
      await to.col.users.insertOne({ ...meera, _id: new ObjectId(), name: 'Meera (already here)' })

      expect(await copyDatabase(from, to)).toBe(2) // Aarav and his WhatsApp keys.
      expect(await to.col.users.findOne({ _id: aarav._id })).toMatchObject({ email: 'aarav@example.com' })
      expect(await to.col.users.findOne({ email: 'meera@example.com' })).toMatchObject({ name: 'Meera (already here)' })
      expect(await to.col.waAuth.countDocuments({ userId: aarav._id })).toBe(1)
      // Again: nothing new to copy.
      expect(await copyDatabase(from, to)).toBe(0)
    } finally {
      await from.db.dropDatabase()
      await to.db.dropDatabase()
      await from.close()
      await to.close()
    }
  })
})

// Needs a mongod on this machine (MONGOMS_SYSTEM_BINARY); without one it would be downloaded.
describe.skipIf(!process.env.MONGOMS_SYSTEM_BINARY)('temporary storage', () => {
  it('runs a private database the app can use, and stops it', async () => {
    const temporary = await startTemporaryDatabase()
    try {
      const database = await connectDatabase(temporary.uri, 'sytext')
      await database.col.users.insertOne({ _id: new ObjectId(), email: 'a@example.com', name: 'A', createdAt: new Date(), updatedAt: new Date() })
      expect(await database.col.users.countDocuments()).toBe(1)
      await database.close()
    } finally {
      await temporary.stop()
    }
  }, 60_000)
})
