import { useRef, useState, type FormEvent } from 'react'
import { Camera, Loader2, LogOut, Trash2 } from 'lucide-react'
import { PasswordInput } from '@/components/auth/AuthScreen'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import type { PublicUser } from '@/data/server/types'
import { useAsyncAction as useAsync } from '@/hooks/useAsyncAction'
import { squareThumbnail } from '@/lib/image'
import { changeAvatar, changePassword, deleteAccount, makeRecoveryKey, renameUser, signOut } from '@/store/actions'
import { useSession } from '@/store/session'
import { Card, ErrorText, Field, Input, SectionTitle } from './parts'

export function ProfileTab() {
  const user = useSession((s) => s.user)
  const uploads = useSession((s) => !!s.features?.uploads)
  const leaving = useAsync()
  if (!user) return null

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionTitle>Profile</SectionTitle>
        <Card className="space-y-4">
          <div className="flex items-center gap-3.5">
            <Avatar name={user.name} seed={user.id} imageUrl={user.avatarUrl} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-xs text-muted">{user.email}</p>
            </div>
            {uploads && <PhotoButton />}
          </div>
          <NameForm user={user} />
        </Card>
      </section>

      <section className="space-y-3">
        <SectionTitle>Signing in</SectionTitle>
        <Card className="space-y-4">
          {user.google && (
            <p className="text-xs leading-relaxed text-muted">
              You can sign in with Google as <span className="font-medium text-fg">{user.email}</span>.
            </p>
          )}
          <PasswordForm hasPassword={user.hasPassword} />
          {user.hasPassword && <RecoveryKeyForm madeAt={user.recoveryKeyCreatedAt} />}
        </Card>
      </section>

      <section className="space-y-2">
        {leaving.error && <ErrorText>{leaving.error}</ErrorText>}
        <Button disabled={leaving.busy} onClick={() => void leaving.run(signOut)}>
          {leaving.busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <LogOut className="size-4" aria-hidden />}
          Sign out
        </Button>
        <p className="text-[11px] leading-relaxed text-faint">
          Signing out removes your chats from this browser. WhatsApp and Telegram stay linked and messages keep coming in,
          so they're all here when you sign in again. To stop that, unlink them in Accounts.
        </p>
      </section>

      <DeleteAccount user={user} />
    </div>
  )
}

/**
 * Deleting the account, for good: tucked away under a disclosure, and it takes the password (or,
 * for a Google-only account, the email typed out).
 */
function DeleteAccount({ user }: { user: PublicUser }) {
  const [proof, setProof] = useState('')
  const [visible, setVisible] = useState(false)
  const removing = useAsync()
  const ready = user.hasPassword ? proof.length > 0 : proof.trim().toLowerCase() === user.email.toLowerCase()
  return (
    <section className="space-y-2 border-t border-line pt-5">
      <details className="group">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-rose-600 select-none hover:underline dark:text-rose-400">
          <Trash2 className="size-4" aria-hidden /> Delete account
        </summary>
        <form
          className="mt-3 space-y-3 rounded-2xl border border-rose-500/25 bg-rose-500/5 p-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            void removing.run(() => deleteAccount(user.hasPassword ? { current: proof } : { confirm: proof }))
          }}
        >
          <p className="text-[13px] leading-relaxed text-muted">
            This deletes your Sytext account for good: WhatsApp, Telegram, Instagram and Guffshuff are signed out and
            unlinked, and every chat, message, contact and task kept for you is deleted. Your chats stay on the apps
            themselves. It can't be undone.
          </p>
          {user.hasPassword ? (
            <Field label="Your password, to confirm">
              <PasswordInput value={proof} onChange={setProof} visible={visible} onToggle={() => setVisible(!visible)} autoComplete="current-password" />
            </Field>
          ) : (
            <Field label={`Type ${user.email} to confirm`}>
              <Input autoComplete="off" spellCheck={false} value={proof} onChange={(e) => setProof(e.target.value)} />
            </Field>
          )}
          {removing.error && <ErrorText>{removing.error}</ErrorText>}
          <Button type="submit" size="sm" disabled={!ready || removing.busy} className="bg-rose-600 text-white hover:bg-rose-700">
            {removing.busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Trash2 className="size-3.5" aria-hidden />}
            Delete my account
          </Button>
        </form>
      </details>
    </section>
  )
}

function NameForm({ user }: { user: PublicUser }) {
  const [name, setName] = useState(user.name)
  const save = useAsync()
  const changed = name.trim() !== user.name && name.trim() !== ''
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e: FormEvent) => {
        e.preventDefault()
        void save.run(() => renameUser(name.trim()))
      }}
    >
      <div className="min-w-0 flex-1">
        <Field label="Name" hint={save.error ?? 'Used when AI drafts replies for you.'}>
          <Input required maxLength={80} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
      {changed && (
        <Button type="submit" size="sm" variant="primary" disabled={save.busy} className="mb-[22px]">
          {save.busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Save
        </Button>
      )}
    </form>
  )
}

function PhotoButton() {
  const input = useRef<HTMLInputElement>(null)
  const upload = useAsync()
  return (
    <div className="flex flex-col items-end gap-1">
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void upload.run(async () => changeAvatar(await squareThumbnail(file)))
        }}
      />
      <Button size="sm" disabled={upload.busy} onClick={() => input.current?.click()}>
        {upload.busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Camera className="size-3.5" aria-hidden />}
        Photo
      </Button>
      {upload.error && <span className="max-w-40 text-right text-[11px] text-rose-600 dark:text-rose-400">{upload.error}</span>}
    </div>
  )
}

function PasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const save = useAsync()
  return (
    <form
      className="space-y-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault()
        void save.run(async () => {
          await changePassword(password, hasPassword ? current : undefined)
          setCurrent('')
          setPassword('')
        })
      }}
    >
      {hasPassword && (
        <Field label="Current password">
          <PasswordInput
            value={current}
            onChange={setCurrent}
            visible={visible}
            onToggle={() => setVisible(!visible)}
            autoComplete="current-password"
          />
        </Field>
      )}
      <Field
        label={hasPassword ? 'New password' : 'Password'}
        hint={
          hasPassword
            ? 'At least 8 characters. Other devices are signed out.'
            : 'Set one to sign in with your email too. At least 8 characters.'
        }
      >
        <PasswordInput
          value={password}
          onChange={setPassword}
          visible={visible}
          onToggle={() => setVisible(!visible)}
          autoComplete="new-password"
          minLength={8}
        />
      </Field>
      {save.error && <ErrorText>{save.error}</ErrorText>}
      <Button type="submit" size="sm" variant="primary" disabled={save.busy || password.length < 8}>
        {save.busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        {hasPassword ? 'Change password' : 'Set password'}
      </Button>
    </form>
  )
}

/** The recovery key resets a forgotten password; a new one replaces it (say, if it was lost). */
function RecoveryKeyForm({ madeAt }: { madeAt: string | undefined }) {
  const [current, setCurrent] = useState('')
  const [visible, setVisible] = useState(false)
  const make = useAsync()
  const made = madeAt ? new Date(madeAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : null
  return (
    <form
      className="space-y-3 border-t border-line pt-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault()
        void make.run(async () => {
          await makeRecoveryKey(current)
          setCurrent('')
        })
      }}
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">Recovery key</p>
        <p className="text-xs leading-relaxed text-muted">
          {made
            ? `Resets your password if you forget it, together with your email. Yours was made on ${made}. Lost it? Make a new one: the old one stops working.`
            : "You don't have one yet. It resets your password if you forget it, together with your email."}
        </p>
      </div>
      <Field label="Current password">
        <PasswordInput
          value={current}
          onChange={setCurrent}
          visible={visible}
          onToggle={() => setVisible(!visible)}
          autoComplete="current-password"
        />
      </Field>
      {make.error && <ErrorText>{make.error}</ErrorText>}
      <Button type="submit" size="sm" disabled={make.busy || !current}>
        {make.busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        {made ? 'Make a new recovery key' : 'Make a recovery key'}
      </Button>
    </form>
  )
}
