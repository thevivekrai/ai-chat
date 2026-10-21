/**
 * User actions that touch more than one store. Buttons, menus and keyboard shortcuts all call
 * these, so behaviour (auto-advance, undo toasts, consent clean-up) is identical everywhere.
 */
import type { ExtractedTask } from '@/ai'
import { api, type ConnectorId, type MatrixLogin } from '@/data/api'
import { isAtLeast } from '@/lib/media'
import { formatWhen } from '@/lib/time'
import { useAi } from './ai'
import { useInbox } from './inbox'
import { usesClaude, useSettings, type ClaudeSettings } from './settings'
import { toast, useToasts } from './toasts'
import { useUi } from './ui'

const threadTitle = (threadId: string) => useInbox.getState().threads[threadId]?.title ?? 'Chat'

/** Opens a thread, optionally scrolling to and highlighting one message. */
export function openThread(threadId: string, messageId?: string) {
  const ui = useUi.getState()
  ui.selectThread(threadId)
  if (messageId) ui.flashMessage(messageId)
}

export async function sendReply(threadId: string, text: string) {
  const body = text.trim()
  if (!body) return
  const ui = useUi.getState()
  ui.setComposer(threadId, '')
  ui.setDraftsOpen(false)
  await useInbox.getState().sendMessage(threadId, body)
}

/**
 * Removes a thread from the list it is in (done or snoozed). In Needs reply, the next thread opens
 * so triage can continue with E, E, E…
 */
async function leaveQueue(threadId: string, patch: { doneAt?: string | null; snoozedUntil?: string | null }, title: string) {
  const ui = useUi.getState()
  const leavesList = (ui.view === 'needs-reply' || ui.view === 'waiting') && ui.selectedThreadId === threadId
  const ids = ui.navThreadIds
  const index = ids.indexOf(threadId)
  const nextId = ids[index + 1] ?? ids[index - 1] ?? null

  const update = useInbox.getState().setThreadState(threadId, patch)
  if (leavesList) {
    if (isAtLeast('md')) ui.selectThread(nextId)
    else ui.closeMobileThread()
  }
  const previous = await update
  toast({
    title,
    description: threadTitle(threadId),
    group: 'queue',
    action: {
      label: 'Undo',
      run: () => {
        void useInbox.getState().setThreadState(threadId, previous)
        if (leavesList) openThread(threadId)
      },
    },
  })
}

export function markDone(threadId: string) {
  return leaveQueue(threadId, { doneAt: new Date().toISOString(), snoozedUntil: null }, 'Marked done')
}

export function snoozeThread(threadId: string, until: Date) {
  const label = formatWhen(until.toISOString(), Date.now(), { withTime: true })
  return leaveQueue(threadId, { snoozedUntil: until.toISOString() }, `Snoozed until ${label}`)
}

export function unsnoozeThread(threadId: string) {
  return useInbox.getState().setThreadState(threadId, { snoozedUntil: null })
}

export function reopenThread(threadId: string) {
  return useInbox.getState().setThreadState(threadId, { doneAt: null })
}

/** R / "Draft replies": opens the tray and starts the three drafts (cached per thread state). */
export function toggleDrafts(threadId: string) {
  const ui = useUi.getState()
  const open = !ui.draftsOpen
  ui.setDraftsOpen(open)
  if (open) useAi.getState().requestDrafts(threadId)
}

/** Puts a draft in the composer for editing. Drafts are never sent automatically. */
export function applyDraft(threadId: string, text: string) {
  const ui = useUi.getState()
  ui.setComposer(threadId, text)
  ui.setDraftsOpen(false)
  ui.focusComposer()
}

export async function scheduleReply(threadId: string, text: string, sendAt: Date) {
  const body = text.trim()
  if (!body) return
  const ui = useUi.getState()
  ui.setComposer(threadId, '')
  ui.setDraftsOpen(false)
  await useInbox.getState().scheduleMessage(threadId, body, sendAt.toISOString())
  toast({
    title: `Scheduled for ${formatWhen(sendAt.toISOString(), Date.now(), { withTime: true })}`,
    description: `To ${threadTitle(threadId)} · see Scheduled`,
    group: 'schedule',
    action: { label: 'View', run: () => useUi.getState().setView('scheduled') },
  })
}

/* ── AI consent ──────────────────────────────────────────────────────────── */

export function turnOnAi(options: { threadIds?: string[]; quiet?: boolean } = {}) {
  const settings = useSettings.getState()
  const allIds = Object.keys(useInbox.getState().threads)
  const ids = options.threadIds ?? (settings.aiThreadIds.length ? settings.aiThreadIds : allIds)
  settings.setThreadsAllowed(ids, true)
  settings.setAiEnabled(true)
  if (options.quiet) return
  const count = useSettings.getState().aiThreadIds.length
  const where = usesClaude(useSettings.getState())
    ? 'They are sent to Claude when an AI feature runs.'
    : 'The built-in demo AI runs on this device.'
  toast({
    title: 'AI is on',
    description: `It can read ${count} of ${allIds.length} chats. ${where}`,
    group: 'ai',
    action: { label: 'Choose chats', run: () => useUi.getState().openSettings('ai') },
  })
}

export function turnOffAi() {
  useSettings.getState().setAiEnabled(false)
  useAi.getState().forgetAll()
  toast({ title: 'AI is off', description: 'AI results were cleared from this device.', group: 'ai' })
}

/** Per-thread consent, from the AI panel or Settings. Allowing one chat turns AI on for just it. */
export function setThreadAiAccess(threadId: string, allowed: boolean) {
  const settings = useSettings.getState()
  if (allowed) {
    settings.setThreadsAllowed([threadId], true)
    if (!settings.aiEnabled) settings.setAiEnabled(true)
  } else {
    settings.setThreadsAllowed([threadId], false)
    useAi.getState().forgetThread(threadId)
  }
}

/* ── Accounts ────────────────────────────────────────────────────────────── */

const ACCOUNT_NAMES: Record<ConnectorId, string> = { telegram: 'Telegram bot', matrix: 'Matrix' }

function offerToHideDemo(name: string) {
  const demoShown = api.connections.get().demo
  toast({
    title: `${name} connected`,
    description: demoShown ? 'Its chats appear as they sync. The demo chats are still shown too.' : 'Its chats appear as they sync.',
    group: 'accounts',
    action: demoShown ? { label: 'Hide demo', run: () => void setDemoShown(false) } : undefined,
  })
}

export async function connectTelegram(token: string, apiBase?: string) {
  await api.connections.connectTelegram({ token, apiBase })
  offerToHideDemo(ACCOUNT_NAMES.telegram)
}

export async function connectMatrix(login: MatrixLogin) {
  await api.connections.connectMatrix(login)
  offerToHideDemo(ACCOUNT_NAMES.matrix)
}

export async function disconnectAccount(id: ConnectorId) {
  await api.connections.disconnect(id)
  toast({ title: `${ACCOUNT_NAMES[id]} disconnected`, description: 'Its chats were removed from this device.', group: 'accounts' })
}

export async function applyConnectorFix(id: ConnectorId, fixId: string) {
  await api.connections.applyFix(id, fixId)
}

export async function setDemoShown(shown: boolean) {
  // A "connected" toast offering to hide the demo would now be out of date.
  useToasts.getState().dismissGroup('accounts')
  await api.connections.setDemoEnabled(shown)
}

/* ── Claude ──────────────────────────────────────────────────────────────── */

/** Saves the key or model choice. Results from another engine or model are recomputed. */
export function updateClaude(patch: Partial<ClaudeSettings>) {
  const before = useSettings.getState().claude
  useSettings.getState().setClaude(patch)
  const after = useSettings.getState().claude
  const changed =
    before.apiKey.trim() !== after.apiKey.trim() || before.model !== after.model || before.triageModel !== after.triageModel
  if (changed) useAi.getState().forgetAll()
}

/** After a setup problem (say, a rejected key), resumes the automatic AI calls. */
export function retryAi() {
  useAi.getState().clearProblem()
  const threadId = useUi.getState().selectedThreadId
  if (!threadId) return
  useAi.getState().ensureSummary(threadId)
  useAi.getState().ensureTasks(threadId)
}

/** Tells the user once when Claude can't run at all, instead of failing quietly per chat. */
export function watchAiProblems() {
  return useAi.subscribe((state, prev) => {
    if (!state.problem || state.problem.message === prev.problem?.message) return
    toast({
      title: "Claude couldn't run",
      description: state.problem.message,
      group: 'ai-problem',
      action: { label: 'Settings', run: () => useUi.getState().openSettings('ai') },
    })
  })
}

/* ── Tasks ───────────────────────────────────────────────────────────────── */

export async function addExtractedTask(threadId: string, task: ExtractedTask) {
  await useInbox.getState().addTask({
    title: task.title,
    dueAt: task.dueAt,
    source: { threadId, messageId: task.sourceMessageId },
  })
  toast({
    title: 'Added to Tasks',
    description: task.title,
    group: 'tasks',
    action: { label: 'View', run: () => useUi.getState().setView('tasks') },
  })
}

/* ── Panels ──────────────────────────────────────────────────────────────── */

export function toggleAiPanel() {
  const ui = useUi.getState()
  if (isAtLeast('wide')) ui.setAiPanelOpen(!ui.aiPanelOpen)
  else ui.setAiSheetOpen(!ui.aiSheetOpen)
}

/* ── Demo controls ───────────────────────────────────────────────────────── */

export async function simulateIncoming() {
  const message = await useInbox.getState().simulateIncoming()
  if (!message) return
  const sender = useInbox.getState().contacts[message.senderId]?.name ?? 'Someone'
  toast({
    title: `New message from ${sender}`,
    description: message.body,
    action: { label: 'Open', run: () => openThread(message.threadId, message.id) },
  })
}

export async function resetDemo() {
  await useInbox.getState().resetDemo()
  useAi.getState().forgetAll()
  const ui = useUi.getState()
  ui.selectThread(null)
  Object.keys(ui.composer).forEach((id) => ui.setComposer(id, ''))
  toast({ title: 'Demo data reset', description: 'Fresh conversations, timed relative to now.' })
}
