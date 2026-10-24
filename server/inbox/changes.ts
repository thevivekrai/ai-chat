import type { ObjectId } from 'mongodb'
import type { Message } from '../../src/data/types.ts'
import type { Hub } from '../realtime.ts'
import type { InboxStore } from './store.ts'

export type MessagePatch = Parameters<InboxStore['updateMessage']>[2]

/**
 * Changing a kept message, or removing it, and telling the user's devices: the same for every
 * network, so it's written once.
 */
export function messageChanges({ store, hub }: { store: InboxStore; hub: Hub }) {
  return {
    /** Changes a kept message and tells the user's devices; null when the server doesn't keep it. */
    async changeMessage(userId: ObjectId, id: string, patch: MessagePatch): Promise<Message | null> {
      const message = await store.updateMessage(userId, id, patch)
      if (message) hub.publish(userId.toHexString(), { type: 'message.updated', message })
      return message
    },

    /** Gone from the chat (deleted for me, say): from the server, and from every device. */
    async removeForMe(userId: ObjectId, threadId: string, messageId: string) {
      await store.deleteMessage(userId, threadId, messageId)
      hub.publish(userId.toHexString(), { type: 'message.deleted', threadId, messageId })
    },
  }
}
