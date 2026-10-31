import { BellRing, Check, Download, EyeOff, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Switch'
import { useNotifications } from '@/store/notifications'
import { useSession } from '@/store/session'
import { Card, CardHeader, SectionTitle } from './parts'

/** The Android app, served by this site (android/sytext.apk in the repository). */
export const ANDROID_APK = '/download/sytext.apk'

const isAndroid = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
/** Running as an installed app: the Android app, or added to the home screen. */
const installed = () => typeof window !== 'undefined' && !!window.matchMedia?.('(display-mode: standalone)').matches

export function NotificationsTab() {
  const { support, permission, on, preview, busy, install, enable, disable, setPreview, test } = useNotifications()
  const signedIn = useSession((s) => s.status === 'signed-in')
  const android = useSession((s) => !!s.features?.androidApp) && isAndroid()

  const blocked = permission === 'denied'

  return (
    <div className="space-y-3">
      <SectionTitle>Notifications</SectionTitle>
      <Card>
        <CardHeader
          icon={<BellRing className="size-5 text-accent-ink" aria-hidden />}
          title="New messages on this device"
          aside={
            support === 'yes' && signedIn ? (
              <Switch checked={on} onChange={(next) => void (next ? enable() : disable())} disabled={busy} label="Notifications on this device" />
            ) : undefined
          }
        >
          {!signedIn
            ? 'Sign in and link an account to get notified when someone writes to you.'
            : support === 'ios-home-screen'
              ? 'On iPhone and iPad, add Sytext to your Home Screen first (Share → Add to Home Screen), open it from there, and turn notifications on in its Settings.'
              : support === 'no'
                ? 'This browser can’t show notifications. Try Chrome, Edge, Firefox or Safari, or the Android app.'
                : blocked
                  ? 'Notifications are blocked for Sytext. Allow them in your browser’s site settings (or the phone’s app settings), then turn them on here.'
                  : 'Get a notification when someone writes to you on any linked account — WhatsApp, Telegram, Instagram, X and the rest — even with Sytext closed.'}
        </CardHeader>

        {signedIn && support === 'yes' && (
          <ul className="mt-3 space-y-1.5 border-t border-line pt-3 text-xs leading-relaxed text-muted">
            {[
              'Your accounts stay connected on Sytext’s server around the clock, so messages arrive while your phone sleeps.',
              'One notification per chat: a newer message replaces the one before.',
              'Nothing pops up while Sytext is open in front of you, and archived chats stay quiet.',
            ].map((line) => (
              <li key={line} className="flex gap-2">
                <Check className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
                {line}
              </li>
            ))}
          </ul>
        )}

        {on && (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
            <Button size="sm" onClick={() => void test()}>
              Send a test notification
            </Button>
          </div>
        )}
      </Card>

      {on && (
        <Card>
          <CardHeader
            icon={<EyeOff className="size-5 text-accent-ink" aria-hidden />}
            title="Show message previews"
            aside={<Switch checked={preview} onChange={(next) => void setPreview(next)} label="Show message previews" />}
          >
            Who wrote and what they said, on the lock screen. Off: only “New message on WhatsApp”.
          </CardHeader>
        </Card>
      )}

      {!installed() && (android || install) && (
        <>
          <SectionTitle>App</SectionTitle>
          <Card>
            <CardHeader icon={<Smartphone className="size-5 text-accent-ink" aria-hidden />} title="Sytext as an app">
              {android
                ? 'The Android app opens Sytext full screen from your home screen, with notifications like any other chat app.'
                : 'Install Sytext to open it in its own window, from your dock or start menu.'}
            </CardHeader>
            <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
              {android && (
                <a
                  href={ANDROID_APK}
                  download
                  className="inline-flex h-8 items-center gap-1.5 rounded-xl px-2.5 text-[13px] font-medium accent-gloss shadow-accent hover:brightness-110"
                >
                  <Download className="size-3.5" aria-hidden />
                  Download for Android
                </a>
              )}
              {install && (
                <Button
                  size="sm"
                  onClick={() => {
                    void install.prompt()
                    useNotifications.setState({ install: null })
                  }}
                >
                  Install
                </Button>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
