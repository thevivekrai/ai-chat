import { motion } from 'motion/react'
import { Monitor, Moon, Sun, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { cn } from '@/lib/cn'
import { recoveryKeyWaiting, useSession } from '@/store/session'
import { useSettings, type ThemePreference } from '@/store/settings'
import { useUi, type SettingsTab } from '@/store/ui'
import { AccountsTab } from './AccountsTab'
import { AiTab } from './AiTab'
import { SectionTitle } from './parts'
import { PrivacyTab } from './PrivacyTab'
import { ProfileTab } from './ProfileTab'

export function SettingsDialog() {
  const keyWaiting = useSession(recoveryKeyWaiting)
  const open = useUi((s) => s.dialog === 'settings') && !keyWaiting
  const close = () => useUi.getState().closeDialog()
  return (
    <Modal open={open} onClose={close} label="Settings" className="max-w-xl">
      <SettingsBody close={close} />
    </Modal>
  )
}

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'ai', label: 'AI' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'appearance', label: 'Appearance' },
]

function SettingsBody({ close }: { close(): void }) {
  const signedIn = useSession((s) => s.status === 'signed-in')
  const tabs = signedIn ? TABS : TABS.filter((t) => t.id !== 'profile')
  const chosen = useUi((s) => s.settingsTab)
  const tab = !signedIn && chosen === 'profile' ? 'accounts' : chosen
  const setTab = useUi((s) => s.setSettingsTab)

  return (
    <div className="flex max-h-[88dvh] flex-col">
      <header className="space-y-4 border-b border-line px-5 pt-4 pb-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Settings</h2>
          <Button variant="ghost" size="icon-sm" aria-label="Close settings" onClick={close}>
            <X className="size-4" />
          </Button>
        </div>
        {/* On a phone the tabs scroll sideways rather than squeezing (or widening the sheet). */}
        <div
          role="tablist"
          aria-label="Settings sections"
          className="flex gap-1 overflow-x-auto rounded-2xl bg-surface-2 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                'relative isolate flex-1 shrink-0 rounded-xl px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                tab === id ? 'text-fg' : 'text-muted hover:text-fg',
              )}
            >
              {tab === id && (
                <motion.span
                  layoutId="settings-tab"
                  aria-hidden
                  className="absolute inset-0 -z-10 rounded-xl bg-pill shadow-pill"
                  transition={{ type: 'spring', stiffness: 520, damping: 40 }}
                />
              )}
              {label}
            </button>
          ))}
        </div>
      </header>

      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {tab === 'profile' ? (
          <ProfileTab />
        ) : tab === 'accounts' ? (
          <AccountsTab close={close} />
        ) : tab === 'ai' ? (
          <AiTab />
        ) : tab === 'privacy' ? (
          <PrivacyTab />
        ) : (
          <AppearanceTab />
        )}
      </div>
    </div>
  )
}

const THEMES: { id: ThemePreference; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
]

function AppearanceTab() {
  const theme = useSettings((s) => s.theme)
  const setTheme = useSettings((s) => s.setTheme)
  return (
    <section className="space-y-3">
      <SectionTitle>Theme</SectionTitle>
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2">
        {THEMES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={theme === id}
            onClick={() => setTheme(id)}
            className={cn(
              'flex flex-col items-center gap-1.5 rounded-2xl border px-3 py-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
              theme === id
                ? 'border-accent/40 bg-accent-soft font-medium text-accent-ink'
                : 'border-line bg-surface text-muted hover:border-line-strong hover:text-fg',
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        ))}
      </div>
    </section>
  )
}
