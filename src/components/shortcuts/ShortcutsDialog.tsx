import { X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Modal } from '@/components/ui/Modal'
import { isMac } from '@/lib/media'
import { useUi } from '@/store/ui'

const SHORTCUTS: { keys: string[][]; label: string }[] = [
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

export function ShortcutsDialog() {
  const open = useUi((s) => s.dialog === 'shortcuts')
  const close = () => useUi.getState().closeDialog()
  return (
    <Modal open={open} onClose={close} label="Keyboard shortcuts" className="max-w-md">
      <header className="flex items-center justify-between border-b border-line px-5 py-4">
        <h2 className="text-base font-semibold">Keyboard shortcuts</h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={close}>
          <X className="size-4" />
        </Button>
      </header>
      <dl className="divide-y divide-line px-5 py-2">
        {SHORTCUTS.map(({ keys, label }) => (
          <div key={label} className="flex items-center justify-between gap-4 py-2.5">
            <dt className="text-sm text-muted">{label}</dt>
            <dd className="flex shrink-0 items-center gap-1.5">
              {keys.map((combo, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <span className="text-xs text-faint">/</span>}
                  {combo.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
