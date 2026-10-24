import { useState } from 'react'
import { Check, Copy, Download, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { APP_NAME } from '@/config'
import { useSession } from '@/store/session'

/**
 * A new recovery key, shown this once: the server keeps only its hash. It stays open until the
 * user says it's saved, since without it a forgotten password can't be reset.
 */
export function RecoveryKeyDialog() {
  const shown = useSession((s) => s.recoveryKey)
  // Only ever to its owner: while they're signed in, or signed out before they saved it.
  const forOwner = useSession((s) => !!shown && (!s.user || s.user.id === shown.userId))
  const key = forOwner ? shown!.key : null
  // A fresh dialog for each key: nothing ticked for one carries over to the next.
  return <KeyDialog key={key ?? ''} recoveryKey={key} email={shown?.email} />
}

function KeyDialog({ recoveryKey: key, email }: { recoveryKey: string | null; email: string | undefined }) {
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)

  const done = () => useSession.getState().recoveryKeySaved()

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('No clipboard here')
      await navigator.clipboard.writeText(key!)
      setCopied('yes')
      setSaved(true)
    } catch {
      setCopied('failed')
    }
  }

  const download = () => {
    if (!key) return
    const text = [
      `${APP_NAME} recovery key`,
      '',
      ...(email ? [`Account: ${email}`] : []),
      `Key: ${key}`,
      `Made: ${new Date().toLocaleString()}`,
      '',
      `Forgot your password? On the ${APP_NAME} sign-in page choose "Forgot password?", then enter your`,
      'email, this key and a new password. The key works once: you get a new one after using it.',
      '',
    ].join('\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const link = Object.assign(document.createElement('a'), { href: url, download: `${APP_NAME.toLowerCase()}-recovery-key.txt` })
    // In the page while it's clicked, and the file released only later: some browsers otherwise drop
    // the download without a word. Whether it was saved is for the user to say.
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  return (
    <Modal open={!!key} onClose={() => saved && done()} label="Your recovery key" className="max-w-md">
      {key && (
        <div className="space-y-4 p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent-ink">
              <KeyRound className="size-5" aria-hidden />
            </span>
            <div className="space-y-1">
              <h2 className="text-base font-semibold">Save your recovery key</h2>
              <p className="text-[13px] leading-relaxed text-muted">
                If you forget your password, this key and your email set a new one. {APP_NAME} can't email you a reset link,
                so keep it somewhere safe, like a password manager or a note. It's shown only this once.
              </p>
            </div>
          </div>

          <output
            aria-label="Recovery key"
            className="block rounded-2xl border border-line bg-surface-2 px-4 py-3 text-center font-mono text-[15px] font-semibold tracking-wider break-all text-fg select-all sm:text-base"
          >
            {key}
          </output>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void copy()}>
              {copied === 'yes' ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
              {copied === 'yes' ? 'Copied' : 'Copy'}
            </Button>
            <Button size="sm" onClick={download}>
              <Download className="size-3.5" aria-hidden /> Download
            </Button>
          </div>
          {copied === 'failed' && (
            <p role="alert" className="text-xs text-amber-800 dark:text-amber-300">
              Couldn't copy it here: select the key above and copy it yourself, or download it.
            </p>
          )}

          <label className="flex items-start gap-2.5 text-[13px] leading-relaxed">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-accent"
            />
            <span>I've saved my recovery key</span>
          </label>

          <Button variant="primary" className="w-full" disabled={!saved} onClick={done}>
            Done
          </Button>
          <p className="text-center text-[11px] leading-relaxed text-faint">
            Lost it later? Make a new one in Settings → Profile while you're signed in (it asks for your password).
          </p>
        </div>
      )}
    </Modal>
  )
}
