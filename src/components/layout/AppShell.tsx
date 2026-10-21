import { ConversationPane } from '@/components/conversation/ConversationPane'
import { ScheduledView } from '@/components/scheduled/ScheduledView'
import { TasksView } from '@/components/tasks/TasksView'
import { ThreadListPane } from '@/components/threads/ThreadListPane'
import { cn } from '@/lib/cn'
import { useUi } from '@/store/ui'
import { Header } from './Header'
import { MobileNavDrawer } from './MobileNavDrawer'
import { Sidebar } from './Sidebar'
import { Wallpaper } from './Wallpaper'

/**
 * Desktop: sidebar · list · conversation (+ AI panel when wide). Below `lg` the sidebar becomes a
 * drawer, and on phones the list and the conversation take turns filling the screen.
 */
export function AppShell() {
  const view = useUi((s) => s.view)
  const threadOpen = useUi((s) => s.mobileThreadOpen)

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <Wallpaper />
      <div className={cn(threadOpen && 'max-md:hidden')}>
        <Header />
      </div>
      <div className="flex min-h-0 flex-1 gap-3 md:px-3 md:pb-3">
        <aside className="glass glass-edge relative hidden w-56 shrink-0 rounded-3xl px-2 pt-2 pb-3 shadow-glass lg:flex xl:w-60">
          <Sidebar />
        </aside>
        <main className={cn('flex min-h-0 w-full flex-col md:w-80 md:shrink-0 xl:w-[360px]', threadOpen && 'max-md:hidden')}>
          {view === 'tasks' ? <TasksView /> : view === 'scheduled' ? <ScheduledView /> : <ThreadListPane view={view} />}
        </main>
        <div className={cn('min-h-0 min-w-0 flex-1 flex-col', threadOpen ? 'flex' : 'hidden md:flex')}>
          <ConversationPane />
        </div>
      </div>
      <MobileNavDrawer />
    </div>
  )
}
