import { useEffect } from 'react'
import { create } from 'zustand'
import { useInbox } from '@/store/inbox'
import { useSession } from '@/store/session'
import { useUi } from '@/store/ui'
import { parse, pathOf, SITE_PAGES, titleOf, type Page, type Route } from './routes'

/**
 * The address bar, kept in step with what's on screen.
 *
 * Every view the app can show has a path (see routes.ts). The URL is read once on start and
 * whenever the browser moves through history; the path is written whenever the view changes. So
 * Back and Forward work, a link to a chat opens that chat, and a reload stays where it was.
 */

interface RouterState {
  page: Page
  /** Where to go after signing in, from /login?next=… */
  next: string | null
  /** The path that wasn't a page, for the "not found" screen. */
  missing: string | null
  /**
   * What the address bar is about. A wide screen keeps the open chat beside the list, so both are
   * on screen at once: whichever the user moved to last is the one the URL names.
   */
  surface: 'list' | 'thread'
}

export const useRouter = create<RouterState>()(() => ({ page: 'inbox', next: null, missing: null, surface: 'list' }))

/** Goes to a path as a click on a link would, so Back comes back here. */
export function go(path: string, { replace = false } = {}) {
  if (typeof window === 'undefined') return
  // The site's own pages are the server's to serve.
  if (SITE_PAGES.includes(path.split(/[?#]/)[0]!)) return void window.location.assign(path)
  if (current() === path) return
  window.history[replace ? 'replaceState' : 'pushState']({}, '', path)
  applyLocation()
}

const current = () => (typeof window === 'undefined' ? '/' : `${window.location.pathname}${window.location.search}`)

/** Shows whatever the address bar says. */
function applyLocation() {
  if (typeof window === 'undefined') return
  const route = parse(window.location.pathname, window.location.search)
  const status = useSession.getState().status
  const path = window.location.pathname

  // Signed out, on a page that needs an account: the sign-in screen remembers where to come back to.
  if (route.page === 'inbox' && !route.demo && status === 'signed-out') {
    const next = path === '/' ? null : `${path}${window.location.search}`
    window.history.replaceState({}, '', next ? `/login?next=${encodeURIComponent(next)}` : '/login')
    useRouter.setState({ page: 'login', next, missing: null })
    return
  }
  // Signed in already: the sign-in screen has nothing to do, so carry on where they were headed.
  if (route.page === 'login' && (status === 'signed-in' || status === 'guest' || status === 'no-server')) {
    window.history.replaceState({}, '', route.next ?? '/')
    applyLocation()
    return
  }

  useRouter.setState({ page: route.page, next: route.next, missing: route.page === 'not-found' ? path : null })
  if (route.page !== 'inbox') return
  show(route)
}

/** Puts the inbox into the state the path describes. */
function show(route: Route) {
  const ui = useUi.getState()
  if (route.demo && useSession.getState().status === 'signed-out') useSession.getState().continueAsGuest()
  if (ui.view !== route.view) ui.setView(route.view)
  if ((ui.listTag ?? null) !== route.tag) ui.setListTag(route.tag)
  if ((ui.selectedThreadId ?? null) !== route.threadId) ui.selectThread(route.threadId)
  // Whichever pane the path names is the one the address bar keeps naming.
  ui.setNav(route.threadId ? 'thread' : 'list')
  if (route.dialog === 'settings') ui.openSettings(route.settingsTab ?? undefined)
  else if (route.dialog) ui.openDialog(route.dialog)
  else if (ui.dialog) ui.closeDialog()
}

/** Keeps the address bar and the open view in step, both ways. Called once, from the app root. */
export function useUrlSync() {
  const status = useSession((s) => s.status)
  const page = useRouter((s) => s.page)
  const view = useUi((s) => s.view)
  const threadId = useUi((s) => s.selectedThreadId)
  const dialog = useUi((s) => s.dialog)
  const settingsTab = useUi((s) => s.settingsTab)
  const tag = useUi((s) => s.listTag)
  const nav = useUi((s) => s.nav)
  const threadTitle = useInbox((s) => (threadId ? (s.threads[threadId]?.title ?? null) : null))

  // The browser moving through history, and the first look at the address bar.
  useEffect(() => {
    const onPop = () => applyLocation()
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    if (status !== 'checking') applyLocation()
  }, [status])

  // What's on screen, written to the address bar. `nav` says which pane the person moved to last,
  // so opening the chat that is already open still takes the address bar to it.
  useEffect(() => {
    if (status === 'checking') return
    useRouter.setState({ surface: nav.kind })
    const signedOut = status === 'signed-out'
    const path = pathOf({
      page: signedOut && page === 'inbox' ? 'login' : page,
      view,
      threadId: nav.kind === 'thread' ? threadId : null,
      dialog,
      settingsTab,
      tag,
      guest: status === 'guest',
    })
    if (path !== window.location.pathname) window.history.pushState({}, '', path)
  }, [status, page, view, threadId, dialog, settingsTab, tag, nav])

  // What the tab says, and what a crawler reads.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const route = parse(window.location.pathname, window.location.search)
    const { title, description } = titleOf(route, { threadTitle })
    document.title = title
    const meta = document.querySelector('meta[name="description"]')
    if (meta) meta.setAttribute('content', description)
  }, [status, page, view, threadId, dialog, settingsTab, tag, threadTitle, nav])
}
