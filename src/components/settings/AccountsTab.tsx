import { useState, type FormEvent } from 'react'
import { ExternalLink, Loader2, RotateCcw, Zap } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { NetworkIcon } from '@/components/ui/NetworkIcon'
import { Switch } from '@/components/ui/Switch'
import type { ConnectorId, ConnectorStatus } from '@/data/api'
import { useAsyncAction as useAsync } from '@/hooks/useAsyncAction'
import { cn } from '@/lib/cn'
import {
  applyConnectorFix,
  connectMatrix,
  connectTelegram,
  disconnectAccount,
  resetDemo,
  setDemoShown,
  simulateIncoming,
} from '@/store/actions'
import { hasRealAccount, useConnections } from '@/store/connections'
import { Card, CardHeader, ErrorText, Field, Input, SectionTitle, StatusPill } from './parts'

export function AccountsTab({ close }: { close(): void }) {
  const connections = useConnections()
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionTitle>Your accounts</SectionTitle>
        <TelegramCard status={connections.telegram} />
        <MatrixCard status={connections.matrix} />
        <p className="text-xs leading-relaxed text-muted">
          Messages travel directly between this browser and your accounts, and are kept in this browser's storage.
          Tokens are stored here too: anyone with access to this browser profile could read them.
        </p>
      </section>

      <section className="space-y-3">
        <SectionTitle>Demo</SectionTitle>
        <DemoCard shown={connections.demo} hasAccounts={hasRealAccount(connections)} close={close} />
      </section>
    </div>
  )
}

/* ── Telegram ──────────────────────────────────────────────────────────────── */

function TelegramCard({ status }: { status: ConnectorStatus | null }) {
  const [token, setToken] = useState('')
  const [apiBase, setApiBase] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const { busy, error, run } = useAsync()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await connectTelegram(token, apiBase || undefined)
      setToken('')
    })
  }

  return (
    <Card>
      <CardHeader
        icon={<NetworkIcon network="telegram" className="size-5" />}
        title={status?.account ? `Telegram bot · ${status.account}` : 'Telegram bot'}
        aside={status && <StatusPill status={status} />}
      >
        People message your bot, or a group it's in, and you reply as the bot. Telegram keeps undelivered messages for
        24 hours, so chats arrive even if Tidings was closed.
      </CardHeader>

      {status ? (
        <ConnectedFooter id="telegram" status={status} />
      ) : (
        <form onSubmit={submit} className="mt-4 space-y-3">
          <Field
            label="Bot token"
            hint={
              <>
                Create a bot with{' '}
                <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-accent-ink hover:underline">
                  @BotFather <ExternalLink className="inline size-3" aria-hidden />
                </a>{' '}
                and paste the token it gives you. To read group chats, turn off its privacy mode there too.
              </>
            }
          >
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              placeholder="123456789:AA…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
          {advanced ? (
            <Field label="Bot API server" hint="Only if you run your own telegram-bot-api server.">
              <Input
                type="url"
                placeholder="https://api.telegram.org"
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
              />
            </Field>
          ) : (
            <button type="button" onClick={() => setAdvanced(true)} className="block text-xs text-muted hover:text-fg">
              Use a different Bot API server…
            </button>
          )}
          {error && <ErrorText>{error}</ErrorText>}
          <Button type="submit" variant="primary" size="sm" disabled={busy || !token.trim()}>
            {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Connect bot
          </Button>
        </form>
      )}
    </Card>
  )
}

/* ── Matrix ────────────────────────────────────────────────────────────────── */

function MatrixCard({ status }: { status: ConnectorStatus | null }) {
  const [homeserver, setHomeserver] = useState('')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [method, setMethod] = useState<'password' | 'token'>('password')
  const { busy, error, run } = useAsync()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await connectMatrix(
        method === 'password' ? { homeserver, user, password } : { homeserver, accessToken },
      )
      setPassword('')
      setAccessToken('')
    })
  }

  return (
    <Card>
      <CardHeader
        icon={<NetworkIcon network="matrix" className="size-5" />}
        title={status?.account ? `Matrix · ${status.account}` : 'Matrix'}
        aside={status && <StatusPill status={status} />}
      >
        Your Matrix rooms, plus everything your homeserver bridges: WhatsApp, Instagram, Slack, Google Messages (SMS) and
        Telegram show up under their own network, and replies go out there.
      </CardHeader>

      {status ? (
        <ConnectedFooter id="matrix" status={status} />
      ) : (
        <form onSubmit={submit} className="mt-4 space-y-3">
          <Field label="Homeserver" hint="Your server's domain or address, like matrix.example.org.">
            <Input
              required={method === 'token'}
              placeholder="matrix.example.org"
              autoComplete="url"
              spellCheck={false}
              value={homeserver}
              onChange={(e) => setHomeserver(e.target.value)}
            />
          </Field>

          <div role="radiogroup" aria-label="Sign in with" className="inline-flex rounded-xl bg-surface-2 p-0.5 text-xs">
            {(['password', 'token'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={method === m}
                onClick={() => setMethod(m)}
                className={cn(
                  'rounded-[10px] px-3 py-1.5 font-medium transition-colors',
                  method === m ? 'bg-pill text-fg shadow-pill' : 'text-muted hover:text-fg',
                )}
              >
                {m === 'password' ? 'Password' : 'Access token'}
              </button>
            ))}
          </div>

          {method === 'password' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Username">
                <Input
                  required
                  autoComplete="username"
                  spellCheck={false}
                  placeholder="@you:example.org"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                />
              </Field>
              <Field label="Password">
                <Input
                  required
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            </div>
          ) : (
            <Field
              label="Access token"
              hint="From another Matrix app's settings (in Element: Help & About). Tidings won't sign that session out."
            >
              <Input
                required
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
              />
            </Field>
          )}
          <p className="text-[11px] leading-relaxed text-faint">
            End-to-end encrypted rooms aren't supported yet: their messages show as locked. Servers that only allow
            single sign-on need the access-token option.
          </p>
          {error && <ErrorText>{error}</ErrorText>}
          <Button type="submit" variant="primary" size="sm" disabled={busy}>
            {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Connect Matrix
          </Button>
        </form>
      )}
    </Card>
  )
}

/* ── Shared ────────────────────────────────────────────────────────────────── */

function ConnectedFooter({ id, status }: { id: ConnectorId; status: ConnectorStatus }) {
  const fix = useAsync()
  const disconnect = useAsync()
  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      {status.detail && (
        <p className={cn('text-xs leading-relaxed', status.state === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-muted')}>
          {status.detail}
        </p>
      )}
      {fix.error && <ErrorText>{fix.error}</ErrorText>}
      <div className="flex flex-wrap gap-2">
        {status.fix && (
          <Button
            size="sm"
            variant="primary"
            disabled={fix.busy}
            onClick={() => void fix.run(() => applyConnectorFix(id, status.fix!.id))}
          >
            {status.fix.label}
          </Button>
        )}
        <Button
          size="sm"
          disabled={disconnect.busy}
          onClick={() => {
            if (window.confirm('Disconnect this account? Its chats are removed from this device.')) {
              void disconnect.run(() => disconnectAccount(id))
            }
          }}
        >
          Disconnect
        </Button>
      </div>
    </div>
  )
}

function DemoCard({ shown, hasAccounts, close }: { shown: boolean; hasAccounts: boolean; close(): void }) {
  return (
    <Card>
      <CardHeader
        icon={<Zap className="size-4 text-accent-ink" aria-hidden />}
        title="Demo chats"
        aside={<Switch checked={shown} onChange={(on) => void setDemoShown(on)} label="Show demo chats" />}
      >
        Fifteen sample conversations across five networks, generated relative to now.
        {hasAccounts && shown && ' Turn them off to see only your own chats.'}
      </CardHeader>
      {shown && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
          <Button
            size="sm"
            onClick={() => {
              close()
              void simulateIncoming()
            }}
          >
            <Zap className="size-3.5" aria-hidden /> Simulate incoming message
          </Button>
          <Button
            size="sm"
            onClick={() => {
              if (window.confirm('Reset the demo? Its conversations are regenerated, and your replies and tasks in them are cleared.')) {
                close()
                void resetDemo()
              }
            }}
          >
            <RotateCcw className="size-3.5" aria-hidden /> Reset demo
          </Button>
        </div>
      )}
    </Card>
  )
}
