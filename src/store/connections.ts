import { create } from 'zustand'
import { api, type ConnectionsState } from '@/data/api'

/** Which accounts are connected and how they're doing, kept in sync with the data layer. */
export const useConnections = create<ConnectionsState>(() => api.connections.get())

api.connections.subscribe((state) => useConnections.setState(state, true))

/** Whether any real account is connected (as opposed to only the demo inbox). */
export const hasRealAccount = (s: ConnectionsState) =>
  !!(s.telegram || s.matrix || s.server?.whatsapp || s.server?.telegram || s.server?.guffshuff)
