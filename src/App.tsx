import { useEffect } from 'react'
import { MotionConfig } from 'motion/react'
import { AuthScreen } from '@/components/auth/AuthScreen'
import { RecoveryKeyDialog } from '@/components/auth/RecoveryKeyDialog'
import { CommandBar } from '@/components/command/CommandBar'
import { AppShell } from '@/components/layout/AppShell'
import { LogoMark } from '@/components/layout/LogoMark'
import { Wallpaper } from '@/components/layout/Wallpaper'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { ShortcutsDialog } from '@/components/shortcuts/ShortcutsDialog'
import { Toaster } from '@/components/ui/Toaster'
import { useAiAutopilot } from '@/hooks/useAiAutopilot'
import { useApplyTheme } from '@/hooks/useApplyTheme'
import { useGlobalShortcuts } from '@/hooks/useGlobalShortcuts'
import { watchAiProblems, watchSession } from '@/store/actions'
import { startClock } from '@/store/clock'
import { useInbox } from '@/store/inbox'
import { useSession } from '@/store/session'

export function App() {
  const status = useSession((s) => s.status)
  useEffect(() => void useSession.getState().init(), [])
  useEffect(() => watchSession(), [])
  useEffect(() => startClock(), [])
  useEffect(() => watchAiProblems(), [])
  useApplyTheme()

  return (
    <MotionConfig reducedMotion="user">
      {status === 'checking' ? <Splash /> : status === 'signed-out' ? <AuthScreen /> : <Inbox />}
      <RecoveryKeyDialog />
      <Toaster />
    </MotionConfig>
  )
}

function Inbox() {
  useEffect(() => useInbox.getState().connect(), [])
  useAiAutopilot()
  useGlobalShortcuts()

  return (
    <>
      <AppShell />
      <CommandBar />
      <SettingsDialog />
      <ShortcutsDialog />
    </>
  )
}

function Splash() {
  return (
    <div className="grid h-dvh place-items-center">
      <Wallpaper />
      <LogoMark className="relative size-12 animate-pulse" />
    </div>
  )
}
