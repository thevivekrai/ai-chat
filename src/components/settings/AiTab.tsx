import { useMemo, useState, type FormEvent } from 'react'
import { CheckCircle2, KeyRound, Loader2, ShieldCheck, Sparkles } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { CLAUDE_MODELS, testClaudeKey, type ClaudeModel } from '@/ai'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { NetworkDot } from '@/components/ui/NetworkDot'
import { Switch } from '@/components/ui/Switch'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { cn } from '@/lib/cn'
import { NETWORK_ORDER, NETWORKS } from '@/lib/networks'
import { setThreadAiAccess, turnOffAi, turnOnAi, updateClaude } from '@/store/actions'
import { useAi } from '@/store/ai'
import { useInbox } from '@/store/inbox'
import { useSettings } from '@/store/settings'
import { Card, CardHeader, ErrorText, Field, Input, SectionTitle, Select } from './parts'

export function AiTab() {
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionTitle>AI engine</SectionTitle>
        <ClaudeCard />
      </section>
      <section className="space-y-3">
        <SectionTitle>Privacy</SectionTitle>
        <ConsentCard />
      </section>
    </div>
  )
}

const modelName = (id: string) => CLAUDE_MODELS.find((m) => m.id === id)?.name ?? id

function ClaudeCard() {
  const claude = useSettings((s) => s.claude)
  const problem = useAi((s) => s.problem)
  const [key, setKey] = useState('')
  const [saved, setSaved] = useState(false)
  const check = useAsyncAction()
  const connected = claude.apiKey.trim() !== ''

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setSaved(false)
    void check.run(async () => {
      await testClaudeKey(key, claude.model)
      updateClaude({ apiKey: key.trim() })
      setKey('')
      setSaved(true)
    })
  }

  const modelSelect = (field: 'model' | 'triageModel', label: string, hint: string) => (
    <Field label={label} hint={hint}>
      <Select value={claude[field]} onChange={(e) => updateClaude({ [field]: e.target.value as ClaudeModel })}>
        {CLAUDE_MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name.replace(/^Claude /, '')} · {m.note.toLowerCase()}
          </option>
        ))}
      </Select>
    </Field>
  )

  return (
    <Card>
      <CardHeader
        icon={<Sparkles className="size-4 text-accent-ink" aria-hidden />}
        title={connected ? `Claude · ${modelName(claude.model)}` : 'Built-in demo AI'}
        aside={
          connected && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
              <span className={cn('size-1.5 rounded-full', problem ? 'bg-rose-500' : 'bg-emerald-500')} aria-hidden />
              {problem ? 'Needs attention' : 'Key saved'}
            </span>
          )
        }
      >
        {connected
          ? 'Priority, summaries, tasks, drafts and answers come from Claude, called from this browser with your API key.'
          : 'Works offline: it knows the demo chats and uses simple rules elsewhere. Add a Claude API key for real AI on every chat.'}
      </CardHeader>

      {problem && <div className="mt-3"><ErrorText>{problem.message}</ErrorText></div>}

      <div className="mt-4 space-y-3 border-t border-line pt-4">
        {connected ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <KeyRound className="size-3.5" aria-hidden />
            <span className="font-mono">{maskKey(claude.apiKey)}</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => updateClaude({ apiKey: '' })}>
              Remove key
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <Field
              label="Claude API key"
              hint={
                <>
                  Create one in the{' '}
                  <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer" className="text-accent-ink hover:underline">
                    Claude Console
                  </a>
                  . It is checked with Anthropic, then stored only in this browser.
                </>
              }
            >
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-ant-…"
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
        {saved && connected && (
          <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" aria-hidden /> Key works. AI results will refresh with Claude.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {modelSelect('model', 'Drafts, summaries and answers', 'The model that writes for you.')}
          {modelSelect('triageModel', 'Sorting the queue', 'Runs for each allowed chat as it changes.')}
        </div>
        <p className="text-[11px] leading-relaxed text-faint">
          Only the chats allowed below are sent to Anthropic, and only when a feature needs them. If a model declines a
          request on policy grounds, Anthropic retries it with a fallback model automatically.
        </p>
      </div>
    </Card>
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
                  <Avatar name={t.title} seed={t.id} size="xs" group={t.kind === 'group'} />
                  <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-faint">
                    <NetworkDot network={t.network} /> {NETWORKS[t.network].name}
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
