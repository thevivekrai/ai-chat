import { useEffect } from 'react'
import { MotionConfig } from 'motion/react'
import { CommandBar } from '@/components/command/CommandBar'
import { AppShell } from '@/components/layout/AppShell'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { ShortcutsDialog } from '@/components/shortcuts/ShortcutsDialog'
import { Toaster } from '@/components/ui/Toaster'
import { useAiAutopilot } from '@/hooks/useAiAutopilot'
import { useApplyTheme } from '@/hooks/useApplyTheme'
import { useGlobalShortcuts } from '@/hooks/useGlobalShortcuts'
import { watchAiProblems } from '@/store/actions'
import { startClock } from '@/store/clock'
import { useInbox } from '@/store/inbox'

export function App() {
  useEffect(() => useInbox.getState().connect(), [])
  useEffect(() => startClock(), [])
  useEffect(() => watchAiProblems(), [])
  useApplyTheme()
  useAiAutopilot()
  useGlobalShortcuts()

  return (
    <MotionConfig reducedMotion="user">
      <AppShell />
      <CommandBar />
      <SettingsDialog />
      <ShortcutsDialog />
      <Toaster />
    </MotionConfig>
  )
}
