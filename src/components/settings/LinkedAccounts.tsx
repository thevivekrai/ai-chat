import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { AlertTriangle, Check, Copy, Loader2, LogIn } from 'lucide-react'
import { PasswordInput } from '@/components/auth/AuthScreen'
import { Button } from '@/components/ui/Button'
import { NetworkIcon } from '@/components/ui/NetworkIcon'
import { api, type PublicAccount } from '@/data/api'
import type { WhatsAppLinkResult } from '@/data/server/types'
import { useAsyncAction as useAsync } from '@/hooks/useAsyncAction'
import { cn } from '@/lib/cn'
import { linkedNetworkConnected, unlinkNetwork } from '@/store/actions'
import { useConnections } from '@/store/connections'
import { useSession } from '@/store/session'
import { Card, CardHeader, ErrorText, Field, Input } from './parts'

/**
 * WhatsApp and Telegram, linked as the user's own accounts on the Sytext server: WhatsApp with a
 * code (or QR) from the phone, the way WhatsApp Web links; Telegram with the phone number, a login
 * code and, if set, the two-step password.
 */
export function LinkedAccounts() {
  const status = useSession((s) => s.status)
  const features = useSession((s) => s.features)
  const server = useConnections((s) => s.server)

  if (status !== 'signed-in') {
    return (
      <Card>
        <CardHeader icon={<LinkIcons />} title="WhatsApp and Telegram">
          Sign in to link your own WhatsApp and Telegram. Your chats then sync to this inbox on any device you sign in on.
        </CardHeader>
        <div className="mt-3 border-t border-line pt-3">
          <Button size="sm" variant="primary" onClick={() => useSession.getState().showSignIn()}>
            <LogIn className="size-3.5" aria-hidden /> Sign in
          </Button>
        </div>
      </Card>
    )
  }

  return (
    <>
      <WhatsAppCard account={server?.whatsapp ?? null} />
      <TelegramCard account={server?.telegram ?? null} enabled={!!features?.telegram} />
      <p className="text-xs leading-relaxed text-muted">
        Linked chats sync through the Sytext server, which keeps them encrypted at rest, so they're there on every device
        you sign in on. Unlinking logs the server out and deletes them.
      </p>
    </>
  )
}

function LinkIcons() {
  return (
    <span className="flex -space-x-1">
      <NetworkIcon network="whatsapp" className="size-5 ring-2 ring-surface-solid" />
      <NetworkIcon network="telegram" className="size-5 ring-2 ring-surface-solid" />
    </span>
  )
}

/* ── WhatsApp ──────────────────────────────────────────────────────────────── */

function WhatsAppCard({ account }: { account: PublicAccount | null }) {
  const [method, setMethod] = useState<'code' | 'qr'>('code')
  const [phone, setPhone] = useState('')
  const [result, setResult] = useState<WhatsAppLinkResult | null>(null)
  const link = useAsync()
  const cancel = useAsync()
  const status = account?.status ?? null
  const showingQr = !!result && 'qr' in result

  // The QR code changes every so often until it's scanned.
  useEffect(() => {
    if (!showingQr) return
    return api.connections.onWhatsAppQr((qr) => setResult({ qr }))
  }, [showingQr])

  useLinkedOnce('whatsapp', status, () => setResult(null))
  // Linking stopped (timed out, or closed on the phone): back to the start, with the reason shown.
  const [seenStatus, setSeenStatus] = useState(status)
  if (status !== seenStatus) {
    setSeenStatus(status)
    if (status === 'disconnected' || status === null) setResult(null)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void link.run(async () => {
      setResult(await api.connections.linkWhatsApp(method === 'qr' ? { method } : { method, phone }))
    })
  }

  const linked = status === 'connected' || status === 'error'
  return (
    <Card>
      <CardHeader
        icon={<NetworkIcon network="whatsapp" className="size-5" />}
        title={linked && account?.label ? `WhatsApp · ${account.label}` : 'WhatsApp'}
        aside={account && <LinkStatusPill account={account} />}
      >
        {linked
          ? 'Linked as a device of your WhatsApp, like WhatsApp Web. New messages arrive while the server is running.'
          : 'Link your WhatsApp the way WhatsApp Web links: with a code from your phone. Your chats and replies then go through Sytext.'}
      </CardHeader>

      {linked ? (
        <LinkedFooter account={account!} network="whatsapp" />
      ) : result ? (
        <div className="mt-4 space-y-4 border-t border-line pt-4">
          {'code' in result ? <PairingCode code={result.code} /> : <QrCode qr={result.qr} />}
          <WaitingLine>{account?.detail ?? 'Waiting for your phone…'}</WaitingLine>
          {cancel.error && <ErrorText>{cancel.error}</ErrorText>}
          <Button
            size="sm"
            disabled={cancel.busy}
            onClick={() =>
              void cancel.run(async () => {
                await api.connections.unlink('whatsapp')
                setResult(null)
              })
            }
          >
            Cancel
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-4 space-y-3">
          <Segmented
            label="Link with"
            value={method}
            options={[
              { id: 'code' as const, label: 'Phone number' },
              { id: 'qr' as const, label: 'QR code' },
            ]}
            onChange={(next) => setMethod(next)}
          />
          {method === 'code' && (
            <Field label="Your WhatsApp number" hint="With the country code. WhatsApp shows a notification on this phone.">
              <Input
                required
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="+91 98765 43210"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
          )}
          {account?.status === 'disconnected' && <StoppedNote account={account} network="whatsapp" />}
          <Warning>
            WhatsApp doesn't support unofficial apps and can restrict numbers that use them. Sytext links the same way
            WhatsApp Web does, but use a number you're comfortable with.
          </Warning>
          {link.error && <ErrorText>{link.error}</ErrorText>}
          <Button type="submit" variant="primary" size="sm" disabled={link.busy || (method === 'code' && !phone.trim())}>
            {link.busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {method === 'code' ? 'Get code' : 'Show QR code'}
          </Button>
        </form>
      )}
    </Card>
  )
}

function PairingCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <output
          aria-label="Pairing code"
          className="rounded-2xl border border-line bg-surface-2 px-4 py-2.5 font-mono text-2xl font-semibold tracking-[0.2em] text-fg"
        >
          {code}
        </output>
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(code.replace('-', '')).then(() => setCopied(true))
            setTimeout(() => setCopied(false), 2000)
          }}
        >
          {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <Steps>
        <li>Open WhatsApp on your phone.</li>
        <li>
          Go to <b>Settings → Linked devices → Link a device</b>.
        </li>
        <li>
          Tap <b>Link with phone number instead</b> and enter this code.
        </li>
      </Steps>
    </div>
  )
}

function QrCode({ qr }: { qr: string }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <img src={qr} alt="QR code to link WhatsApp" className="size-48 shrink-0 rounded-2xl bg-white p-2 shadow-card" />
      <Steps>
        <li>Open WhatsApp on your phone.</li>
        <li>
          Go to <b>Settings → Linked devices → Link a device</b>.
        </li>
        <li>Point your phone at this code.</li>
      </Steps>
    </div>
  )
}

/* ── Telegram ──────────────────────────────────────────────────────────────── */

type TelegramStep = 'phone' | 'code' | 'password'

function TelegramCard({ account, enabled }: { account: PublicAccount | null; enabled: boolean }) {
  const status = account?.status ?? null
  // Picks up where a sign-in left off, say after a reload.
  const resumeStep = (): TelegramStep =>
    status === 'linking' ? (account?.detail?.includes('password') ? 'password' : 'code') : 'phone'
  const [step, setStep] = useState<TelegramStep>(resumeStep)
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const [via, setVia] = useState<'app' | 'sms'>('app')
  const action = useAsync()

  useLinkedOnce('telegram', status, () => {
    setStep('phone')
    setCode('')
    setPassword('')
  })
  // The code expired, or the sign-in was cancelled elsewhere: back to the start.
  const [seenStatus, setSeenStatus] = useState(status)
  if (status !== seenStatus) {
    setSeenStatus(status)
    if (status === 'disconnected' || status === null) setStep('phone')
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void action.run(async () => {
      if (step === 'phone') {
        const result = await api.connections.requestTelegramCode(phone)
        setVia(result.via)
        setStep('code')
      } else {
        const result =
          step === 'code' ? await api.connections.verifyTelegramCode(code) : await api.connections.verifyTelegramPassword(password)
        if (result.status === 'password') {
          setHint(result.hint ?? null)
          setStep('password')
        }
      }
    })
  }

  const linked = status === 'connected' || status === 'error'
  return (
    <Card>
      <CardHeader
        icon={<NetworkIcon network="telegram" className="size-5" />}
        title={linked && account?.label ? `Telegram · ${account.label}` : 'Telegram'}
        aside={account && <LinkStatusPill account={account} />}
      >
        {linked
          ? 'Signed in as you, like Telegram on a new device. It shows in Telegram under Settings → Devices.'
          : 'Sign in with your phone number and the code Telegram sends you. Your own chats and groups come in, and you reply as yourself.'}
      </CardHeader>

      {linked ? (
        <LinkedFooter account={account!} network="telegram" />
      ) : !enabled ? (
        <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-muted">
          Not set up on this server yet: it needs an API id and hash from my.telegram.org (TELEGRAM_API_ID and
          TELEGRAM_API_HASH).
        </p>
      ) : (
        <form onSubmit={submit} className="mt-4 space-y-3">
          {step === 'phone' && (
            <Field label="Your Telegram number" hint="With the country code.">
              <Input
                required
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="+91 98765 43210"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
          )}
          {step === 'code' && (
            <Field
              label="Login code"
              hint={via === 'app' ? 'Telegram sent it to your Telegram app (look for a message from Telegram).' : 'Telegram sent it by SMS.'}
            >
              <Input
                required
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="12345"
                maxLength={12}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
          )}
          {step === 'password' && (
            <Field label="Two-step verification password" hint={hint ? `Your hint: ${hint}` : 'The password you set in Telegram → Privacy and Security.'}>
              <PasswordInput
                value={password}
                onChange={setPassword}
                visible={showPassword}
                onToggle={() => setShowPassword(!showPassword)}
                autoComplete="current-password"
              />
            </Field>
          )}
          {step === 'phone' && account?.status === 'disconnected' && <StoppedNote account={account} network="telegram" />}
          {action.error && <ErrorText>{action.error}</ErrorText>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={action.busy}>
              {action.busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              {step === 'phone' ? 'Send code' : step === 'code' ? 'Verify' : 'Sign in'}
            </Button>
            {step !== 'phone' && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setStep('phone')
                  setCode('')
                  setPassword('')
                  void api.connections.unlink('telegram').catch(() => undefined)
                }}
              >
                Start over
              </Button>
            )}
          </div>
        </form>
      )}
    </Card>
  )
}

/* ── Shared ────────────────────────────────────────────────────────────────── */

/** Runs once when an account finishes linking (not when the page opens on a linked account). */
function useLinkedOnce(network: 'whatsapp' | 'telegram', status: PublicAccount['status'] | null, then: () => void) {
  const previous = useRef(status)
  const callback = useRef(then)
  useEffect(() => {
    callback.current = then
  })
  useEffect(() => {
    if (previous.current === 'linking' && status === 'connected') {
      callback.current()
      linkedNetworkConnected(network)
    }
    previous.current = status
  }, [network, status])
}

const PILL: Record<PublicAccount['status'], { label: string; dot: string }> = {
  connected: { label: 'Connected', dot: 'bg-emerald-500' },
  linking: { label: 'Linking…', dot: 'bg-amber-400 animate-pulse' },
  error: { label: 'Needs attention', dot: 'bg-rose-500' },
  disconnected: { label: 'Not linked', dot: 'bg-slate-400' },
  unlinked: { label: 'Not linked', dot: 'bg-slate-400' },
}

function LinkStatusPill({ account }: { account: PublicAccount }) {
  const look = PILL[account.status]
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-muted">
      <span className={cn('size-1.5 rounded-full', look.dot)} aria-hidden />
      {look.label}
    </span>
  )
}

function LinkedFooter({ account, network }: { account: PublicAccount; network: 'whatsapp' | 'telegram' }) {
  const unlink = useAsync()
  const name = network === 'whatsapp' ? 'WhatsApp' : 'Telegram'
  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      {account.detail && (
        <p className={cn('flex items-center gap-1.5 text-xs leading-relaxed', account.status === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-muted')}>
          {account.detail.endsWith('…') && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />}
          {account.detail}
        </p>
      )}
      {unlink.error && <ErrorText>{unlink.error}</ErrorText>}
      <Button
        size="sm"
        disabled={unlink.busy}
        onClick={() => {
          if (window.confirm(`Unlink ${name}? Sytext logs out of it, and its chats are deleted from the server.`)) {
            void unlink.run(() => unlinkNetwork(network))
          }
        }}
      >
        {unlink.busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Unlink
      </Button>
    </div>
  )
}

/** Why an account isn't linked any more, and a way to remove what's left of it. */
function StoppedNote({ account, network }: { account: PublicAccount; network: 'whatsapp' | 'telegram' }) {
  const forget = useAsync()
  return (
    <div className="space-y-1.5">
      {account.detail && <p className="text-xs leading-relaxed text-muted">{account.detail}</p>}
      <button
        type="button"
        disabled={forget.busy}
        className="text-xs font-medium text-muted underline-offset-2 hover:text-fg hover:underline"
        onClick={() => {
          if (window.confirm('Remove this account and the chats synced from it?')) void forget.run(() => unlinkNetwork(network))
        }}
      >
        Remove its chats instead
      </button>
      {forget.error && <ErrorText>{forget.error}</ErrorText>}
    </div>
  )
}

function WaitingLine({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-2 text-xs text-muted">
      <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden /> {children}
    </p>
  )
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-muted marker:text-faint [&_b]:font-medium [&_b]:text-fg">
      {children}
    </ol>
  )
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
      <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { id: T; label: string }[]
  onChange(value: T): void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-xl bg-surface-2 p-0.5 text-xs">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'rounded-[10px] px-3 py-1.5 font-medium transition-colors',
            value === o.id ? 'bg-pill text-fg shadow-pill' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
