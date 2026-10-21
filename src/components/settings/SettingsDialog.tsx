import { useMemo } from 'react'
import { HardDrive, Monitor, Moon, RotateCcw, Sparkles, Sun, X, Zap } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { NetworkDot } from '@/components/ui/NetworkDot'
import { Switch } from '@/components/ui/Switch'
import { cn } from '@/lib/cn'
import { NETWORK_ORDER, NETWORKS } from '@/lib/networks'
import { resetDemo, setThreadAiAccess, simulateIncoming, turnOffAi, turnOnAi } from '@/store/actions'
import { useAi } from '@/store/ai'
import { hasDemoControls, useInbox } from '@/store/inbox'
import { useSettings, type ThemePreference } from '@/store/settings'
import { useUi } from '@/store/ui'

export function SettingsDialog() {
  const open = useUi((s) => s.dialog === 'settings')
  const close = () => useUi.getState().closeDialog()
  return (
    <Modal open={open} onClose={close} label="Settings" className="max-w-xl">
      <SettingsBody close={close} />
    </Modal>
  )
}

const THEMES: { id: ThemePreference; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
]

function SectionTitle({ children }: { children: string }) {
  return <h3 className="text-[11px] font-semibold tracking-wider text-faint uppercase">{children}</h3>
}

function SettingsBody({ close }: { close(): void }) {
  const { theme, aiEnabled, aiThreadIds, setTheme, setThreadsAllowed } = useSettings(
    useShallow((s) => ({
      theme: s.theme,
      aiEnabled: s.aiEnabled,
      aiThreadIds: s.aiThreadIds,
      setTheme: s.setTheme,
      setThreadsAllowed: s.setThreadsAllowed,
    })),
  )
  const threads = useInbox((s) => s.threads)
  const list = useMemo(
    () =>
      NETWORK_ORDER.flatMap((n) =>
        Object.values(threads)
          .filter((t) => t.network === n)
          .sort((a, b) => a.title.localeCompare(b.title)),
      ),
    [threads],
  )
  const allIds = list.map((t) => t.id)
  const selected = list.filter((t) => aiThreadIds.includes(t.id)).length

  return (
    <div className="flex max-h-[88dvh] flex-col">
      <header className="flex items-center justify-between border-b border-line px-5 py-4">
        <h2 className="text-base font-semibold">Settings</h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close settings" onClick={close}>
          <X className="size-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-5 py-5">
        <section className="space-y-3">
          <SectionTitle>Privacy & AI</SectionTitle>
          <div className="flex gap-3 rounded-xl border border-line p-4">
            <HardDrive className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <div>
              <p className="text-sm font-medium">Chats stored on this device</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">
                Conversations are kept in this browser's local storage. Nothing is uploaded in this prototype.
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-line p-4">
            <div className="flex items-start gap-3">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-accent-ink" aria-hidden />
              <div className="flex-1">
                <p className="text-sm font-medium">Allow AI to read selected threads</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">
                  Priority, summaries, drafts, tasks and answers only run on the chats selected below. Turning this
                  off also clears AI results from this device.
                </p>
              </div>
              <Switch
                checked={aiEnabled}
                onChange={(on) => (on ? turnOnAi({ quiet: true }) : turnOffAi())}
                label="Allow AI to read selected threads"
              />
            </div>

            <div className={cn('mt-4 border-t border-line pt-3 transition-opacity', !aiEnabled && 'opacity-50')}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-muted">
                  Selected chats · {selected} of {list.length}
                </p>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" disabled={!aiEnabled} onClick={() => setThreadsAllowed(allIds, true)}>
                    Select all
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!aiEnabled}
                    onClick={() => {
                      setThreadsAllowed(allIds, false)
                      useAi.getState().forgetAll()
                    }}
                  >
                    Clear
                  </Button>
                </div>
              </div>
              <ul className="mt-2 max-h-64 space-y-0.5 overflow-y-auto pr-1">
                {list.map((t) => (
                  <li key={t.id}>
                    <label
                      className={cn(
                        'flex items-center gap-3 rounded-lg px-2 py-1.5',
                        aiEnabled ? 'cursor-pointer hover:bg-surface-2' : 'cursor-not-allowed',
                      )}
                    >
                      <input
                        type="checkbox"
                        className="size-4 accent-accent"
                        checked={aiThreadIds.includes(t.id)}
                        disabled={!aiEnabled}
                        onChange={(e) => setThreadAiAccess(t.id, e.target.checked)}
                      />
                      <Avatar name={t.title} seed={t.id} size="xs" group={t.kind === 'group'} />
                      <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-faint">
                        <NetworkDot network={t.network} /> {NETWORKS[t.network].name}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <SectionTitle>Appearance</SectionTitle>
          <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2">
            {THEMES.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={theme === id}
                onClick={() => setTheme(id)}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  theme === id
                    ? 'border-accent/40 bg-accent-soft font-medium text-accent-ink'
                    : 'border-line text-muted hover:border-line-strong hover:text-fg',
                )}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </button>
            ))}
          </div>
        </section>

        {hasDemoControls && (
          <section className="space-y-3">
            <SectionTitle>Demo</SectionTitle>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  close()
                  void simulateIncoming()
                }}
              >
                <Zap className="size-4" aria-hidden /> Simulate incoming message
              </Button>
              <Button
                onClick={() => {
                  if (window.confirm('Reset the demo? Conversations are regenerated and your replies and tasks are cleared.')) {
                    close()
                    void resetDemo()
                  }
                }}
              >
                <RotateCcw className="size-4" aria-hidden /> Reset demo data
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-muted">
              The inbox is mock data generated relative to now. Incoming messages show how the queue reacts live.
            </p>
          </section>
        )}
      </div>
    </div>
  )
}
