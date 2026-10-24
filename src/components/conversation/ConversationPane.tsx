import { useEffect } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { MessagesSquare } from 'lucide-react'
import { AiPanel } from '@/components/ai-panel/AiPanel'
import { Kbd } from '@/components/ui/Kbd'
import { Panel } from '@/components/ui/Panel'
import { isMac, useBreakpoint } from '@/lib/media'
import { useAi } from '@/store/ai'
import { engineKey, useAiEngine } from '@/store/aiEngine'
import { settledLastMessageId, useInbox } from '@/store/inbox'
import { incognitoOn } from '@/store/privacy'
import { canAiReadThread, useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import { ChatSearchBar } from './ChatSearchBar'
import { Composer } from './Composer'
import { ConversationHeader } from './ConversationHeader'
import { DraftTray } from './DraftTray'
import { MessageList } from './MessageList'
import { PinnedBar } from './PinnedBar'
import { SummaryBar } from './SummaryBar'

export function ConversationPane() {
  const threadId = useUi((s) => s.selectedThreadId)
  const exists = useInbox((s) => !!threadId && !!s.threads[threadId])
  return (
    <Panel aria-label="Conversation">
      {threadId && exists ? <Conversation key={threadId} threadId={threadId} /> : <NothingOpen />}
    </Panel>
  )
}

function Conversation({ threadId }: { threadId: string }) {
  const allowed = useSettings((s) => canAiReadThread(s, threadId))
  const lastKey = useInbox((s) => settledLastMessageId(s.messages[threadId]))
  const engine = engineKey(useAiEngine())
  const unread = useInbox((s) => s.threads[threadId]?.unreadCount ?? 0)
  const draftsOpen = useUi((s) => s.draftsOpen)
  const aiPanelOpen = useUi((s) => s.aiPanelOpen)
  const aiSheetOpen = useUi((s) => s.aiSheetOpen)
  const mobileThreadOpen = useUi((s) => s.mobileThreadOpen)
  const wide = useBreakpoint('wide')
  const visible = useBreakpoint('md') || mobileThreadOpen

  // Opening a chat (or a new message arriving while it's open) marks it read: for them too, unless
  // Incognito mode is on. Otherwise it's left to the account's setting (another device may have
  // just turned Incognito on), never forced.
  useEffect(() => {
    if (visible && unread > 0) useInbox.getState().markRead(threadId, incognitoOn() ? { receipt: false } : undefined)
  }, [visible, unread, threadId])

  // Summary and tasks for the open chat, refreshed when it (or the AI) changes.
  useEffect(() => {
    if (!allowed) return
    useAi.getState().ensureSummary(threadId)
    useAi.getState().ensureTasks(threadId)
  }, [allowed, threadId, lastKey, engine])

  const closeSheet = () => useUi.getState().setAiSheetOpen(false)

  return (
    <div className="flex min-h-0 flex-1 animate-pane-in">
      {/* A size container, so parts like the drafts tray adapt to the column, not the window. */}
      <div className="@container flex min-w-0 flex-1 flex-col">
        <ConversationHeader threadId={threadId} />
        <ChatSearchBar threadId={threadId} />
        <PinnedBar threadId={threadId} />
        <SummaryBar threadId={threadId} />
        <MessageList threadId={threadId} />
        <AnimatePresence>{draftsOpen && <DraftTray threadId={threadId} />}</AnimatePresence>
        <Composer threadId={threadId} />
      </div>

      <AnimatePresence initial={false}>
        {wide && aiPanelOpen && (
          <motion.aside
            aria-label="AI assist"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 320, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            className="shrink-0 overflow-hidden border-l border-line"
          >
            <AiPanel threadId={threadId} className="w-80" onClose={() => useUi.getState().setAiPanelOpen(false)} />
          </motion.aside>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!wide && aiSheetOpen && (
          <div className="fixed inset-0 z-40 flex justify-end">
            <motion.div
              className="absolute inset-0 bg-[rgb(15_23_42/0.12)] backdrop-blur-[3px] dark:bg-black/45"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={closeSheet}
            />
            <motion.aside
              aria-label="AI assist"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', stiffness: 420, damping: 42 }}
              className="relative h-full w-full max-w-sm shadow-pop sm:overflow-hidden sm:rounded-l-3xl"
            >
              <AiPanel threadId={threadId} onClose={closeSheet} className="glass-thick" />
            </motion.aside>
          </div>
        )}
      </AnimatePresence>
    </div>
  )
}

function NothingOpen() {
  const mod = isMac ? '⌘' : 'Ctrl'
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center animate-fade-in">
      <div className="grid size-14 place-items-center rounded-2xl bg-surface-2 text-muted ring-1 ring-line">
        <MessagesSquare className="size-6" aria-hidden />
      </div>
      <h2 className="mt-4 text-[15px] font-semibold">No conversation open</h2>
      <p className="mt-1 max-w-72 text-sm leading-relaxed text-muted">
        Pick a chat from the list, or press <Kbd>J</Kbd> to start at the top.
      </p>
      <dl className="mt-6 grid grid-cols-[auto_auto] items-center gap-x-4 gap-y-2 text-left text-xs text-muted">
        {[
          [['J', 'K'], 'Next / previous chat'],
          [['R'], 'Draft replies'],
          [['E'], 'Mark done'],
          [[mod, 'K'], 'Search & ask'],
        ].map(([keys, label]) => (
          <div key={label as string} className="contents">
            <dt className="flex justify-end gap-1">
              {(keys as string[]).map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </dt>
            <dd>{label as string}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
