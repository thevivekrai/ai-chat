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

/** Why accounts aren't available: no server at all, or a server without its database. */
export type ServerProblem = 'absent' | 'database'

interface SessionState {
  status: SessionStatus
  features: ServerFeatures | null
  serverProblem: ServerProblem | null
  user: PublicUser | null
  /** Shown on the sign-in screen, e.g. why the user was signed out. */
  notice: string | null
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

  async init() {
    const features = await serverApi.features()
    if (!features) {
      set({ status: 'no-server', serverProblem: 'absent' })
      return
    }
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

/** Whether the server can link WhatsApp and Telegram for this user right now. */
export const canLink = (s: Pick<SessionState, 'status'>) => s.status === 'signed-in'
