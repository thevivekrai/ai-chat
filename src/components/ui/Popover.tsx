import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { Check, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface TriggerProps {
  ref: Ref<HTMLButtonElement>
  onClick(): void
  'aria-haspopup': 'menu' | 'dialog'
  'aria-expanded': boolean
}

interface FloatingProps {
  renderTrigger(props: TriggerProps): ReactNode
  align?: 'start' | 'end'
  side?: 'top' | 'bottom'
  /** Controlled open state (optional). */
  open?: boolean
  onOpenChange?(open: boolean): void
  className?: string
  panelClassName?: string
}

/** Open/close plumbing shared by menus and popovers: outside click and Escape close it. */
function useFloating({ open: controlled, onOpenChange }: Pick<FloatingProps, 'open' | 'onOpenChange'>) {
  const [uncontrolled, setUncontrolled] = useState(false)
  const open = controlled ?? uncontrolled
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const setOpen = useCallback(
    (next: boolean) => {
      if (controlled === undefined) setUncontrolled(next)
      onOpenChange?.(next)
    },
    [controlled, onOpenChange],
  )

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    // Capture phase so Escape closes only this, not the drawer or pane behind it.
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, setOpen])

  return { open, setOpen, rootRef, triggerRef }
}

/**
 * Which side of `trigger` has room for a panel `height` tall, within whatever scrolls around it
 * (or the window): below if it fits there, otherwise whichever side has more.
 */
function sideWithRoom(trigger: HTMLElement, height: number): 'top' | 'bottom' {
  let area = trigger.parentElement
  while (area && !/(auto|scroll)/.test(getComputedStyle(area).overflowY)) area = area.parentElement
  const bounds = area?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight }
  const at = trigger.getBoundingClientRect()
  const below = bounds.bottom - at.bottom
  const above = at.top - bounds.top
  return below >= height || below >= above ? 'bottom' : 'top'
}

const panelPosition = (side: 'top' | 'bottom', align: 'start' | 'end') =>
  cn(
    'glass-thick glass-edge absolute z-50 animate-pop-in rounded-2xl shadow-pop',
    side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
    align === 'end' ? 'right-0' : 'left-0',
  )

export interface MenuItem {
  id: string
  label: string
  hint?: string
  icon?: LucideIcon
  /** Something that can't be undone, like deleting: shown in red. */
  danger?: boolean
  /** A choice that's on or off: shown with a tick, and leaves the menu open for the next one. */
  checked?: boolean
  onSelect(): void
}

/** Both kinds of row, for moving through the menu with the arrow keys. */
const MENU_ITEMS = '[role="menuitem"], [role="menuitemcheckbox"]'

export function Menu({
  items,
  title,
  renderTrigger,
  align = 'end',
  side = 'bottom',
  className,
  panelClassName,
  ...state
}: Omit<FloatingProps, 'side'> & {
  items: MenuItem[]
  title?: string
  /** 'auto' opens it whichever way there's room for it, measured as it opens. */
  side?: 'top' | 'bottom' | 'auto'
}) {
  const { open, setOpen, rootRef, triggerRef } = useFloating(state)
  const listRef = useRef<HTMLDivElement>(null)
  const [roomySide, setRoomySide] = useState<'top' | 'bottom'>('bottom')
  const toggle = () => {
    // Its height, from its rows: 36px each, a title's 28px and 8px of padding, plus the gap.
    if (!open && side === 'auto' && triggerRef.current) setRoomySide(sideWithRoom(triggerRef.current, items.length * 36 + (title ? 28 : 0) + 14))
    setOpen(!open)
  }

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLElement>(MENU_ITEMS)?.focus(),
    )
    return () => cancelAnimationFrame(frame)
  }, [open])

  const onKeyDown = (e: KeyboardEvent) => {
    const nodes = [...(listRef.current?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? [])]
    const index = nodes.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      nodes[(index + step + nodes.length) % nodes.length]?.focus()
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div ref={rootRef} className={cn('relative inline-flex', className)}>
      {renderTrigger({ ref: triggerRef, onClick: toggle, 'aria-haspopup': 'menu', 'aria-expanded': open })}
      {open && (
        <div
          ref={listRef}
          role="menu"
          aria-label={title}
          onKeyDown={onKeyDown}
          className={cn(panelPosition(side === 'auto' ? roomySide : side, align), 'min-w-60 p-1', panelClassName)}
        >
          {title && (
            <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wider text-faint uppercase">{title}</div>
          )}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              {...(item.checked === undefined ? {} : { 'aria-checked': item.checked })}
              onClick={() => {
                if (item.checked === undefined) setOpen(false)
                item.onSelect()
              }}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm outline-none hover:bg-surface-2 focus-visible:bg-surface-2',
                item.danger ? 'text-rose-600 dark:text-rose-400' : 'text-fg',
              )}
            >
              {item.icon && <item.icon className={cn('size-4', item.danger ? 'text-current' : 'text-muted')} aria-hidden />}
              <span className="flex-1">{item.label}</span>
              {item.hint && <span className="text-xs whitespace-nowrap text-faint">{item.hint}</span>}
              {item.checked !== undefined && (
                <Check className={cn('size-4 shrink-0', item.checked ? 'text-accent-ink' : 'invisible')} aria-hidden />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Popover({
  children,
  label,
  renderTrigger,
  align = 'end',
  side = 'bottom',
  className,
  panelClassName,
  ...state
}: FloatingProps & { children: ReactNode | ((close: () => void) => ReactNode); label: string }) {
  const { open, setOpen, rootRef, triggerRef } = useFloating(state)
  return (
    <div ref={rootRef} className={cn('relative inline-flex', className)}>
      {renderTrigger({ ref: triggerRef, onClick: () => setOpen(!open), 'aria-haspopup': 'dialog', 'aria-expanded': open })}
      {open && (
        <div role="dialog" aria-label={label} className={cn(panelPosition(side, align), 'w-80 p-4', panelClassName)}>
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  )
}
