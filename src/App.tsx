import { useEffect } from 'react'
import { MotionConfig } from 'motion/react'
import { AuthScreen } from '@/components/auth/AuthScreen'
import { RecoveryKeyDialog } from '@/components/auth/RecoveryKeyDialog'
import { CommandBar } from '@/components/command/CommandBar'
import { AppShell } from '@/components/layout/AppShell'
import { LogoMark } from '@/components/layout/LogoMark'
import { Wallpaper } from '@/components/layout/Wallpaper'
import { HelpPage } from '@/components/pages/HelpPage'
import { PrivacyPage, TermsPage } from '@/components/pages/LegalPages'
import { NotFoundPage } from '@/components/pages/NotFoundPage'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { ShortcutsDialog } from '@/components/shortcuts/ShortcutsDialog'
import { Toaster } from '@/components/ui/Toaster'
import { useAiAutopilot } from '@/hooks/useAiAutopilot'
import { useApplyTheme } from '@/hooks/useApplyTheme'
import { useGlobalShortcuts } from '@/hooks/useGlobalShortcuts'
import { useRouter, useUrlSync } from '@/routing/router'
import { watchAiProblems, watchSession } from '@/store/actions'
import { startClock } from '@/store/clock'
import { useInbox } from '@/store/inbox'
import { useSession } from '@/store/session'

export function App() {
  const status = useSession((s) => s.status)
  const page = useRouter((s) => s.page)
  useEffect(() => void useSession.getState().init(), [])
  useEffect(() => watchSession(), [])
  useEffect(() => startClock(), [])
  useEffect(() => watchAiProblems(), [])
  useApplyTheme()
  useUrlSync()

  return (
    <MotionConfig reducedMotion="user">
      <Screen status={status} page={page} />
      <RecoveryKeyDialog />
      <Toaster />
    </MotionConfig>
  )
}

/** What the address bar says to show. The pages below are public; the inbox needs an account. */
function Screen({ status, page }: { status: ReturnType<typeof useSession.getState>['status']; page: ReturnType<typeof useRouter.getState>['page'] }) {
  if (page === 'help') return <HelpPage />
  if (page === 'terms') return <TermsPage />
  if (page === 'privacy') return <PrivacyPage />
  if (page === 'not-found') return <NotFoundPage />
  if (status === 'checking') return <Splash />
  if (status === 'signed-out' || page === 'login') return <AuthScreen />
  return <Inbox />
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
