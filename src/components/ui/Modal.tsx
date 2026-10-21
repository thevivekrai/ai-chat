import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface ModalProps {
  open: boolean
  onClose(): void
  label: string
  children: ReactNode
  className?: string
  placement?: 'center' | 'top'
}

/**
 * Built on the native <dialog>: focus trapping, Escape, the backdrop and inert background come
 * from the browser.
 */
export function Modal({ open, onClose, label, children, className, placement = 'center' }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onMouseDown={(e) => {
        // A press on the dialog element itself (not its content) is a press on the backdrop.
        if (e.target === e.currentTarget) onClose()
      }}
      className={cn(
        'w-[calc(100%-1.5rem)] max-w-lg overflow-hidden rounded-2xl border border-line bg-surface p-0 text-fg shadow-pop open:animate-dialog-in',
        placement === 'top' ? 'mx-auto mt-[9vh] mb-auto max-h-[80dvh]' : 'm-auto max-h-[88dvh]',
        className,
      )}
    >
      {open && children}
    </dialog>
  )
}
