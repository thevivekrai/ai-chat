import { isMac } from '@/lib/media'

/** Every keyboard shortcut, shown both in the dialog and on /help. */
export const SHORTCUTS: { keys: string[][]; label: string }[] = [
  { keys: [['J'], ['K']], label: 'Next / previous chat' },
  { keys: [['Enter']], label: 'Reply (focus the composer)' },
  { keys: [['R']], label: 'Draft replies' },
  { keys: [['1'], ['2'], ['3']], label: 'Use a suggested draft' },
  { keys: [['Tab']], label: 'Jump to the next [blank] in a draft' },
  { keys: [['E']], label: 'Mark done' },
  { keys: [['S']], label: 'Snooze' },
  { keys: [['A']], label: 'Toggle the AI panel' },
  { keys: [[isMac ? '⌘' : 'Ctrl', 'K']], label: 'Search and ask across all chats' },
  { keys: [['/']], label: 'Filter the chat list' },
  { keys: [['Esc']], label: 'Close / go back' },
  { keys: [['?']], label: 'Show this list' },
]
