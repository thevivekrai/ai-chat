import type { ObjectId } from 'mongodb'
import type { PublicAccount } from '../../src/data/server/types.ts'
import type { AccountDoc, AccountStatus, Collections, LinkedNetwork } from '../db.ts'
import type { Hub } from '../realtime.ts'

const toPublic = (doc: AccountDoc): PublicAccount => ({
  network: doc.network,
  status: doc.status,
  ...(doc.label ? { label: doc.label } : {}),
  ...(doc.detail ? { detail: doc.detail } : {}),
  ...(doc.step ? { step: doc.step } : {}),
  ...(doc.hint ? { hint: doc.hint } : {}),
})

export function createAccounts(col: Collections, hub: Hub) {
  return {
    async get(userId: ObjectId, network: LinkedNetwork) {
      return col.accounts.findOne({ userId, network })
    },

    async list(userId: ObjectId): Promise<PublicAccount[]> {
      return (await col.accounts.find({ userId }).toArray()).map(toPublic)
    },

    /**
     * Updates a linked account and tells the user's open tabs. `detail`, `step` and `hint` describe
     * the moment, so they're cleared unless given.
     */
    async set(
      userId: ObjectId,
      network: LinkedNetwork,
      patch: {
        status: AccountStatus
        label?: string
        detail?: string
        session?: string
        step?: AccountDoc['step']
        hint?: string
      },
    ): Promise<PublicAccount> {
      const now = new Date()
      const transient = ['detail', 'step', 'hint'] as const
      const cleared: Partial<Record<(typeof transient)[number], ''>> = {}
      for (const key of transient) if (patch[key] === undefined) cleared[key] = ''
      const doc = await col.accounts.findOneAndUpdate(
        { userId, network },
        {
          $set: {
            status: patch.status,
            updatedAt: now,
            ...(patch.label !== undefined ? { label: patch.label } : {}),
            ...(patch.session !== undefined ? { session: patch.session } : {}),
            ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
            ...(patch.step !== undefined ? { step: patch.step } : {}),
            ...(patch.hint !== undefined ? { hint: patch.hint } : {}),
          },
          ...(Object.keys(cleared).length ? { $unset: cleared } : {}),
          $setOnInsert: { createdAt: now },
        },
        { upsert: true, returnDocument: 'after' },
      )
      const account = toPublic(doc!)
      hub.publish(userId.toHexString(), { type: 'account.updated', account })
      return account
    },

    async remove(userId: ObjectId, network: LinkedNetwork) {
      await col.accounts.deleteOne({ userId, network })
      hub.publish(userId.toHexString(), { type: 'account.updated', account: { network, status: 'unlinked' } })
    },

    /** Accounts to reconnect when the server starts. */
    async toResume(network: LinkedNetwork) {
      return col.accounts.find({ network, status: { $in: ['connected', 'error'] } }).toArray()
    },
  }
}

export type Accounts = ReturnType<typeof createAccounts>
