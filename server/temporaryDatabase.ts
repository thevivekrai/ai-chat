import { MongoMemoryServer } from 'mongodb-memory-server-core'

/**
 * The MongoDB version run for temporary storage. MongoDB publishes it for Ubuntu 22.04 (also used
 * on 24.04) and Debian 12, which covers hosts like Render. It's downloaded from MongoDB on first
 * use; MONGOMS_SYSTEM_BINARY can point at a mongod already on the machine instead.
 */
const VERSION = '7.0.45'

export interface TemporaryDatabase {
  uri: string
  stop(): Promise<void>
}

/**
 * A private MongoDB, run by this server, for when the database in MONGODB_URI can't be reached:
 * signing in and linking accounts then work anyway. It keeps its files in a temporary folder, so
 * everything in it is gone when the server restarts — which is why the server moves it all to the
 * real database as soon as that answers.
 */
export async function startTemporaryDatabase(): Promise<TemporaryDatabase> {
  const server = await MongoMemoryServer.create({
    binary: { version: VERSION },
    // The smallest cache MongoDB allows: the data is small, and free hosts have little memory.
    instance: { args: ['--wiredTigerCacheSizeGB', '0.25'] },
  })
  return {
    uri: server.getUri(),
    stop: async () => {
      await server.stop({ doCleanup: true, force: false })
    },
  }
}
