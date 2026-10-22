import type { ReactNode } from 'react'
import {
  HardDrive,
  Link2,
  LogIn,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Menu, Popover } from '@/components/ui/Popover'
import { isMac } from '@/lib/media'
import { signOut } from '@/store/actions'
import { useConnections } from '@/store/connections'
import { useInbox } from '@/store/inbox'
import { useSession } from '@/store/session'
import { usesClaude, useSettings, type ThemePreference } from '@/store/settings'
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
          className="glass glass-edge relative hidden h-10 w-full max-w-md items-center gap-2.5 rounded-full px-4 text-sm text-muted shadow-glass transition-colors hover:text-fg md:flex"
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
      <AccountButton />
    </header>
  )
}

/** The signed-in user's menu; in guest mode, a way to sign in. */
function AccountButton() {
  const status = useSession((s) => s.status)
  const user = useSession((s) => s.user)

  if (status === 'guest') {
    return (
      <Button variant="primary" size="sm" className="ml-0.5" onClick={() => useSession.getState().showSignIn()}>
        <LogIn className="size-3.5" aria-hidden /> Sign in
      </Button>
    )
  }
  if (status !== 'signed-in' || !user) return null

  const go = (close: () => void, tab: 'profile' | 'accounts') => {
    close()
    useUi.getState().openSettings(tab)
  }
  return (
    <Popover
      label="Account"
      panelClassName="w-72 p-2"
      renderTrigger={(props) => (
        <button
          {...props}
          type="button"
          aria-label={`Account: ${user.name}`}
          className="ml-0.5 shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Avatar name={user.name} seed={user.id} imageUrl={user.avatarUrl} size="sm" />
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="flex items-center gap-3 px-2.5 pt-2 pb-3">
            <Avatar name={user.name} seed={user.id} imageUrl={user.avatarUrl} />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-xs text-muted">{user.email}</p>
            </div>
          </div>
          <div className="border-t border-line pt-1.5">
            <MenuButton icon={UserRound} onClick={() => go(close, 'profile')}>
              Profile
            </MenuButton>
            <MenuButton icon={Link2} onClick={() => go(close, 'accounts')}>
              WhatsApp and Telegram
            </MenuButton>
            <MenuButton
              icon={LogOut}
              onClick={() => {
                close()
                void signOut()
              }}
            >
              Sign out
            </MenuButton>
          </div>
        </div>
      )}
    </Popover>
  )
}

function MenuButton({ icon: Icon, onClick, children }: { icon: LucideIcon; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-fg outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
    >
      <Icon className="size-4 text-muted" aria-hidden /> {children}
    </button>
  )
}

function PrivacyBadge() {
  const { aiEnabled, aiThreadIds, claude } = useSettings(
    useShallow((s) => ({ aiEnabled: s.aiEnabled, aiThreadIds: s.aiThreadIds, claude: usesClaude(s) })),
  )
  const total = useInbox((s) => Object.keys(s.threads).length)
  // Chats linked on the server are stored there (encrypted), not only in this browser.
  const linked = useConnections((s) => !!(s.server?.whatsapp || s.server?.telegram))

  return (
    <Popover
      label="Privacy"
      renderTrigger={(props) => (
        <button
          {...props}
          type="button"
          className="glass glass-edge relative inline-flex size-8 shrink-0 items-center justify-center gap-1.5 rounded-full text-xs font-medium text-muted shadow-glass transition-colors hover:text-fg sm:w-auto sm:px-3"
        >
          <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
          {/* Phones show just the shield; the panel explains. */}
          <span className="sr-only sm:not-sr-only">{linked ? 'Encrypted at rest' : 'Chats stored on this device'}</span>
        </button>
      )}
    >
      {(close) => (
        <div className="space-y-3.5 text-[13px] leading-relaxed">
          {linked ? (
            <div>
              <p className="flex items-center gap-2 text-sm font-medium text-fg">
                <Server className="size-4 text-muted" aria-hidden /> Linked chats are encrypted at rest
              </p>
              <p className="mt-1 text-muted">
                Your WhatsApp and Telegram chats sync through the Tidings server, which stores them encrypted, so they're
                on every device you sign in on. Unlinking deletes them there.
              </p>
            </div>
          ) : (
            <div>
              <p className="flex items-center gap-2 text-sm font-medium text-fg">
                <HardDrive className="size-4 text-muted" aria-hidden /> Chats stay on this device
              </p>
              <p className="mt-1 text-muted">
                Conversations are kept in this browser. Connected accounts talk to their networks directly from here;
                there is no Tidings server in between.
              </p>
            </div>
          )}
          <div>
            <p className="flex items-center gap-2 text-sm font-medium text-fg">
              <Sparkles className="size-4 text-accent-ink" aria-hidden />
              {aiEnabled ? `AI can read ${aiThreadIds.length} of ${total} chats` : 'AI is off'}
            </p>
            <p className="mt-1 text-muted">
              AI only reads the chats you select, and only when a feature needs it.{' '}
              {claude
                ? 'They are sent to Claude with your API key.'
                : 'The built-in demo AI runs on this device.'}
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              close()
              useUi.getState().openSettings('ai')
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
        // Phones have little room up here; the theme is in Settings → Appearance too.
        <Button {...props} variant="ghost" size="icon" aria-label="Theme" className="max-sm:hidden">
          <Icon className="size-[18px]" />
        </Button>
      )}
    />
  )
}
