import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { NetworkId } from '@/data/types'

export type View = 'needs-reply' | 'all' | 'waiting' | 'scheduled' | 'tasks' | 'starred'

/** Searching inside the open chat: what for, and which match is on screen. */
export interface ChatSearch {
  threadId: string
  query: string
  /** The message of the current match, if any. */
  current: string | null
}
export type Dialog = 'command' | 'settings' | 'shortcuts'
export type SettingsTab = 'profile' | 'accounts' | 'ai' | 'appearance'

interface UiState {
  view: View
  /** Network filter chips; empty means all networks. */
  networks: NetworkId[]
  listQuery: string
  selectedThreadId: string | null
  /** Small screens show one pane at a time: true while a conversation is on screen. */
  mobileThreadOpen: boolean
  sidebarOpen: boolean
  /** Docked AI panel on wide screens. */
  aiPanelOpen: boolean
  /** Overlay AI panel on narrower screens. */
  aiSheetOpen: boolean
  draftsOpen: boolean
  snoozeMenuOpen: boolean
  /** Unsent composer text per thread. */
  composer: Record<string, string>
  /** The message being replied to, per thread. */
  replyingTo: Record<string, string>
  /** The message of mine being edited, per thread (the composer holds its new text). */
  editing: Record<string, string>
  chatSearch: ChatSearch | null
  composerFocusTick: number
  searchFocusTick: number
  flash: { messageId: string; tick: number } | null
  /** Thread order of the list on screen, for J/K. */
  navThreadIds: string[]
  /** Last list position of the selection, so J/K continue after a thread leaves the list. */
  navIndex: number
  dialog: Dialog | null
  settingsTab: SettingsTab
  /** The "connect your accounts" banner was dismissed. */
  connectHintDismissed: boolean

  setView(view: View): void
  toggleNetwork(network: NetworkId): void
  clearNetworks(): void
  setListQuery(query: string): void
  selectThread(threadId: string | null): void
  closeMobileThread(): void
  moveSelection(delta: 1 | -1): void
  setNavThreadIds(ids: string[]): void
  setComposer(threadId: string, text: string): void
  setReplyingTo(threadId: string, messageId: string | null): void
  setEditing(threadId: string, messageId: string | null): void
  /** Opens the in-chat search (or changes it); null closes it. */
  setChatSearch(search: ChatSearch | null): void
  focusComposer(): void
  focusSearch(): void
  setDraftsOpen(open: boolean): void
  setSnoozeMenuOpen(open: boolean): void
  setAiPanelOpen(open: boolean): void
  setAiSheetOpen(open: boolean): void
  setSidebarOpen(open: boolean): void
  flashMessage(messageId: string): void
  openDialog(dialog: Dialog): void
  openSettings(tab?: SettingsTab): void
  setSettingsTab(tab: SettingsTab): void
  dismissConnectHint(): void
  closeDialog(): void
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i])

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
      view: 'needs-reply',
      networks: [],
      listQuery: '',
      selectedThreadId: null,
      mobileThreadOpen: false,
      sidebarOpen: false,
      aiPanelOpen: true,
      aiSheetOpen: false,
      draftsOpen: false,
      snoozeMenuOpen: false,
      composer: {},
      replyingTo: {},
      editing: {},
      chatSearch: null,
      composerFocusTick: 0,
      searchFocusTick: 0,
      flash: null,
      navThreadIds: [],
      navIndex: -1,
      dialog: null,
      settingsTab: 'accounts',
      connectHintDismissed: false,

      setView: (view) => set({ view, sidebarOpen: false, listQuery: '' }),
      toggleNetwork: (network) =>
        set((s) => ({
          networks: s.networks.includes(network) ? s.networks.filter((n) => n !== network) : [...s.networks, network],
        })),
      clearNetworks: () => set({ networks: [] }),
      setListQuery: (listQuery) => set({ listQuery }),

      selectThread(threadId) {
        const index = threadId ? get().navThreadIds.indexOf(threadId) : -1
        set((s) => ({
          selectedThreadId: threadId,
          mobileThreadOpen: !!threadId,
          draftsOpen: threadId === s.selectedThreadId ? s.draftsOpen : false,
          chatSearch: s.chatSearch?.threadId === threadId ? s.chatSearch : null,
          snoozeMenuOpen: false,
          aiSheetOpen: false,
          navIndex: index === -1 ? s.navIndex : index,
        }))
      },

      closeMobileThread: () => set({ mobileThreadOpen: false, draftsOpen: false, aiSheetOpen: false }),

      moveSelection(delta) {
        const { navThreadIds: ids, selectedThreadId, navIndex } = get()
        if (ids.length === 0) return
        const index = selectedThreadId ? ids.indexOf(selectedThreadId) : -1
        let next: number
        if (index !== -1) next = index + delta
        else if (navIndex === -1) next = 0
        // The open thread left the list (replied / done): the next one has slid into its place.
        else next = delta > 0 ? navIndex : navIndex - 1
        get().selectThread(ids[Math.max(0, Math.min(ids.length - 1, next))])
      },

      setNavThreadIds(ids) {
        const { navThreadIds, selectedThreadId } = get()
        if (sameIds(ids, navThreadIds)) return
        const index = selectedThreadId ? ids.indexOf(selectedThreadId) : -1
        set((s) => ({ navThreadIds: ids, navIndex: index === -1 ? s.navIndex : index }))
      },

      setComposer: (threadId, text) =>
        set((s) => {
          const composer = { ...s.composer }
          if (text) composer[threadId] = text
          else delete composer[threadId]
          return { composer }
        }),
      setReplyingTo: (threadId, messageId) =>
        set((s) => {
          const replyingTo = { ...s.replyingTo }
          if (messageId) replyingTo[threadId] = messageId
          else delete replyingTo[threadId]
          return { replyingTo }
        }),
      setEditing: (threadId, messageId) =>
        set((s) => {
          const editing = { ...s.editing }
          if (messageId) editing[threadId] = messageId
          else delete editing[threadId]
          return { editing }
        }),
      setChatSearch: (chatSearch) => set({ chatSearch }),
      focusComposer: () => set((s) => ({ composerFocusTick: s.composerFocusTick + 1 })),
      focusSearch: () => set((s) => ({ searchFocusTick: s.searchFocusTick + 1 })),
      setDraftsOpen: (draftsOpen) => set({ draftsOpen }),
      setSnoozeMenuOpen: (snoozeMenuOpen) => set({ snoozeMenuOpen }),
      setAiPanelOpen: (aiPanelOpen) => set({ aiPanelOpen }),
      setAiSheetOpen: (aiSheetOpen) => set({ aiSheetOpen }),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      flashMessage(messageId) {
        const tick = (get().flash?.tick ?? 0) + 1
        set({ flash: { messageId, tick } })
        // Clear it once the highlight has played, so reopening the chat doesn't jump again.
        setTimeout(() => {
          if (get().flash?.tick === tick) set({ flash: null })
        }, 2500)
      },
      openDialog: (dialog) => set({ dialog, sidebarOpen: false }),
      openSettings: (tab) => set((s) => ({ dialog: 'settings', sidebarOpen: false, settingsTab: tab ?? s.settingsTab })),
      setSettingsTab: (settingsTab) => set({ settingsTab }),
      dismissConnectHint: () => set({ connectHintDismissed: true }),
      closeDialog: () => set({ dialog: null }),
    }),
    {
      name: 'tidings.ui',
      version: 1,
      partialize: (s) => ({
        view: s.view,
        networks: s.networks,
        selectedThreadId: s.selectedThreadId,
        aiPanelOpen: s.aiPanelOpen,
        composer: s.composer,
        connectHintDismissed: s.connectHintDismissed,
      }),
    },
  ),
)
