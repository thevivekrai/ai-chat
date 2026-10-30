import { CHAT_LABELS, type ChatLabel } from '@/ai'
import type { Dialog, SettingsTab, View } from '@/store/ui'

/**
 * The app's URLs.
 *
 * Every section has one, so a page can be bookmarked, shared, reloaded and walked back through.
 * The app is a single page over a store, so this is the translation both ways: a path becomes the
 * state that shows that view, and the state becomes the path that is in the address bar.
 */

/** A page that isn't the inbox: its own screen, signed in or not. */
export type Page = 'inbox' | 'login' | 'not-found'

/**
 * Pages the server serves itself (public/info, terms, privacy, help): the app doesn't draw these,
 * it goes to them as a link would, so there is one Terms page and it's the site's own.
 */
export const SITE_PAGES = ['/info', '/terms', '/privacy', '/help']

export interface Route {
  page: Page
  view: View
  /** The open conversation, if the path names one. */
  threadId: string | null
  dialog: Dialog | null
  settingsTab: SettingsTab | null
  /** Showing one tag's chats. */
  tag: ChatLabel | null
  /** Where to go after signing in (from ?next=). */
  next: string | null
  /** Enter the demo as a guest. */
  demo: boolean
}

const EMPTY: Route = { page: 'inbox', view: 'needs-reply', threadId: null, dialog: null, settingsTab: null, tag: null, next: null, demo: false }

/** Lists that have a path of their own. The inbox itself is the root. */
const LIST_PATHS: Record<Exclude<View, 'needs-reply' | 'all'>, string> = {
  waiting: '/waiting',
  scheduled: '/scheduled',
  tasks: '/tasks',
  starred: '/starred',
  archived: '/archive',
}
const VIEW_OF_PATH = Object.fromEntries(Object.entries(LIST_PATHS).map(([view, path]) => [path, view as View]))

const SETTINGS_TABS: SettingsTab[] = ['profile', 'accounts', 'ai', 'privacy', 'appearance']

/** The public pages, which show the same whether or not anyone is signed in. */
export const PUBLIC_PAGES: Page[] = ['login', 'not-found']

/** Reads a path (and its query) as the state that shows it. */
export function parse(pathname: string, search = ''): Route {
  const path = pathname.replace(/\/+$/, '') || '/'
  const next = new URLSearchParams(search).get('next')
  const route = { ...EMPTY, ...(next ? { next } : {}) }

  if (path === '/') return route
  if (path === '/login') return { ...route, page: 'login' }
  if (path === '/demo') return { ...route, demo: true }
  if (path === '/search') return { ...route, dialog: 'command' }
  if (path === '/shortcuts') return { ...route, dialog: 'shortcuts' }
  if (path === '/chat') return { ...route, view: 'all' }

  if (path.startsWith('/chat/')) {
    const threadId = decodeURIComponent(path.slice('/chat/'.length))
    return threadId ? { ...route, view: 'all', threadId } : { ...route, view: 'all' }
  }

  if (path === '/settings') return { ...route, dialog: 'settings', settingsTab: 'accounts' }
  if (path.startsWith('/settings/')) {
    const tab = path.slice('/settings/'.length) as SettingsTab
    if (SETTINGS_TABS.includes(tab)) return { ...route, dialog: 'settings', settingsTab: tab }
    return { ...route, page: 'not-found' }
  }

  if (path === '/tags') return { ...route, view: 'all' }
  if (path.startsWith('/tags/')) {
    const tag = decodeURIComponent(path.slice('/tags/'.length)) as ChatLabel
    if (CHAT_LABELS.includes(tag)) return { ...route, view: 'all', tag }
    return { ...route, page: 'not-found' }
  }

  const view = VIEW_OF_PATH[path]
  if (view) return { ...route, view }
  return { ...route, page: 'not-found' }
}

/** The path for what's on screen: the other way round from `parse`. */
export function pathOf(state: {
  page?: Page
  view: View
  threadId: string | null
  dialog: Dialog | null
  settingsTab: SettingsTab
  tag: ChatLabel | null
  guest?: boolean
}): string {
  if (state.page && state.page !== 'inbox') return state.page === 'not-found' ? '/404' : `/${state.page}`
  if (state.dialog === 'settings') return `/settings/${state.settingsTab}`
  if (state.dialog === 'command') return '/search'
  if (state.dialog === 'shortcuts') return '/shortcuts'
  if (state.threadId) return `/chat/${encodeURIComponent(state.threadId)}`
  if (state.view === 'all') return state.tag ? `/tags/${state.tag}` : '/chat'
  if (state.view === 'needs-reply') return state.guest ? '/demo' : '/'
  return LIST_PATHS[state.view]
}

/** What the tab says, and what a search engine is told, for each page. */
export function titleOf(route: Route, context: { threadTitle?: string | null } = {}): { title: string; description: string } {
  const app = 'Sytext'
  const named = (title: string, description: string) => ({ title: `${title} · ${app}`, description })
  switch (route.page) {
    case 'login':
      return named('Sign in', 'Sign in to Sytext to bring your own chats into one inbox.')
    case 'not-found':
      return { title: '404: Skill Issue — Sytext', description: 'That page does not exist.' }
    default:
      break
  }
  if (route.threadId) return named(context.threadTitle || 'Chat', 'A conversation in your Sytext inbox.')
  if (route.dialog === 'settings') return named('Settings', 'Your accounts, AI, privacy and appearance.')
  if (route.dialog === 'command') return named('Search', 'Search across every chat, or ask the AI.')
  if (route.dialog === 'shortcuts') return named('Keyboard shortcuts', 'Every shortcut in Sytext.')
  if (route.tag) return named(`Tagged ${route.tag}`, `Chats tagged ${route.tag}.`)
  switch (route.view) {
    case 'all':
      return named('All chats', 'Every chat from your linked accounts, in one place.')
    case 'waiting':
      return named('Waiting on them', "Chats where you asked and they haven't answered.")
    case 'scheduled':
      return named('Scheduled', 'Messages waiting to be sent.')
    case 'tasks':
      return named('Tasks', 'What your chats asked you to do.')
    case 'starred':
      return named('Starred', 'Messages you kept.')
    case 'archived':
      return named('Archived', 'Chats you put away.')
    default:
      return { title: `${app} · one inbox for every chat`, description: 'WhatsApp, Telegram and more in one inbox, with AI that sorts what needs a reply.' }
  }
}
