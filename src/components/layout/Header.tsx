import { HardDrive, Menu as MenuIcon, Monitor, Moon, Search, Settings, ShieldCheck, Sparkles, Sun } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Menu, Popover } from '@/components/ui/Popover'
import { isMac } from '@/lib/media'
import { useInbox } from '@/store/inbox'
import { useSettings, type ThemePreference } from '@/store/settings'
import { useUi } from '@/store/ui'
import { Logo } from './LogoMark'

export function Header() {
  const openDialog = useUi((s) => s.openDialog)
  const setSidebarOpen = useUi((s) => s.setSidebarOpen)

  return (
    <header className="flex h-14 shrink-0 items-center gap-1.5 px-2 md:gap-2 md:px-4">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        aria-label="Open navigation"
        onClick={() => setSidebarOpen(true)}
      >
        <MenuIcon className="size-5" />
      </Button>
      <Logo />

      <div className="flex min-w-0 flex-1 justify-center px-2">
        <button
          type="button"
          onClick={() => openDialog('command')}
          className="hidden h-9 w-full max-w-md items-center gap-2.5 rounded-xl border border-line bg-surface px-3 text-sm text-faint shadow-xs transition-colors hover:border-line-strong hover:text-muted md:flex"
        >
          <Search className="size-4" aria-hidden />
          <span className="flex-1 truncate text-left">Search or ask across all chats…</span>
          <Kbd>{isMac ? '⌘' : 'Ctrl'} K</Kbd>
        </button>
      </div>

      <Button variant="ghost" size="icon" className="md:hidden" aria-label="Search" onClick={() => openDialog('command')}>
        <Search className="size-5" />
      </Button>
      <PrivacyBadge />
      <ThemeMenu />
      <Button variant="ghost" size="icon" aria-label="Settings" onClick={() => openDialog('settings')}>
        <Settings className="size-[18px]" />
      </Button>
    </header>
  )
}

function PrivacyBadge() {
  const { aiEnabled, aiThreadIds } = useSettings(useShallow((s) => ({ aiEnabled: s.aiEnabled, aiThreadIds: s.aiThreadIds })))
  const total = useInbox((s) => Object.keys(s.threads).length)
  const openDialog = useUi((s) => s.openDialog)

  return (
    <Popover
      label="Privacy"
      renderTrigger={(props) => (
        <button
          {...props}
          type="button"
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-xs font-medium text-muted shadow-xs transition-colors hover:text-fg sm:px-3"
        >
          <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
          <span className="hidden sm:inline">Chats stored on this device</span>
          <span className="sm:hidden">On device</span>
        </button>
      )}
    >
      {(close) => (
        <div className="space-y-3.5 text-[13px] leading-relaxed">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium text-fg">
              <HardDrive className="size-4 text-muted" aria-hidden /> Chats stay on this device
            </p>
            <p className="mt-1 text-muted">
              Conversations are kept in this browser's local storage. Nothing is uploaded in this prototype.
            </p>
          </div>
          <div>
            <p className="flex items-center gap-2 text-sm font-medium text-fg">
              <Sparkles className="size-4 text-accent-ink" aria-hidden />
              {aiEnabled ? `AI can read ${aiThreadIds.length} of ${total} chats` : 'AI is off'}
            </p>
            <p className="mt-1 text-muted">
              AI only reads the chats you select, and only when a feature needs it.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              close()
              openDialog('settings')
            }}
          >
            Privacy settings
          </Button>
        </div>
      )}
    </Popover>
  )
}

const THEME_ICON: Record<ThemePreference, typeof Sun> = { light: Sun, dark: Moon, system: Monitor }

function ThemeMenu() {
  const theme = useSettings((s) => s.theme)
  const setTheme = useSettings((s) => s.setTheme)
  const Icon = THEME_ICON[theme]
  return (
    <Menu
      title="Theme"
      panelClassName="min-w-44"
      items={(['light', 'dark', 'system'] as const).map((t) => ({
        id: t,
        label: t === 'system' ? 'Match system' : t === 'light' ? 'Light' : 'Dark',
        icon: THEME_ICON[t],
        hint: theme === t ? '✓' : undefined,
        onSelect: () => setTheme(t),
      }))}
      renderTrigger={(props) => (
        <Button {...props} variant="ghost" size="icon" aria-label="Theme">
          <Icon className="size-[18px]" />
        </Button>
      )}
    />
  )
}
