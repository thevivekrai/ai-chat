import { useEffect } from 'react'
import { isTypingTarget } from '@/lib/dom'
import { markDone, toggleAiPanel, toggleDrafts } from '@/store/actions'
import { useInbox } from '@/store/inbox'
import { useUi } from '@/store/ui'

/**
 * App-wide keys: J/K move through the list, R drafts replies, E marks done, S snoozes, A toggles the
 * AI panel, Enter replies, / filters the list, ? shows help, Cmd/Ctrl+K opens search.
 */
export function useGlobalShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const ui = useUi.getState()

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (ui.dialog === 'command') ui.closeDialog()
        else ui.openDialog('command')
        return
      }
      // Dialogs and menus handle their own keys.
      if (e.defaultPrevented || e.isComposing || ui.dialog) return

      if (e.key === 'Escape') {
        if (ui.draftsOpen) ui.setDraftsOpen(false)
        else if (ui.aiSheetOpen) ui.setAiSheetOpen(false)
        else if (ui.sidebarOpen) ui.setSidebarOpen(false)
        else if (isTypingTarget(e.target)) (e.target as HTMLElement).blur()
        else if (ui.mobileThreadOpen) ui.closeMobileThread()
        return
      }
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return

      const threadId = ui.selectedThreadId && useInbox.getState().threads[ui.selectedThreadId] ? ui.selectedThreadId : null
      const target = e.target as HTMLElement
      const run = (action: () => void) => {
        e.preventDefault()
        action()
      }
      // If a list row has keyboard focus, keep focus on the row that becomes selected.
      const move = (delta: 1 | -1) => {
        ui.moveSelection(delta)
        if (!target.closest('[data-thread-row]')) return
        const next = useUi.getState().selectedThreadId
        requestAnimationFrame(() =>
          document.querySelector<HTMLElement>(`[data-thread-row="${CSS.escape(next ?? '')}"]`)?.focus(),
        )
      }

      switch (e.key) {
        case 'j':
        case 'J':
          return run(() => move(1))
        case 'k':
        case 'K':
          return run(() => move(-1))
        case '/':
          return run(() => ui.focusSearch())
        case '?':
          return run(() => ui.openDialog('shortcuts'))
      }
      if (!threadId) return
      switch (e.key) {
        case 'r':
        case 'R':
          return run(() => toggleDrafts(threadId))
        case 'e':
        case 'E':
          return run(() => void markDone(threadId))
        case 's':
        case 'S':
          return run(() => ui.setSnoozeMenuOpen(true))
        case 'a':
        case 'A':
          return run(toggleAiPanel)
        case 'Enter':
          // Enter on a chat row (or the page) replies; on any other control it keeps its usual meaning.
          if (!target.closest('[data-thread-row]') && target.closest('button, a, [role="menuitem"]')) return
          return run(() => ui.focusComposer())
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
