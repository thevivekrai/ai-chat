import { BookOpen, Search } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { SHORTCUTS } from '@/lib/shortcuts'
import { go } from '@/routing/router'
import { PublicPage, Section } from './PublicPage'

const GUIDE = 'https://github.com/thevivekrai/ai-chat#readme'

/** Keyboard shortcuts and the short answers people look for. */
export function HelpPage() {
  return (
    <PublicPage title="Help" lead="Everything Sytext does, and the keys that do it faster.">
      <Section title="The guide">
        <p>The full guide covers linking accounts, what each network can do, the AI and where your chats are kept.</p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="primary" onClick={() => window.open(GUIDE, '_blank', 'noopener,noreferrer')}>
            <BookOpen className="size-3.5" aria-hidden /> View guide
          </Button>
          <Button size="sm" onClick={() => go('/search')}>
            <Search className="size-3.5" aria-hidden /> Search your chats
          </Button>
        </div>
      </Section>

      <Section title="Keyboard shortcuts">
        <dl className="divide-y divide-line">
          {SHORTCUTS.map(({ keys, label }) => (
            <div key={label} className="flex items-center justify-between gap-4 py-2.5">
              <dt className="text-sm text-muted">{label}</dt>
              <dd className="flex shrink-0 items-center gap-1.5">
                {keys.map((combo, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && <span className="text-xs text-faint">/</span>}
                    {combo.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-faint">On a phone, everything here has a button: the shortcuts are for a keyboard.</p>
      </Section>

      <Section title="Common questions">
        <p>
          <b className="text-fg">Where are my chats kept?</b> The links to your accounts live on the server, encrypted. It keeps only the
          latest messages of each chat to pass on; the rest stay on your devices.
        </p>
        <p>
          <b className="text-fg">Does the AI read everything?</b> No. Only the chats you choose, and only while AI assist is on.
        </p>
        <p>
          <b className="text-fg">Why is a chat still unread elsewhere?</b> In Incognito mode Sytext sends no read receipts, so the other
          app keeps counting it unread.
        </p>
      </Section>
    </PublicPage>
  )
}
