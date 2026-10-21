import { useEffect } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import { useToasts, type Toast } from '@/store/toasts'

const DISMISS_AFTER_MS = 5000

export function Toaster() {
  const toasts = useToasts((s) => s.toasts)
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:items-start md:p-5"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </AnimatePresence>
    </div>
  )
}

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = () => useToasts.getState().dismiss(toast.id)

  useEffect(() => {
    const timer = setTimeout(() => useToasts.getState().dismiss(toast.id), DISMISS_AFTER_MS)
    return () => clearTimeout(timer)
  }, [toast.id])

  return (
    <motion.div
      layout
      role="status"
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.15 } }}
      transition={{ type: 'spring', stiffness: 500, damping: 38 }}
      className="pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-xl bg-fg py-3 pr-3 pl-4 text-surface shadow-pop"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{toast.title}</p>
        {toast.description && <p className="mt-0.5 line-clamp-2 text-[13px] opacity-70">{toast.description}</p>}
      </div>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.run()
            dismiss()
          }}
          className="shrink-0 rounded-md px-2 py-1 text-sm font-semibold text-[#b9baff] hover:bg-white/10 dark:text-[#4343b6] dark:hover:bg-black/5"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="shrink-0 rounded-md p-1 opacity-60 hover:opacity-100"
      >
        <X className="size-4" />
      </button>
    </motion.div>
  )
}
