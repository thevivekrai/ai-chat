import { useState } from 'react'
import { Check, VenetianMask } from 'lucide-react'
import { Switch } from '@/components/ui/Switch'
import { setIncognito } from '@/store/actions'
import { useIncognito } from '@/store/privacy'
import { useSession } from '@/store/session'
import { toast } from '@/store/toasts'
import { Card, CardHeader, SectionTitle } from './parts'

export function PrivacyTab() {
  const incognito = useIncognito()
  const signedIn = useSession((s) => !!s.user)
  const [saving, setSaving] = useState(false)

  const change = async (on: boolean) => {
    setSaving(true)
    try {
      await setIncognito(on)
    } catch (error) {
      toast({ title: "Couldn't change Incognito mode", description: error instanceof Error ? error.message : undefined })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <SectionTitle>Privacy</SectionTitle>
      <Card>
        <CardHeader
          icon={<VenetianMask className="size-5 text-accent-ink" aria-hidden />}
          title="Incognito mode"
          aside={<Switch checked={incognito} onChange={(on) => void change(on)} disabled={saving} label="Incognito mode" />}
        >
          Read messages without people knowing: no read receipts (blue ticks on WhatsApp, "seen" on
          Telegram) and no "typing…" while you write.
          {signedIn ? ' It applies to your account, on every device you sign in on.' : ' It applies on this device.'}
        </CardHeader>
        <ul className="mt-3 space-y-1.5 border-t border-line pt-3 text-xs leading-relaxed text-muted">
          {[
            'Chats you open still show as read here, in Sytext.',
            'To let one chat know you’ve read it, choose "Mark as read for them" in its ⋯ menu.',
            'Replying still shows you were there, and your phone may send read receipts if you open the chat on it.',
          ].map((line) => (
            <li key={line} className="flex gap-2">
              <Check className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
              {line}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
