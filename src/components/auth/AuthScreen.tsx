import { useState, type FormEvent } from 'react'
import { ArrowRight, Eye, EyeOff, Loader2 } from 'lucide-react'
import { Field, Input, ErrorText } from '@/components/settings/parts'
import { Button } from '@/components/ui/Button'
import { NetworkIcon } from '@/components/ui/NetworkIcon'
import { LogoMark } from '@/components/layout/LogoMark'
import { Wallpaper } from '@/components/layout/Wallpaper'
import { APP_NAME } from '@/config'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { cn } from '@/lib/cn'
import { createAccount, signIn, signInWithGoogle } from '@/store/actions'
import { useSession } from '@/store/session'
import { GoogleButton } from './GoogleButton'

type Mode = 'sign-in' | 'create'

/** Sign in or create an account: with Google, or with an email and password. */
export function AuthScreen() {
  const features = useSession((s) => s.features)
  const notice = useSession((s) => s.notice)
  const [mode, setMode] = useState<Mode>('sign-in')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const form = useAsyncAction()
  const google = useAsyncAction()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void form.run(() => (mode === 'create' ? createAccount(name.trim(), email.trim(), password) : signIn(email.trim(), password)))
  }

  const switchMode = (next: Mode) => {
    setMode(next)
    setPassword('')
    form.reset()
    google.reset()
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <Wallpaper />
      <main className="glass-thick glass-edge relative w-full max-w-[380px] rounded-3xl p-6 shadow-pop sm:p-7">
        <div className="flex flex-col items-center text-center">
          <LogoMark className="size-11" />
          <h1 className="mt-3 text-xl font-semibold tracking-tight">
            {mode === 'create' ? `Create your ${APP_NAME} account` : `Sign in to ${APP_NAME}`}
          </h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
            One inbox for your WhatsApp and Telegram chats, with AI that sorts them and drafts replies.
          </p>
          <div className="mt-3 flex items-center gap-1.5" aria-hidden>
            <NetworkIcon network="whatsapp" className="size-5" />
            <NetworkIcon network="telegram" className="size-5" />
          </div>
        </div>

        {notice && (
          <p role="status" className="mt-5 rounded-xl bg-accent-soft px-3 py-2 text-xs leading-relaxed text-accent-ink">
            {notice}
          </p>
        )}

        {features?.storage === 'temporary' && (
          <p className="mt-5 rounded-xl bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
            <b className="font-semibold">Temporary storage.</b> This server's database isn't connected yet, so accounts made
            now last until it restarts. They move to the database by themselves once it connects.
          </p>
        )}

        {features?.googleClientId && (
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
          <Field label="Password" hint={mode === 'create' ? 'At least 8 characters.' : undefined}>
            <PasswordInput
              value={password}
              onChange={setPassword}
              visible={showPassword}
              onToggle={() => setShowPassword(!showPassword)}
              autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
              minLength={mode === 'create' ? 8 : undefined}
            />
          </Field>
          {form.error && <ErrorText>{form.error}</ErrorText>}
          <Button type="submit" variant="primary" className="w-full" disabled={form.busy}>
            {form.busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {mode === 'create' ? 'Create account' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-5 text-center text-[13px] text-muted">
          {mode === 'create' ? 'Already have an account? ' : 'New here? '}
          <button
            type="button"
            className="font-medium text-accent-ink hover:underline"
            onClick={() => switchMode(mode === 'create' ? 'sign-in' : 'create')}
          >
            {mode === 'create' ? 'Sign in' : 'Create an account'}
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
