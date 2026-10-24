import { useId, useMemo, useState, type FormEvent } from 'react'
import { CheckCircle2, KeyRound, Loader2, ShieldCheck, Sparkles } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { isKeyProvider, KEY_PROVIDERS, keyProvider, testKey, type KeyProviderId } from '@/ai'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { NetworkIcon } from '@/components/ui/NetworkIcon'
import { Switch } from '@/components/ui/Switch'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { cn } from '@/lib/cn'
import { NETWORK_ORDER, NETWORKS } from '@/lib/networks'
import { setThreadAiAccess, turnOffAi, turnOnAi, updateAi } from '@/store/actions'
import { useAi } from '@/store/ai'
import { modelsOf, sharedAiAvailable, useAiEngine } from '@/store/aiEngine'
import { useInbox } from '@/store/inbox'
import { threadPicture } from '@/store/selectors'
import { useSession } from '@/store/session'
import { useSettings } from '@/store/settings'
import { Card, CardHeader, ErrorText, Field, Input, SectionTitle, Select } from './parts'

export function AiTab() {
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionTitle>AI engine</SectionTitle>
        <EngineCard />
      </section>
      <section className="space-y-3">
        <SectionTitle>Privacy</SectionTitle>
        <ConsentCard />
      </section>
    </div>
  )
}

type Option = { value: 'shared' | 'own' | 'demo'; title: string; detail: string; disabled?: boolean }

function EngineCard() {
  const ai = useSettings((s) => s.ai)
  const session = useSession((s) => s.status)
  const sharedOffered = useSession((s) => !!s.features?.ai)
  const sharedReady = useSession(sharedAiAvailable)
  const engine = useAiEngine()
  const problem = useAi((s) => s.problem)
  // The provider picked under "Your own API key", remembered while another option is on.
  const [ownProvider, setOwnProvider] = useState<KeyProviderId>(isKeyProvider(ai.choice) ? ai.choice : 'anthropic')
  const mode = ai.choice === 'shared' || ai.choice === 'demo' ? ai.choice : 'own'
  const provider = isKeyProvider(ai.choice) ? ai.choice : ownProvider

  const options: Option[] = [
    {
      value: 'shared',
      title: 'Shared AI · free',
      detail: sharedReady
        ? "Google's Gemini, run by this app's server. Nothing to set up."
        : sharedOffered
          ? 'Sign in to use it: Google’s Gemini, run by this app’s server.'
          : "This server doesn't offer a shared AI.",
      disabled: !sharedOffered,
    },
    { value: 'own', title: 'Your own API key', detail: 'Claude, Gemini, ChatGPT, OpenRouter, Groq, Mistral, DeepSeek, Grok or any OpenAI-compatible service.' },
    { value: 'demo', title: 'Built-in demo AI', detail: 'Works offline with simple rules; no chat leaves this device.' },
  ]

  const choose = (value: Option['value']) => updateAi({ choice: value === 'own' ? provider : value })

  return (
    <Card>
      <CardHeader
        icon={<Sparkles className="size-4 text-accent-ink" aria-hidden />}
        title={engine.kind === 'key' ? `${engine.name} · ${engine.model}` : engine.name}
        aside={
          engine.kind !== 'demo' && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
              <span className={cn('size-1.5 rounded-full', problem ? 'bg-rose-500' : 'bg-emerald-500')} aria-hidden />
              {problem ? 'Needs attention' : 'Ready'}
            </span>
          )
        }
      >
        {engine.kind === 'demo'
          ? ai.choice === 'demo'
            ? 'Priority, summaries, tasks, drafts and answers come from simple rules on this device.'
            : session === 'signed-in' || ai.choice !== 'shared'
              ? 'Using the built-in demo AI until the AI you chose below is ready.'
              : 'Using the built-in demo AI. Sign in for the free shared AI, or add your own key.'
          : 'Priority, summaries, tasks, drafts and answers come from this AI, for the chats you allow below.'}
      </CardHeader>

      {problem && engine.kind !== 'demo' && (
        <div className="mt-3">
          <ErrorText>{problem.message}</ErrorText>
        </div>
      )}

      <div role="radiogroup" aria-label="AI engine" className="mt-4 space-y-1.5 border-t border-line pt-4">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              'flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors',
              mode === o.value ? 'border-accent/40 bg-accent/5' : 'border-line',
              o.disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-surface-2',
            )}
          >
            <input
              type="radio"
              name="ai-engine"
              className="mt-0.5 size-4 accent-accent"
              checked={mode === o.value}
              disabled={o.disabled}
              onChange={() => choose(o.value)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{o.title}</span>
              <span className="block text-xs leading-relaxed text-muted">{o.detail}</span>
            </span>
          </label>
        ))}
      </div>

      {mode === 'own' && (
        <OwnKey
          provider={provider}
          onProvider={(id) => {
            setOwnProvider(id)
            updateAi({ choice: id })
          }}
        />
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-faint">
        Only the chats allowed below are sent, and only when a feature needs them. Your own keys are kept only in this
        browser and go straight to the provider.
      </p>
    </Card>
  )
}

function OwnKey({ provider, onProvider }: { provider: KeyProviderId; onProvider(id: KeyProviderId): void }) {
  const ai = useSettings((s) => s.ai)
  const preset = keyProvider(provider)
  const saved = ai.keys[provider]?.trim() ?? ''
  const { model, triageModel } = modelsOf(ai, provider)
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(ai.baseUrl)
  const [ok, setOk] = useState(false)
  const check = useAsyncAction()
  const listId = useId()

  const setModels = (patch: Partial<{ model: string; triageModel: string }>) =>
    updateAi({ models: { ...ai.models, [provider]: { model, triageModel, ...patch } } })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setOk(false)
    void check.run(async () => {
      const url = baseUrl.trim()
      if (provider === 'custom' && !/^https?:\/\//i.test(url)) throw new Error('Enter the service’s address, starting with https://')
      if (!model) throw new Error('Enter the model to use.')
      await testKey(provider, key, model, provider === 'custom' ? url : undefined)
      updateAi({ keys: { ...ai.keys, [provider]: key.trim() }, ...(provider === 'custom' ? { baseUrl: url } : {}) })
      setKey('')
      setOk(true)
    })
  }

  return (
    <div className="mt-4 space-y-3 border-t border-line pt-4">
      <Field label="Provider">
        <Select
          value={provider}
          onChange={(e) => {
            setOk(false)
            check.reset()
            onProvider(e.target.value as KeyProviderId)
          }}
        >
          {KEY_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>

      {saved ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <KeyRound className="size-3.5" aria-hidden />
          <span className="font-mono">{maskKey(saved)}</span>
          {provider === 'custom' && <span className="truncate">· {ai.baseUrl}</span>}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => {
              setOk(false)
              const { [provider]: _, ...keys } = ai.keys
              updateAi({ keys })
            }}
          >
            Remove key
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          {provider === 'custom' && (
            <Field label="Service address" hint="Its OpenAI-compatible API, e.g. https://api.together.xyz/v1">
              <Input
                type="url"
                inputMode="url"
                spellCheck={false}
                placeholder="https://…/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </Field>
          )}
          <Field
            label={`${preset.name} API key`}
            hint={
              <>
                {preset.keyUrl && (
                  <>
                    Create one at{' '}
                    <a href={preset.keyUrl} target="_blank" rel="noreferrer" className="text-accent-ink hover:underline">
                      {new URL(preset.keyUrl).hostname}
                    </a>
                    .{' '}
                  </>
                )}
                It is checked with {preset.name}, then stored only in this browser.
              </>
            }
          >
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={preset.keyPlaceholder}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
          {check.error && <ErrorText>{check.error}</ErrorText>}
          <Button type="submit" variant="primary" size="sm" disabled={check.busy || !key.trim()}>
            {check.busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Check and save key
          </Button>
        </form>
      )}
      {ok && saved && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="size-3.5" aria-hidden /> Key works. AI results will refresh with {preset.name}.
        </p>
      )}

      <datalist id={listId}>
        {preset.models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <div className="grid gap-3 sm:grid-cols-2">
        <ModelField
          key={`${provider}-model`}
          label="Drafts, summaries and answers"
          hint="The model that writes for you."
          value={model}
          list={listId}
          onSave={(m) => setModels({ model: m })}
        />
        <ModelField
          key={`${provider}-triage`}
          label="Sorting the queue"
          hint="Runs for each allowed chat as it changes."
          value={triageModel}
          list={listId}
          onSave={(m) => setModels({ triageModel: m })}
        />
      </div>
    </div>
  )
}

/** A model id, saved when the field is left (not on every keystroke, which would re-run the AI). */
function ModelField({ label, hint, value, list, onSave }: { label: string; hint: string; value: string; list: string; onSave(model: string): void }) {
  const [draft, setDraft] = useState(value)
  const [shown, setShown] = useState(value)
  if (shown !== value) {
    setShown(value)
    setDraft(value)
  }
  const save = () => {
    const next = draft.trim()
    if (next && next !== value) onSave(next)
    else setDraft(value)
  }
  return (
    <Field label={label} hint={hint}>
      <Input
        list={list}
        spellCheck={false}
        autoComplete="off"
        placeholder="model id"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), save())}
      />
    </Field>
  )
}

function maskKey(key: string) {
  const k = key.trim()
  return k.length > 14 ? `${k.slice(0, 7)}…${k.slice(-4)}` : '••••••••'
}

function ConsentCard() {
  const { aiEnabled, aiThreadIds, setThreadsAllowed } = useSettings(
    useShallow((s) => ({ aiEnabled: s.aiEnabled, aiThreadIds: s.aiThreadIds, setThreadsAllowed: s.setThreadsAllowed })),
  )
  const threads = useInbox((s) => s.threads)
  const contacts = useInbox((s) => s.contacts)
  const list = useMemo(
    () =>
      NETWORK_ORDER.flatMap((n) =>
        Object.values(threads)
          .filter((t) => t.network === n)
          .sort((a, b) => a.title.localeCompare(b.title)),
      ),
    [threads],
  )
  const allIds = list.map((t) => t.id)
  const selected = list.filter((t) => aiThreadIds.includes(t.id)).length

  return (
    <Card>
      <CardHeader
        icon={<ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />}
        title="Allow AI to read selected threads"
        aside={
          <Switch
            checked={aiEnabled}
            onChange={(on) => (on ? turnOnAi({ quiet: true }) : turnOffAi())}
            label="Allow AI to read selected threads"
          />
        }
      >
        Priority, summaries, drafts, tasks and answers only run on the chats selected below. New chats stay unselected
        until you allow them. Turning this off clears AI results from this device.
      </CardHeader>

      <div className={cn('mt-4 border-t border-line pt-3 transition-opacity', !aiEnabled && 'opacity-50')}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-muted">
            Selected chats · {selected} of {list.length}
          </p>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" disabled={!aiEnabled} onClick={() => setThreadsAllowed(allIds, true)}>
              Select all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!aiEnabled}
              onClick={() => {
                setThreadsAllowed(allIds, false)
                useAi.getState().forgetAll()
              }}
            >
              Clear
            </Button>
          </div>
        </div>
        {list.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted">No chats yet.</p>
        ) : (
          <ul className="mt-2 max-h-64 space-y-0.5 overflow-y-auto pr-1">
            {list.map((t) => (
              <li key={t.id}>
                <label
                  className={cn(
                    'flex items-center gap-3 rounded-xl px-2 py-1.5',
                    aiEnabled ? 'cursor-pointer hover:bg-surface-2' : 'cursor-not-allowed',
                  )}
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-accent"
                    checked={aiThreadIds.includes(t.id)}
                    disabled={!aiEnabled}
                    onChange={(e) => setThreadAiAccess(t.id, e.target.checked)}
                  />
                  <Avatar name={t.title} seed={t.id} size="xs" group={t.kind === 'group'} imageUrl={threadPicture(t, contacts)} />
                  <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-faint">
                    <NetworkIcon network={t.network} /> {NETWORKS[t.network].name}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}
