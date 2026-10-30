import { useState, type FormEvent } from 'react'
import { ArrowRight, Eye, EyeOff, Loader2 } from 'lucide-react'
import { DatabaseHelp } from '@/components/settings/DatabaseHelp'
import { Field, Input, ErrorText } from '@/components/settings/parts'
import { Button } from '@/components/ui/Button'
import { NetworkIcon } from '@/components/ui/NetworkIcon'
import { LogoMark } from '@/components/layout/LogoMark'
import { Wallpaper } from '@/components/layout/Wallpaper'
import { APP_NAME } from '@/config'
import type { NetworkId } from '@/data/types'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { cn } from '@/lib/cn'
import { NETWORKS } from '@/lib/networks'
import { createAccount, recoverAccount, signIn, signInWithGoogle } from '@/store/actions'
import { DATABASE_RECHECK_MS, useSession } from '@/store/session'
import { GoogleButton } from './GoogleButton'

type Mode = 'sign-in' | 'create' | 'recover'

const TITLES: Record<Mode, string> = {
  'sign-in': `Sign in to ${APP_NAME}`,
  create: `Create your ${APP_NAME} account`,
  recover: 'Reset your password',
}

/**
 * Sign in or create an account: with Google, or with an email and password. A forgotten password
 * is reset with the recovery key given at sign-up.
 */
export function AuthScreen() {
  const features = useSession((s) => s.features)
  const notice = useSession((s) => s.notice)
  const [mode, setMode] = useState<Mode>('sign-in')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  const form = useAsyncAction()
  const google = useAsyncAction()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void form.run(() =>
      mode === 'create'
        ? createAccount(name.trim(), email.trim(), password, acceptedTerms)
        : mode === 'recover'
          ? recoverAccount(email.trim(), recoveryKey, password)
          : signIn(email.trim(), password),
    )
  }

  const switchMode = (next: Mode) => {
    setMode(next)
    setPassword('')
    setRecoveryKey('')
    form.reset()
    google.reset()
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <Wallpaper />
      <main className="glass-thick glass-edge relative w-full max-w-[380px] rounded-3xl p-6 shadow-pop sm:p-7">
        <div className="flex flex-col items-center text-center">
          <LogoMark className="size-11" />
          <h1 className="mt-3 text-xl font-semibold tracking-tight">{TITLES[mode]}</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
            {mode === 'recover'
              ? 'Enter your email, the recovery key you saved when you made your account, and a new password.'
              : 'Every chat app in one inbox, with AI that sorts your chats and drafts the replies.'}
          </p>
          {mode !== 'recover' && <Networks />}
        </div>

        {notice && (
          <p role="status" className="mt-5 rounded-xl bg-accent-soft px-3 py-2 text-xs leading-relaxed text-accent-ink">
            {notice}
          </p>
        )}

        {features?.storage === 'temporary' && (
          <div className="mt-5 rounded-xl bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
            <p>
              <b className="font-semibold">Temporary storage.</b> This server's database isn't connected yet, so accounts made
              now last until it restarts. They move to the database by themselves once it connects, and this note goes away
              (it checks every {DATABASE_RECHECK_MS / 1000} seconds).
            </p>
            <details className="mt-1.5">
              <summary className="cursor-pointer font-medium">Why, and how to fix it</summary>
              <div className="mt-2 text-left">
                <DatabaseHelp problem={features.databaseProblem} />
              </div>
            </details>
          </div>
        )}

        {features?.googleClientId && mode !== 'recover' && (
          <div className="mt-6 space-y-2">
            <GoogleButton clientId={features.googleClientId} onCredential={(credential) => void google.run(() => signInWithGoogle(credential))} />
            {google.busy && (
              <p className="flex items-center justify-center gap-1.5 text-xs text-muted">
                <Loader2 className="size-3.5 animate-spin" aria-hidden /> Signing in…
              </p>
            )}
            {google.error && <ErrorText>{google.error}</ErrorText>}
            <div className="flex items-center gap-3 pt-2 text-[11px] font-medium tracking-wider text-faint uppercase">
              <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
            </div>
          </div>
        )}

        <form onSubmit={submit} className={cn('space-y-3', features?.googleClientId ? 'mt-3' : 'mt-6')}>
          {mode === 'create' && (
            <Field label="Your name">
              <Input required autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          )}
          <Field label="Email">
            <Input
              required
              type="email"
              autoComplete="email"
              inputMode="email"
              spellCheck={false}
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          {mode === 'recover' && (
            <Field label="Recovery key" hint="Five groups of five letters and numbers, like 7K2QP-M9XHD-…">
              <Input
                required
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={64}
                placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
                className="font-mono tracking-wide uppercase placeholder:normal-case"
                value={recoveryKey}
                onChange={(e) => setRecoveryKey(e.target.value)}
              />
            </Field>
          )}
          <Field
            label={mode === 'recover' ? 'New password' : 'Password'}
            hint={mode === 'sign-in' ? undefined : 'At least 8 characters.'}
          >
            <PasswordInput
              value={password}
              onChange={setPassword}
              visible={showPassword}
              onToggle={() => setShowPassword(!showPassword)}
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              minLength={mode === 'sign-in' ? undefined : 8}
            />
          </Field>
          {mode === 'sign-in' && (
            <div className="-mt-1 flex justify-end">
              <button type="button" className="text-xs font-medium text-accent-ink hover:underline" onClick={() => switchMode('recover')}>
                Forgot password?
              </button>
            </div>
          )}
          {mode === 'create' && (
            <label className="flex items-start gap-2.5 text-[13px] leading-snug text-muted">
              <input
                type="checkbox"
                required
                checked={acceptedTerms}
                onChange={(e) => setAcceptedTerms(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
              />
              <span>
                I have read and agree to the{' '}
                <a href="/terms" target="_blank" rel="noopener" className="font-medium text-accent-ink hover:underline">
                  Terms &amp; Conditions
                </a>{' '}
                and the{' '}
                <a href="/privacy" target="_blank" rel="noopener" className="font-medium text-accent-ink hover:underline">
                  Privacy Policy
                </a>
                .
              </span>
            </label>
          )}
          {form.error && <ErrorText>{form.error}</ErrorText>}
          <Button type="submit" variant="primary" className="w-full" disabled={form.busy || (mode === 'create' && !acceptedTerms)}>
            {form.busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {mode === 'create' ? 'Create account' : mode === 'recover' ? 'Reset password' : 'Sign in'}
          </Button>
        </form>

        {mode === 'recover' && (
          <p className="mt-4 text-[11px] leading-relaxed text-faint">
            No recovery key? Then a forgotten password can't be reset here: Sytext can't email you a link. If you sign in
            with Google, use Continue with Google instead. Once you're back in, make a key in Settings → Profile.
          </p>
        )}

        {features?.googleClientId && mode !== 'recover' && (
          <p className="mt-4 text-center text-[11px] leading-relaxed text-faint">
            Continuing with Google means you agree to the{' '}
            <a href="/terms" target="_blank" rel="noopener" className="underline hover:text-muted">
              Terms
            </a>{' '}
            and{' '}
            <a href="/privacy" target="_blank" rel="noopener" className="underline hover:text-muted">
              Privacy Policy
            </a>
            .
          </p>
        )}

        <p className="mt-5 text-center text-[13px] text-muted">
          {mode === 'sign-in' ? 'New here? ' : mode === 'create' ? 'Already have an account? ' : 'Remembered it? '}
          <button
            type="button"
            className="font-medium text-accent-ink hover:underline"
            onClick={() => switchMode(mode === 'sign-in' ? 'create' : 'sign-in')}
          >
            {mode === 'sign-in' ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </main>

      <button
        type="button"
        onClick={() => useSession.getState().continueAsGuest()}
        className="relative mt-5 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] text-muted transition-colors hover:text-fg"
      >
        Try the demo without an account <ArrowRight className="size-3.5" aria-hidden />
      </button>
    </div>
  )
}

/** The chat apps Sytext brings together: every one, not just two. */
const SHOWN_NETWORKS: NetworkId[] = ['whatsapp', 'telegram', 'instagram', 'guffshuff', 'matrix', 'slack', 'sms']

function Networks() {
  return (
    <div className="mt-3.5 flex flex-col items-center gap-1.5">
      <ul className="flex items-center gap-1.5" aria-label={`Works with ${SHOWN_NETWORKS.map((n) => NETWORKS[n].name).join(', ')} and more`}>
        {SHOWN_NETWORKS.map((n) => (
          <li key={n} title={NETWORKS[n].name}>
            <NetworkIcon network={n} className="size-6" />
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-faint" aria-hidden>
        WhatsApp, Telegram, Instagram, Matrix bridges and more
      </p>
    </div>
  )
}

export function PasswordInput({
  value,
  onChange,
  visible,
  onToggle,
  ...props
}: {
  value: string
  onChange(value: string): void
  visible: boolean
  onToggle(): void
  autoComplete: string
  minLength?: number
  id?: string
  'aria-describedby'?: string
}) {
  return (
    <div className="relative">
      <Input
        {...props}
        required
        type={visible ? 'text' : 'password'}
        maxLength={200}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pr-10"
      />
      <button
        type="button"
        onClick={onToggle}
        aria-label={visible ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 grid w-10 place-items-center text-faint hover:text-fg"
      >
        {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </button>
    </div>
  )
}
