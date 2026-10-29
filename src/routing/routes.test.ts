import { describe, expect, it } from 'vitest'
import { parse, pathOf, titleOf } from './routes'

const WA = 'wa:919812345678@s.whatsapp.net'

describe('the app’s URLs', () => {
  it('reads every section’s path', () => {
    expect(parse('/')).toMatchObject({ page: 'inbox', view: 'needs-reply', threadId: null, dialog: null })
    expect(parse('/chat')).toMatchObject({ view: 'all', threadId: null })
    expect(parse('/waiting')).toMatchObject({ view: 'waiting' })
    expect(parse('/scheduled')).toMatchObject({ view: 'scheduled' })
    expect(parse('/tasks')).toMatchObject({ view: 'tasks' })
    expect(parse('/starred')).toMatchObject({ view: 'starred' })
    expect(parse('/archive')).toMatchObject({ view: 'archived' })
    expect(parse('/search')).toMatchObject({ dialog: 'command' })
    expect(parse('/shortcuts')).toMatchObject({ dialog: 'shortcuts' })
    expect(parse('/demo')).toMatchObject({ demo: true })
    expect(parse('/login')).toMatchObject({ page: 'login' })
    expect(parse('/help')).toMatchObject({ page: 'help' })
    expect(parse('/terms')).toMatchObject({ page: 'terms' })
    expect(parse('/privacy')).toMatchObject({ page: 'privacy' })
  })

  it('carries a chat’s id, however odd it looks', () => {
    const path = pathOf({ view: 'all', threadId: WA, dialog: null, settingsTab: 'accounts', tag: null })
    expect(path).toBe(`/chat/${encodeURIComponent(WA)}`)
    expect(parse(path)).toMatchObject({ view: 'all', threadId: WA })
  })

  it('opens Settings at the tab the path names, and refuses one it doesn’t know', () => {
    expect(parse('/settings')).toMatchObject({ dialog: 'settings', settingsTab: 'accounts' })
    expect(parse('/settings/privacy')).toMatchObject({ dialog: 'settings', settingsTab: 'privacy' })
    expect(parse('/settings/nonsense')).toMatchObject({ page: 'not-found' })
  })

  it('shows one tag’s chats, and only tags that exist', () => {
    expect(parse('/tags/payment')).toMatchObject({ view: 'all', tag: 'payment' })
    expect(parse('/tags/made-up')).toMatchObject({ page: 'not-found' })
    expect(pathOf({ view: 'all', threadId: null, dialog: null, settingsTab: 'accounts', tag: 'payment' })).toBe('/tags/payment')
  })

  it('keeps where the user was headed through signing in', () => {
    expect(parse('/login', '?next=%2Ftasks')).toMatchObject({ page: 'login', next: '/tasks' })
  })

  it('writes the path for whatever is on screen', () => {
    const base = { threadId: null, dialog: null, settingsTab: 'accounts', tag: null } as const
    expect(pathOf({ ...base, view: 'needs-reply' })).toBe('/')
    expect(pathOf({ ...base, view: 'needs-reply', guest: true })).toBe('/demo')
    expect(pathOf({ ...base, view: 'tasks' })).toBe('/tasks')
    expect(pathOf({ ...base, view: 'archived' })).toBe('/archive')
    // A dialog is a page of its own, so Back closes it.
    expect(pathOf({ ...base, view: 'all', dialog: 'settings', settingsTab: 'ai' })).toBe('/settings/ai')
    expect(pathOf({ ...base, view: 'all', dialog: 'command' })).toBe('/search')
    expect(pathOf({ ...base, view: 'needs-reply', page: 'help' })).toBe('/help')
  })

  it('round-trips every list', () => {
    for (const view of ['needs-reply', 'all', 'waiting', 'scheduled', 'tasks', 'starred', 'archived'] as const) {
      const path = pathOf({ view, threadId: null, dialog: null, settingsTab: 'accounts', tag: null })
      expect(parse(path).view).toBe(view)
    }
  })

  it('treats an unknown path as not found, and ignores a trailing slash', () => {
    expect(parse('/nope')).toMatchObject({ page: 'not-found' })
    expect(parse('/tasks/')).toMatchObject({ view: 'tasks' })
  })

  it('names the tab and tells a crawler what the page is', () => {
    expect(titleOf(parse('/tasks')).title).toMatch(/^Tasks · /)
    expect(titleOf(parse('/'))).toMatchObject({ title: expect.stringContaining('Sytext') })
    expect(titleOf(parse(`/chat/${encodeURIComponent(WA)}`), { threadTitle: 'Ravi Kumar' }).title).toMatch(/^Ravi Kumar · /)
    expect(titleOf(parse('/privacy')).description).toMatch(/keeps/i)
  })
})
