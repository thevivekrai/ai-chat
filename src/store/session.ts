import { create } from 'zustand'
import { api } from '@/data/api'
import { serverApi } from '@/data/server/serverApi'
import type { PublicUser, ServerFeatures } from '@/data/server/types'
import { storage } from '@/data/storage'
import { useInbox } from './inbox'

/**
 * Who is using the app.
 *
 * - no-server: there is no Sytext server (a static deploy); the app runs without accounts.
 * - signed-out: the sign-in screen.
 * - guest: trying the demo without an account.
 * - signed-in: the WhatsApp and Telegram accounts linked on the server are in the inbox.
 */
export type SessionStatus = 'checking' | 'no-server' | 'signed-out' | 'guest' | 'signed-in'

const GUEST_KEY = 'tidings.guest'

interface SessionState {
  status: SessionStatus
  features: ServerFeatures | null
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
  user: null,
  notice: null,

  async init() {
    const features = await serverApi.features()
    if (!features) {
      set({ status: 'no-server' })
      return
    }
    const user = await serverApi.me().catch(() => null)
    if (user) {
      set({ features })
      await get().signedIn(user)
    } else {
      set({ features, status: storage.get(GUEST_KEY) ? 'guest' : 'signed-out' })
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
