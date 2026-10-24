import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { AlertTriangle, CalendarClock, Check, CornerUpLeft, FileText, Paperclip, Pencil, SendHorizontal, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Menu } from '@/components/ui/Popover'
import { useTickEffect } from '@/hooks/useTickEffect'
import { api } from '@/data/api'
import { MAX_FILE_BYTES } from '@/data/server/types'
import { cn } from '@/lib/cn'
import { fileSize, isPhoto } from '@/lib/files'
import { findPlaceholders, placeholderPattern, shortName } from '@/lib/format'
import { NETWORKS } from '@/lib/networks'
import { sendLaterOptions } from '@/lib/schedule'
import { formatShortWhen } from '@/lib/time'
import { ME_ID } from '@/data/types'
import { cancelEdit, noteTyping, saveEdit, scheduleReply, sendReply, stopTyping, toggleDrafts } from '@/store/actions'
import { useClock } from '@/store/clock'
import { useInbox } from '@/store/inbox'
import { toast } from '@/store/toasts'
import { useUi } from '@/store/ui'

const MAX_HEIGHT = 200
/** Photos and files sent at once. */
const MAX_FILES = 10

/** Selects the next [placeholder] after the cursor, wrapping around. Returns false if there is none. */
function selectNextBlank(el: HTMLTextAreaElement): boolean {
  const matches = [...el.value.matchAll(placeholderPattern())]
  if (matches.length === 0) return false
  const after = matches.find((m) => (m.index ?? 0) >= el.selectionEnd) ?? matches[0]
  const start = after.index ?? 0
  el.setSelectionRange(start, start + after[0].length)
  return true
}

export function Composer({ threadId }: { threadId: string }) {
  const thread = useInbox((s) => s.threads[threadId])
  // Address the person in a 1:1 chat ("Message Kavya…"), the chat itself in a group.
  const recipient = useInbox((s) => {
    const t = s.threads[threadId]
    const person = t?.kind === 'direct' ? s.contacts[t.participantIds[0]] : undefined
    return person ? shortName(person.name) : (t?.title ?? '')
  })
  const text = useUi((s) => s.composer[threadId] ?? '')
  const replyingToId = useUi((s) => s.replyingTo[threadId])
  const replyingTo = useInbox((s) => (replyingToId ? s.messages[threadId]?.find((m) => m.id === replyingToId) : undefined))
  const quotedName = useInbox((s) =>
    !replyingTo ? '' : replyingTo.senderId === ME_ID ? 'yourself' : (s.contacts[replyingTo.senderId]?.name ?? 'someone'),
  )
  // Editing one of my messages: the composer holds its new text, and sending saves it.
  const editingId = useUi((s) => s.editing[threadId])
  const editing = useInbox((s) => (editingId ? s.messages[threadId]?.find((m) => m.id === editingId) : undefined))
  const draftsOpen = useUi((s) => s.draftsOpen)
  const focusTick = useUi((s) => s.composerFocusTick)
  const now = useClock((s) => s.now)
  const ref = useRef<HTMLTextAreaElement>(null)
  // Asking once before sending a reply that still has a [blank] in it.
  const [confirmingBlanks, setConfirmingBlanks] = useState(false)
  const blanks = findPlaceholders(text)
  // Photos and files waiting to be sent, for this chat only.
  const canAttach = useMemo(() => api.capabilities(threadId).files, [threadId])
  const [attached, setAttached] = useState<{ threadId: string; files: File[] }>({ threadId, files: [] })
  const files = attached.threadId === threadId ? attached.files : []
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  // Focus requests (Enter shortcut, or a draft was just inserted): select the first blank if any.
  useTickEffect(focusTick, () => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    selectNextBlank(el)
  })

  // The message being edited was deleted (here, or on another device): there's nothing to save the
  // edit to, so it's dropped, and what was being written before comes back.
  // (Only once the chat has loaded: after a reload the edit is restored before its messages are.)
  const loaded = useInbox((s) => s.status === 'ready' && !!s.messages[threadId])
  const editGone = !!editingId && loaded && (!editing || !!editing.deleted)
  useEffect(() => {
    if (!editGone) return
    cancelEdit(threadId)
    toast({ title: 'That message was deleted', description: 'So there was nothing left to edit.', group: 'message-action' })
  }, [editGone, threadId])

  if (!thread) return null
  const setText = (value: string) => {
    setConfirmingBlanks(false)
    useUi.getState().setComposer(threadId, value)
    if (value.trim()) noteTyping(threadId)
    else stopTyping(threadId)
  }
  const cancelReply = () => useUi.getState().setReplyingTo(threadId, null)

  const addFiles = (incoming: File[]) => {
    if (!canAttach || !incoming.length) return
    const tooBig = incoming.filter((f) => f.size > MAX_FILE_BYTES)
    if (tooBig.length) {
      toast({
        title: tooBig.length === 1 ? `${tooBig[0].name} is too big` : `${tooBig.length} files are too big`,
        description: `Files up to ${fileSize(MAX_FILE_BYTES)} can be sent from Sytext.`,
        group: 'attach',
      })
    }
    const next = [...files, ...incoming.filter((f) => f.size <= MAX_FILE_BYTES && f.size > 0)].slice(0, MAX_FILES)
    setAttached({ threadId, files: next })
    ref.current?.focus()
  }
  const removeFile = (index: number) => setAttached({ threadId, files: files.filter((_, i) => i !== index) })

  const send = () => {
    if (editingId) {
      void saveEdit(threadId, text)
      return
    }
    if (!text.trim() && !files.length) return
    if (blanks.length && !confirmingBlanks) {
      setConfirmingBlanks(true)
      return
    }
    setConfirmingBlanks(false)
    void sendReply(threadId, text, files)
    setAttached({ threadId, files: [] })
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files]
    if (!canAttach || !pasted.length) return
    e.preventDefault()
    addFiles(pasted)
  }

  const carriesFiles = (e: DragEvent) => canAttach && [...e.dataTransfer.types].includes('Files')
  const dropHandlers = {
    onDragOver: (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      setDragging(true)
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
    },
    onDrop: (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      setDragging(false)
      addFiles([...e.dataTransfer.files])
    },
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    } else if (e.key === 'Tab' && !e.shiftKey && selectNextBlank(e.currentTarget)) {
      e.preventDefault()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (useUi.getState().draftsOpen) useUi.getState().setDraftsOpen(false)
      else if (editingId) cancelEdit(threadId)
      else if (replyingToId) cancelReply()
      else e.currentTarget.blur()
    }
  }

  const options = sendLaterOptions(now)
  const hasText = !!text.trim()
  const canSend = hasText || (files.length > 0 && !editingId)

  return (
    <div className="shrink-0 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4" {...dropHandlers}>
      {editingId && (
        <div className="mb-2 flex items-center gap-2.5 rounded-2xl border border-line bg-surface px-3 py-2 shadow-card animate-pop-in">
          <Pencil className="size-4 shrink-0 text-accent-ink" aria-hidden />
          <div className="min-w-0 flex-1 border-l-[3px] border-accent pl-2.5">
            <p className="text-xs font-semibold text-accent-ink">Editing message</p>
            <p className="truncate text-xs text-muted">{editing?.body ?? ''}</p>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Cancel editing" title="Cancel editing (Esc)" onClick={() => cancelEdit(threadId)}>
            <X className="size-4" />
          </Button>
        </div>
      )}
      {!editingId && replyingTo && replyingToId && (
        <div className="mb-2 flex items-center gap-2.5 rounded-2xl border border-line bg-surface px-3 py-2 shadow-card animate-pop-in">
          <CornerUpLeft className="size-4 shrink-0 text-accent-ink" aria-hidden />
          <div className="min-w-0 flex-1 border-l-[3px] border-accent pl-2.5">
            <p className="text-xs font-semibold text-accent-ink">Replying to {quotedName}</p>
            <p className="truncate text-xs text-muted">{replyingTo.body || replyingTo.attachments?.[0]?.name || 'Message'}</p>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Cancel reply" title="Cancel reply (Esc)" onClick={cancelReply}>
            <X className="size-4" />
          </Button>
        </div>
      )}
      {confirmingBlanks && (
        <p role="alert" className="mb-2 flex items-center gap-1.5 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          Fill in {blanks.join(', ')} first — or press Enter again to send as is.
        </p>
      )}
      {files.length > 0 && (
        <ul aria-label="Attached" className="mb-2 flex gap-2 overflow-x-auto pb-1">
          {files.map((file, i) => (
            <FileChip key={`${file.name}-${file.size}-${i}`} file={file} onRemove={() => removeFile(i)} />
          ))}
        </ul>
      )}
      <div
        className={cn(
          'flex items-end gap-1.5 rounded-3xl border bg-surface py-1.5 pr-1.5 shadow-card transition-[border-color,box-shadow]',
          canAttach ? 'pl-1.5' : 'pl-4',
          dragging
            ? 'border-accent ring-4 ring-accent/20'
            : 'border-line focus-within:border-accent/40 focus-within:ring-4 focus-within:ring-accent/10',
        )}
      >
        {canAttach && !editingId && (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              aria-hidden
              tabIndex={-1}
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])])
                e.target.value = ''
              }}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Attach photos or files"
              title="Attach photos or files"
              disabled={files.length >= MAX_FILES}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip className="size-[18px]" />
            </Button>
          </>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={
            editingId ? 'Edit your message…' : files.length ? 'Add a caption…' : `Message ${recipient} on ${NETWORKS[thread.network].name}…`
          }
          aria-label="Message"
          className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[14.5px] leading-relaxed outline-none placeholder:text-faint"
        />
        <Menu
          title="Send later"
          side="top"
          panelClassName="min-w-64"
          items={options.map((o) => ({
            id: o.id,
            label: o.label,
            hint: formatShortWhen(o.at.getTime(), now),
            icon: CalendarClock,
            onSelect: () => void scheduleReply(threadId, text, o.at),
          }))}
          renderTrigger={(props) => (
            <Button
              {...props}
              variant="ghost"
              size="icon-sm"
              aria-label="Send later"
              disabled={!hasText || files.length > 0 || !!editingId}
              title={files.length ? "Photos and files can't be sent later" : 'Send later'}
            >
              <CalendarClock className="size-[18px]" />
            </Button>
          )}
        />
        <Button
          variant="primary"
          size="icon-sm"
          aria-label={editingId ? 'Save edit' : 'Send'}
          title={editingId ? 'Save (Enter)' : 'Send (Enter)'}
          disabled={!canSend}
          onClick={send}
        >
          {editingId ? <Check className="size-4" /> : <SendHorizontal className="size-4" />}
        </Button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button
          variant={draftsOpen ? 'soft' : 'ghost'}
          size="sm"
          aria-expanded={draftsOpen}
          onClick={() => toggleDrafts(threadId)}
          className="text-accent-ink"
        >
          <Sparkles className="size-3.5" aria-hidden /> Draft replies <Kbd className="hidden sm:inline-flex">R</Kbd>
        </Button>
        <p className="ml-auto hidden truncate text-xs text-faint sm:block">
          {blanks.length ? (
            <>
              <Kbd>Tab</Kbd> jumps to the next blank
            </>
          ) : (
            'Enter to send · Shift+Enter for a new line'
          )}
        </p>
      </div>
    </div>
  )
}

/** A photo or file waiting to be sent: a preview, its name and size, and a way to take it off. */
function FileChip({ file, onRemove }: { file: File; onRemove(): void }) {
  const photo = isPhoto(file)
  const image = useRef<HTMLImageElement>(null)
  // The preview is a link to the file on this device, let go of when the chip goes.
  useEffect(() => {
    if (!photo || !image.current) return
    const url = URL.createObjectURL(file)
    image.current.src = url
    return () => URL.revokeObjectURL(url)
  }, [file, photo])
  return (
    <li className="flex max-w-56 shrink-0 items-center gap-2 rounded-2xl border border-line bg-surface py-1.5 pr-1 pl-1.5 shadow-card animate-pop-in">
      {photo ? (
        <img ref={image} alt="" className="size-9 shrink-0 rounded-lg bg-surface-2 object-cover" />
      ) : (
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink">
          <FileText className="size-4" aria-hidden />
        </span>
      )}
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium">{file.name}</span>
        <span className="block text-[11px] text-muted">{fileSize(file.size)}</span>
      </span>
      <Button variant="ghost" size="icon-sm" aria-label={`Remove ${file.name}`} onClick={onRemove}>
        <X className="size-3.5" />
      </Button>
    </li>
  )
}
