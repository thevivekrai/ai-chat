/**
 * User actions that touch more than one store. Buttons, menus and keyboard shortcuts all call
 * these, so behaviour (auto-advance, undo toasts, consent clean-up) is identical everywhere.
 */
import type { ExtractedTask } from '@/ai'
import { api, type ConnectorId, type LinkedNetwork, type MatrixLogin } from '@/data/api'
import { MAX_OWN_LABELS, type ChatLabel, type MessageAction } from '@/data/types'
import { myReaction } from '@/data/reactions'
import { serverApi } from '@/data/server/serverApi'
import { LINKED_PREFIXES, MAX_CAPTION } from '@/data/server/types'
import { isAtLeast } from '@/lib/media'
import { stickerFile, type Sticker } from '@/lib/stickers'
import { formatWhen } from '@/lib/time'
import { useAi } from './ai'
import { isUnsentHere, useInbox } from './inbox'
import { incognitoOn } from './privacy'
import { useSession } from './session'
import { keepAiConsent } from './aiConsent'
import { currentAiEngine } from './aiEngine'
import { useSettings, type AiSettings } from './settings'
import { toast, useToasts } from './toasts'
import { useUi } from './ui'

const threadTitle = (threadId: string) => useInbox.getState().threads[threadId]?.title ?? 'Chat'

/** Opens a thread, optionally scrolling to and highlighting one message. */
export function openThread(threadId: string, messageId?: string) {
  const ui = useUi.getState()
  ui.selectThread(threadId)
  if (messageId) ui.flashMessage(messageId)
}

/**
 * Opens a chat with someone there's none with yet (found in search), and goes to it. It's ready
 * for the first message; nothing is sent to them until one is.
 */
export async function startChatWith(contactId: string) {
  try {
    const thread = await api.startChat(contactId)
    useInbox.setState((s) => ({ threads: { ...s.threads, [thread.id]: thread } }))
    openThread(thread.id)
    useUi.getState().focusComposer()
  } catch (error) {
    toast({ title: "Couldn't start the chat", description: error instanceof Error ? error.message : undefined, group: 'people' })
  }
}

/**
 * Sends what's in the composer. With photos or files, each goes as its own message, the text as
 * the first one's caption (and the reply quoting from the first).
 */
export async function sendReply(threadId: string, text: string, files: File[] = []) {
  const body = text.trim()
  if (!body && !files.length) return
  const ui = useUi.getState()
  const replyToId = ui.replyingTo[threadId]
  ui.setComposer(threadId, '')
  ui.setReplyingTo(threadId, null)
  ui.setDraftsOpen(false)
  stopTyping(threadId)
  const inbox = useInbox.getState()
  if (!files.length) {
    await inbox.sendMessage(threadId, body, replyToId ? { replyToId } : undefined)
    return
  }
  // Text too long for a caption goes first, as a message of its own (with the quote), then the files.
  const ownMessage = body.length > MAX_CAPTION
  if (ownMessage) await inbox.sendMessage(threadId, body, replyToId ? { replyToId } : undefined)
  // All shown at once; they go one after another, in this order (see the server connector).
  await Promise.all(
    files.map((file, i) =>
      inbox.sendMessage(threadId, i === 0 && !ownMessage ? body : '', { file, ...(i === 0 && !ownMessage && replyToId ? { replyToId } : {}) }),
    ),
  )
}

/** Sends a sticker: as the network's own sticker where it has them, a picture otherwise. */
export async function sendSticker(threadId: string, sticker: Sticker) {
  let file: File
  try {
    file = await stickerFile(sticker)
  } catch (error) {
    toast({ title: "Couldn't send the sticker", description: error instanceof Error ? error.message : undefined, group: 'stickers' })
    return
  }
  const ui = useUi.getState()
  const replyToId = ui.replyingTo[threadId]
  ui.setReplyingTo(threadId, null)
  await useInbox.getState().sendMessage(threadId, '', { file, sticker: true, ...(replyToId ? { replyToId } : {}) })
}

/* ── Editing, deleting, pinning and starring ─────────────────────────────── */

const ACTION_DONE: Record<MessageAction['type'], (action: MessageAction) => string | null> = {
  edit: () => null,
  delete: (a) => (a.type === 'delete' && a.forEveryone ? 'Deleted for everyone' : 'Deleted for you'),
  pin: (a) => (a.type === 'pin' && a.pinned ? 'Pinned' : 'Unpinned'),
  star: (a) => (a.type === 'star' && a.starred ? 'Starred' : 'Unstarred'),
}

/** Edits, deletes, pins or stars a message; says so, or why it couldn't. */
export async function messageAction(threadId: string, messageId: string, action: MessageAction): Promise<boolean> {
  try {
    await useInbox.getState().actOnMessage(threadId, messageId, action)
    const done = ACTION_DONE[action.type](action)
    if (done) toast({ title: done, group: 'message-action' })
    return true
  } catch (error) {
    toast({ title: "Couldn't do that", description: error instanceof Error ? error.message : undefined, group: 'message-action' })
    return false
  }
}

/**
 * Removes a message that wasn't sent: this device's own copy, or (one the network kept, which it
 * said failed) deleted for me, here and on the phone.
 */
export function removeUnsent(threadId: string, messageId: string) {
  if (isUnsentHere(messageId)) useInbox.getState().discardMessage(threadId, messageId)
  else void messageAction(threadId, messageId, { type: 'delete', forEveryone: false })
}

/** Puts one of my messages in the composer to edit; sending it saves the edit. */
export function startEdit(threadId: string, messageId: string) {
  const message = useInbox.getState().messages[threadId]?.find((m) => m.id === messageId)
  if (!message) return
  const ui = useUi.getState()
  // What was being written is set aside, and comes back when the edit is saved or cancelled.
  if (!ui.editing[threadId]) setAside(threadId)
  ui.setReplyingTo(threadId, null)
  ui.setEditing(threadId, messageId)
  ui.setComposer(threadId, message.body)
  ui.focusComposer()
}

function setAside(threadId: string) {
  const ui = useUi.getState()
  const replyingTo = ui.replyingTo[threadId]
  ui.setEditDraft(threadId, { text: ui.composer[threadId] ?? '', ...(replyingTo ? { replyingTo } : {}) })
}

/** Leaves the edit; the reply that was being written before it comes back. */
export function cancelEdit(threadId: string) {
  const ui = useUi.getState()
  const draft = ui.editDrafts[threadId]
  ui.setEditing(threadId, null)
  ui.setEditDraft(threadId, null)
  ui.setComposer(threadId, draft?.text ?? '')
  if (draft?.replyingTo) ui.setReplyingTo(threadId, draft.replyingTo)
}

/** Saves the composer's text as the edited message. */
export async function saveEdit(threadId: string, text: string) {
  const ui = useUi.getState()
  const messageId = ui.editing[threadId]
  const body = text.trim()
  if (!messageId || !body) return
  const before = useInbox.getState().messages[threadId]?.find((m) => m.id === messageId)
  cancelEdit(threadId)
  if (before?.body === body) return
  const saved = await messageAction(threadId, messageId, { type: 'edit', body })
  // Refused (too late to edit, say): back to editing, with the new text, unless another edit began.
  const now = useUi.getState()
  if (!saved && !now.editing[threadId]) {
    setAside(threadId)
    now.setReplyingTo(threadId, null)
    now.setEditing(threadId, messageId)
    now.setComposer(threadId, text)
  }
}

/** Quotes a message in the reply being written. */
export function startReply(threadId: string, messageId: string) {
  const ui = useUi.getState()
  if (ui.editing[threadId]) cancelEdit(threadId)
  ui.setReplyingTo(threadId, messageId)
  ui.focusComposer()
}

/** Reacts with `emoji`, or takes my reaction back if it's the one I already gave. */
export async function toggleReaction(threadId: string, messageId: string, emoji: string) {
  const message = useInbox.getState().messages[threadId]?.find((m) => m.id === messageId)
  const next = myReaction(message?.reactions) === emoji ? null : emoji
  try {
    await useInbox.getState().react(threadId, messageId, next)
  } catch (error) {
    toast({ title: 'Reaction not sent', description: error instanceof Error ? error.message : undefined, group: 'reaction' })
  }
}

/* ── Typing notices ─────────────────────────────────────────────────────── */

/** "Typing" is renewed at most this often while the user keeps typing… */
const TYPING_RENEW_MS = 4000
/** …and taken back after this long without a keystroke. */
const TYPING_IDLE_MS = 5000
const typingSentAt = new Map<string, number>()
const typingIdle = new Map<string, ReturnType<typeof setTimeout>>()

/** Called on each keystroke in the composer: tells the chat I'm typing, where it can be told. */
export function noteTyping(threadId: string) {
  // Incognito: nobody sees "typing…".
  if (!api.capabilities(threadId).typing || incognitoOn()) return
  if (Date.now() - (typingSentAt.get(threadId) ?? 0) > TYPING_RENEW_MS) {
    typingSentAt.set(threadId, Date.now())
    void api.setTyping(threadId, true)
  }
  clearTimeout(typingIdle.get(threadId))
  typingIdle.set(threadId, setTimeout(() => stopTyping(threadId), TYPING_IDLE_MS))
}

export function stopTyping(threadId: string) {
  clearTimeout(typingIdle.get(threadId))
  typingIdle.delete(threadId)
  if (!typingSentAt.delete(threadId)) return
  void api.setTyping(threadId, false)
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

/**
 * Archives a chat (out of every list, into Archived) or brings it back. Like done, the next chat
 * opens when it leaves the list being worked through.
 */
export async function archiveThread(threadId: string, archived: boolean) {
  const ui = useUi.getState()
  const listed = archived ? ui.view === 'needs-reply' || ui.view === 'all' || ui.view === 'waiting' : ui.view === 'archived'
  const leavesList = listed && ui.selectedThreadId === threadId
  const ids = ui.navThreadIds
  const index = ids.indexOf(threadId)
  const nextId = ids[index + 1] ?? ids[index - 1] ?? null

  const update = useInbox.getState().archiveThread(threadId, archived)
  if (leavesList) {
    if (isAtLeast('md')) ui.selectThread(nextId)
    else ui.closeMobileThread()
  }
  try {
    await update
  } catch (error) {
    toast({
      title: archived ? "Couldn't archive the chat" : "Couldn't unarchive the chat",
      description: error instanceof Error ? error.message : undefined,
      group: 'queue',
    })
    return
  }
  toast({
    title: archived ? 'Archived' : 'Unarchived',
    description: threadTitle(threadId),
    group: 'queue',
    action: {
      label: 'Undo',
      run: () => {
        void useInbox
          .getState()
          .archiveThread(threadId, !archived)
          .catch((error: unknown) => toast({ title: "Couldn't undo that", description: error instanceof Error ? error.message : undefined }))
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

/** Tags put on a chat by hand. They sit alongside the AI's, and a done chat keeps only the calm ones. */
export function setThreadLabels(threadId: string, labels: ChatLabel[]) {
  return useInbox.getState().setThreadState(threadId, { labels: labels.slice(0, MAX_OWN_LABELS) })
}

export function toggleThreadLabel(threadId: string, label: ChatLabel) {
  const current = useInbox.getState().threads[threadId]?.labels ?? []
  return setThreadLabels(threadId, current.includes(label) ? current.filter((l) => l !== label) : [...current, label])
}

/**
 * Clears every tag from a chat — the user's and the AI's — and keeps it that way: the AI adds no
 * new ones until "Let AI tag this chat" is turned back on. Priority (Urgent, Normal, Low) isn't a
 * tag and stays as it is.
 */
export async function clearThreadLabels(threadId: string) {
  await useInbox.getState().setThreadState(threadId, { labels: [], labelsLocked: true })
  toast({
    title: 'Tags cleared',
    description: "The AI won't tag this chat again until you let it.",
    group: 'tags',
    action: { label: 'Let AI tag it', run: () => void setThreadLabelsLocked(threadId, false) },
  })
}

/** Whether the AI may tag this chat; the user's own tags stay either way. */
export function setThreadLabelsLocked(threadId: string, locked: boolean) {
  return useInbox.getState().setThreadState(threadId, { labelsLocked: locked })
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
  // Before the chats have loaded there'd be none to allow: wait for them.
  if (!options.threadIds && useInbox.getState().status !== 'ready') {
    const off = useInbox.subscribe((s) => {
      if (s.status !== 'ready') return
      off()
      turnOnAi(options)
    })
    return
  }
  const settings = useSettings.getState()
  const allIds = Object.keys(useInbox.getState().threads)
  const ids = options.threadIds ?? (settings.aiThreadIds.length ? settings.aiThreadIds : allIds)
  settings.setThreadsAllowed(ids, true)
  settings.setAiEnabled(true)
  if (options.quiet) return
  const count = useSettings.getState().aiThreadIds.length
  const engine = currentAiEngine()
  const where =
    engine.kind === 'demo'
      ? 'The built-in demo AI runs on this device.'
      : `They are sent to ${engine.name} when an AI feature runs.`
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

/* ── Accounts linked on the server ────────────────────────────────────────── */

export const LINKED_NAMES: Record<LinkedNetwork, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  guffshuff: 'Guffshuff',
  instagram: 'Instagram',
}


/** Chats linked on the server (as opposed to the demo or this browser's connectors). */
export const isServerThread = (threadId: string) => Object.values(LINKED_PREFIXES).some((prefix) => threadId.startsWith(prefix))

/** Called when a link finishes; the chats arrive as they sync. */
export function linkedNetworkConnected(network: LinkedNetwork) {
  offerToHideDemo(LINKED_NAMES[network])
}

export async function unlinkNetwork(network: LinkedNetwork) {
  await api.connections.unlink(network)
  const prefix = LINKED_PREFIXES[network]
  forgetThreadsHere((id) => id.startsWith(prefix))
  toast({
    title: `${LINKED_NAMES[network]} unlinked`,
    description: 'Sytext was logged out of it, and its chats were deleted from the server.',
    group: 'accounts',
  })
}

/** Which linked chats AI may read, kept for this account's next sign-in on this device. */
function keepConsentOfSignedInUser() {
  const user = useSession.getState().user
  if (user) keepAiConsent(user.id, useSettings.getState().aiThreadIds.filter(isServerThread))
}

/** Removes what this device kept about some chats: AI results and consent, unsent text, the selection. */
function forgetThreadsHere(matches: (threadId: string) => boolean) {
  const ai = useAi.getState()
  const ui = useUi.getState()
  const settings = useSettings.getState()
  const aiIds = new Set([...Object.keys(ai.priority), ...Object.keys(ai.summary), ...Object.keys(ai.tasks), ...Object.keys(ai.drafts)])
  for (const id of aiIds) if (matches(id)) ai.forgetThread(id)
  for (const id of Object.keys(ui.composer)) if (matches(id)) ui.setComposer(id, '')
  if (ui.selectedThreadId && matches(ui.selectedThreadId)) ui.selectThread(null)
  const allowed = settings.aiThreadIds.filter(matches)
  if (allowed.length) settings.setThreadsAllowed(allowed, false)
}

/* ── Signing in ──────────────────────────────────────────────────────────── */

export async function signIn(email: string, password: string) {
  const { user } = await serverApi.login({ email, password })
  await useSession.getState().signedIn(user)
}

export async function createAccount(name: string, email: string, password: string) {
  const { user, recoveryKey } = await serverApi.register({ name, email, password })
  if (recoveryKey) useSession.getState().showRecoveryKey(recoveryKey, user)
  await useSession.getState().signedIn(user)
}

/** A forgotten password, reset with the email and recovery key; the key is replaced by a new one. */
export async function recoverAccount(email: string, recoveryKey: string, password: string) {
  const { user, recoveryKey: next } = await serverApi.recover({ email, recoveryKey, password })
  if (next) useSession.getState().showRecoveryKey(next, user)
  await useSession.getState().signedIn(user)
  toast({ title: 'Password reset', description: 'Other devices were signed out.', group: 'session' })
}

/** A new recovery key, replacing the old one. */
export async function makeRecoveryKey(current: string) {
  const { user, recoveryKey } = await serverApi.newRecoveryKey(current)
  useSession.getState().setUser(user)
  useSession.getState().showRecoveryKey(recoveryKey, user)
}

export async function signInWithGoogle(credential: string) {
  const { user, passwordRemoved } = await serverApi.google(credential)
  await useSession.getState().signedIn(user)
  if (passwordRemoved) {
    toast({
      title: 'Signed in with Google',
      description: 'The password that was set on this account was turned off, to keep it yours. You can set a new one.',
      group: 'session',
      action: { label: 'Set password', run: () => useUi.getState().openSettings('profile') },
    })
  }
}

export async function signOut() {
  await serverApi.logout().catch(() => undefined)
  keepConsentOfSignedInUser()
  forgetThreadsHere(isServerThread)
  await useSession.getState().signedOut()
}

/** Sends the user back to the sign-in screen when the server ends the session. */
export function watchSession() {
  const offSignedOut = api.connections.onSignedOut(() => {
    if (useSession.getState().status !== 'signed-in') return
    keepConsentOfSignedInUser()
    forgetThreadsHere(isServerThread)
    void useSession.getState().signedOut('You were signed out. Sign in again to see your chats.')
  })
  // Changed on another device (Incognito mode turned on there, say): this one follows at once.
  const offUser = api.connections.onUserUpdated((user) => {
    if (useSession.getState().user?.id === user.id) useSession.getState().setUser(user)
  })
  return () => {
    offSignedOut()
    offUser()
  }
}

/** Turns Incognito mode on or off: for the account when signed in, else on this device. */
export async function setIncognito(on: boolean) {
  if (useSession.getState().user) {
    const { user } = await serverApi.setIncognito(on)
    useSession.getState().setUser(user)
  } else {
    useSettings.getState().setIncognito(on)
  }
  toast({
    title: on ? 'Incognito mode is on' : 'Incognito mode is off',
    description: on ? "People won't see when you've read their messages, or that you're typing." : 'Read receipts and typing show again.',
  })
}

/** In Incognito mode: lets this chat know its messages were read, once. */
export async function sendReadReceipt(threadId: string) {
  try {
    await api.markRead(threadId, { receipt: true })
    toast({ title: 'Marked as read for them', description: threadTitle(threadId), group: 'read-receipt' })
  } catch (error) {
    toast({ title: "Couldn't send the read receipt", description: error instanceof Error ? error.message : undefined, group: 'read-receipt' })
  }
}

export async function renameUser(name: string) {
  const { user } = await serverApi.rename(name)
  useSession.getState().setUser(user)
}

export async function changePassword(password: string, current?: string) {
  const { user, recoveryKey } = await serverApi.setPassword({ password, current })
  useSession.getState().setUser(user)
  // A new password comes with a new recovery key: the old one could have been made by whoever knew
  // the old password.
  if (recoveryKey) useSession.getState().showRecoveryKey(recoveryKey, user)
  toast({ title: 'Password saved', description: 'Other devices were signed out.', group: 'session' })
}

export async function changeAvatar(image: string) {
  const { user } = await serverApi.uploadAvatar(image)
  useSession.getState().setUser(user)
}

export async function setDemoShown(shown: boolean) {
  // A "connected" toast offering to hide the demo would now be out of date.
  useToasts.getState().dismissGroup('accounts')
  await api.connections.setDemoEnabled(shown)
}

/* ── AI engine ───────────────────────────────────────────────────────────── */

/** Saves the AI choice, keys or models. Results from another engine or model are recomputed (aiEngine.ts). */
export function updateAi(patch: Partial<AiSettings>) {
  useSettings.getState().setAi(patch)
}

/** After a setup problem (say, a rejected key), resumes the automatic AI calls. */
export function retryAi() {
  useAi.getState().clearProblem()
  const threadId = useUi.getState().selectedThreadId
  if (!threadId) return
  useAi.getState().ensureSummary(threadId)
  useAi.getState().ensureTasks(threadId)
}

/** Tells the user once when the AI can't run at all, instead of failing quietly per chat. */
export function watchAiProblems() {
  return useAi.subscribe((state, prev) => {
    if (!state.problem || state.problem.message === prev.problem?.message) return
    toast({
      title: `${currentAiEngine().name} couldn't run`,
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
