import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useUi } from '@/store/ui'
import { Logo } from './LogoMark'
import { Sidebar } from './Sidebar'

/** The sidebar as a slide-over on screens without room for it. Picking a view closes it. */
export function MobileNavDrawer() {
  const open = useUi((s) => s.sidebarOpen)
  const close = () => useUi.getState().setSidebarOpen(false)

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <motion.div
            className="absolute inset-0 bg-[rgb(20_22_60/0.18)] backdrop-blur-[3px] dark:bg-black/45"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
          />
          <motion.div
            role="dialog"
            aria-label="Navigation"
            className="glass-thick absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col rounded-r-3xl px-3 pb-4 shadow-pop"
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ type: 'spring', stiffness: 420, damping: 40 }}
          >
            <div className="flex h-14 items-center justify-between pl-1">
              <Logo />
              <Button variant="ghost" size="icon" aria-label="Close navigation" onClick={close}>
                <X className="size-5" />
              </Button>
            </div>
            <Sidebar />
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
