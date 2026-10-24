import { create } from 'zustand'
import { api } from '@/data/api'
import { wipeDeviceStore } from '@/data/server/deviceStore'
import { serverApi } from '@/data/server/serverApi'
import type { PublicUser, ServerFeatures } from '@/data/server/types'
import { storage } from '@/data/storage'
import { useInbox } from './inbox'
import { useUi } from './ui'

/**
 * Who is using the app.
 *
 * - no-server: no Sytext server to hold accounts, either because there is none (a static deploy)
 *   or because it can't reach its database; the app runs without accounts either way.
 * - signed-out: the sign-in screen.
 * - guest: trying the demo without an account.
 * - signed-in: the WhatsApp and Telegram accounts linked on the server are in the inbox.
 */
export type SessionStatus = 'checking' | 'no-server' | 'signed-out' | 'guest' | 'signed-in'

const GUEST_KEY = 'tidings.guest'

/** While the server is waiting for its database, it's asked again this often (it keeps trying too). */
export const DATABASE_RECHECK_MS = 30_000

/** Why accounts aren't available: no server at all, or a server without its database. */
export type ServerProblem = 'absent' | 'database'

interface SessionState {
  status: SessionStatus
  features: ServerFeatures | null
  serverProblem: ServerProblem | null
  user: PublicUser | null
  /** Shown on the sign-in screen, e.g. why the user was signed out. */
  notice: string | null
  /** A new recovery key to show the user, this once (the server keeps only its hash). */
  recoveryKey: string | null
  showRecoveryKey(key: string): void
  recoveryKeySaved(): void
  /** Works out where the user stands; call once on start. */
  init(): Promise<void>
  /** After signing in or creating an account. */
  signedIn(user: PublicUser): Promise<void>
  setUser(user: PublicUser): void
  /** Back to the sign-in screen (the server session is already gone). */
  signedOut(notice?: string): Promise<void>
  continueAsGuest(): void
  /** From guest mode to the sign-in screen. */
  showSignIn(): void
}

export const useSession = create<SessionState>()((set, get) => ({
  status: 'checking',
  features: null,
  serverProblem: null,
  user: null,
  notice: null,
  recoveryKey: null,

  showRecoveryKey(key) {
    set({ recoveryKey: key })
  },

  recoveryKeySaved() {
    set({ recoveryKey: null })
  },

  async init() {
    const features = await serverApi.features()
    if (!features) {
      set({ status: 'no-server', serverProblem: 'absent' })
      return
    }
    if (!features.database || features.storage === 'temporary') watchDatabase()
    if (!features.database) {
      // The server is up but can't reach its database; it keeps trying, so reloading later works.
      set({ status: 'no-server', features, serverProblem: 'database' })
      return
    }
    const user = await serverApi.me().catch(() => null)
    if (user) {
      set({ features, serverProblem: null })
      await get().signedIn(user)
    } else {
      // The session ended while the app was closed: chats kept on this device go too.
      void wipeDeviceStore()
      set({ features, serverProblem: null, status: storage.get(GUEST_KEY) ? 'guest' : 'signed-out' })
    }
  },

  async signedIn(user) {
    storage.remove(GUEST_KEY)
    set({ status: 'signed-in', user, notice: null })
    await api.connections.setServerSession(user)
  },

  setUser(user) {
    set({ user })
    void api.connections.setServerSession(user)
  },

  async signedOut(notice) {
    storage.remove(GUEST_KEY)
    useInbox.getState().clear()
    // Signing back in starts at the inbox, not wherever the last person left off.
    useUi.getState().closeDialog()
    // A recovery key being shown stays until it's saved: the server already has it in place of the
    // old one, so losing it here would leave a working key nobody saw.
    set({ status: 'signed-out', user: null, notice: notice ?? null })
    await api.connections.setServerSession(null)
  },

  continueAsGuest() {
    storage.set(GUEST_KEY, '1')
    set({ status: 'guest', notice: null })
  },

  showSignIn() {
    storage.remove(GUEST_KEY)
    useInbox.getState().clear()
    set({ status: 'signed-out', notice: null })
  },
}))

let recheck: ReturnType<typeof setInterval> | null = null

/**
 * Asks the server again every so often while it can't use its database, so the page catches up by
 * itself once it can: no reload needed. Accounts made in temporary storage move over with
 * everything else, so whoever is signed in stays signed in.
 */
function watchDatabase() {
  if (recheck) return
  recheck = setInterval(() => void checkDatabase(), DATABASE_RECHECK_MS)
}

export function stopWatchingDatabase() {
  if (recheck) clearInterval(recheck)
  recheck = null
}

async function checkDatabase() {
  const next = await serverApi.features()
  if (!next) return // The server itself didn't answer this time.
  const { status, features } = useSession.getState()
  if (!next.database) {
    // Still waiting, or busy for a moment moving temporary storage over. The reason may have changed.
    if (status === 'no-server') useSession.setState({ features: next })
    return
  }
  const waiting = next.storage === 'temporary'
  if (!waiting) stopWatchingDatabase()
  if (status === 'no-server') {
    // Accounts work now (in the database, or in temporary storage meanwhile): show the sign-in.
    await useSession.getState().init()
  } else if (!waiting || next.databaseProblem !== features?.databaseProblem) {
    useSession.setState({ features: next })
  }
}

/** Whether the server can link WhatsApp and Telegram for this user right now. */
export const canLink = (s: Pick<SessionState, 'status'>) => s.status === 'signed-in'
