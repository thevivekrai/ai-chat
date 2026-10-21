import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import type { LucideIcon } from 'lucide-react'
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
  onSelect(): void
}

export function Menu({
  items,
  title,
  renderTrigger,
  align = 'end',
  side = 'bottom',
  className,
  panelClassName,
  ...state
}: FloatingProps & { items: MenuItem[]; title?: string }) {
  const { open, setOpen, rootRef, triggerRef } = useFloating(state)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(),
    )
    return () => cancelAnimationFrame(frame)
  }, [open])

  const onKeyDown = (e: KeyboardEvent) => {
    const nodes = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
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
      {renderTrigger({ ref: triggerRef, onClick: () => setOpen(!open), 'aria-haspopup': 'menu', 'aria-expanded': open })}
      {open && (
        <div
          ref={listRef}
          role="menu"
          aria-label={title}
          onKeyDown={onKeyDown}
          className={cn(panelPosition(side, align), 'min-w-60 p-1', panelClassName)}
        >
          {title && (
            <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wider text-faint uppercase">{title}</div>
          )}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-fg outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
            >
              {item.icon && <item.icon className="size-4 text-muted" aria-hidden />}
              <span className="flex-1">{item.label}</span>
              {item.hint && <span className="text-xs whitespace-nowrap text-faint">{item.hint}</span>}
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
