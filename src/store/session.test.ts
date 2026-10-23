import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerFeatures } from '@/data/server/types'

const server = vi.hoisted(() => ({ features: vi.fn(), me: vi.fn() }))
vi.mock('@/data/server/serverApi', () => ({ serverApi: server }))
vi.mock('@/data/server/deviceStore', () => ({ wipeDeviceStore: vi.fn(async () => undefined) }))

const { DATABASE_RECHECK_MS, stopWatchingDatabase, useSession } = await import('./session')

const base: ServerFeatures = { googleClientId: null, whatsapp: true, telegram: true, uploads: false, database: true }
const temporary: ServerFeatures = { ...base, storage: 'temporary', databaseProblem: 'unreachable' }
const ready: ServerFeatures = { ...base, storage: 'database' }
const holding: ServerFeatures = { ...base, whatsapp: false, telegram: false, database: false, databaseProblem: 'auth' }

describe('waiting for the database', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    server.features.mockReset()
    server.me.mockReset().mockResolvedValue(null)
    useSession.setState({ status: 'checking', features: null, serverProblem: null, user: null })
  })
  afterEach(() => {
    stopWatchingDatabase()
    vi.useRealTimers()
  })

  it('drops the temporary-storage note by itself once the database connects', async () => {
    server.features.mockResolvedValue(temporary)
    await useSession.getState().init()
    expect(useSession.getState()).toMatchObject({ status: 'signed-out', features: { storage: 'temporary' } })

    // Still waiting: nothing changes.
    await vi.advanceTimersByTimeAsync(DATABASE_RECHECK_MS)
    expect(useSession.getState().features?.storage).toBe('temporary')

    // A moment while everything moves over: the server answers without a database. Still nothing changes.
    server.features.mockResolvedValue(holding)
    await vi.advanceTimersByTimeAsync(DATABASE_RECHECK_MS)
    expect(useSession.getState()).toMatchObject({ status: 'signed-out', features: { storage: 'temporary' } })

    server.features.mockResolvedValue(ready)
    await vi.advanceTimersByTimeAsync(DATABASE_RECHECK_MS)
    expect(useSession.getState()).toMatchObject({ status: 'signed-out', features: { storage: 'database' } })

    // And it stops asking.
    const calls = server.features.mock.calls.length
    await vi.advanceTimersByTimeAsync(DATABASE_RECHECK_MS * 3)
    expect(server.features.mock.calls.length).toBe(calls)
  })

  it('shows the sign-in once a server without its database gets one, without a reload', async () => {
    server.features.mockResolvedValue(holding)
    await useSession.getState().init()
    expect(useSession.getState()).toMatchObject({ status: 'no-server', serverProblem: 'database', features: { databaseProblem: 'auth' } })

    // The reason changed (the password was fixed, now it's the access list): the help follows.
    server.features.mockResolvedValue({ ...holding, databaseProblem: 'unreachable' })
    await vi.advanceTimersByTimeAsync(DATABASE_RECHECK_MS)
    expect(useSession.getState().features?.databaseProblem).toBe('unreachable')

    server.features.mockResolvedValue(ready)
    await vi.advanceTimersByTimeAsync(DATABASE_RECHECK_MS)
    expect(useSession.getState()).toMatchObject({ status: 'signed-out', serverProblem: null, features: { storage: 'database' } })
  })
})
