import { useEffect, useRef, useState } from 'react'
import { useDarkMode } from '@/hooks/useApplyTheme'

/**
 * Google's own "Continue with Google" button (Google Identity Services). It opens Google's
 * sign-in in a popup and hands back an ID token, which the server checks before signing in.
 */

interface GoogleIdentity {
  accounts: {
    id: {
      initialize(options: {
        client_id: string
        callback(response: { credential: string }): void
        ux_mode?: 'popup' | 'redirect'
        auto_select?: boolean
        itp_support?: boolean
      }): void
      renderButton(
        parent: HTMLElement,
        options: {
          type?: 'standard' | 'icon'
          theme?: 'outline' | 'filled_blue' | 'filled_black'
          size?: 'large' | 'medium' | 'small'
          text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin'
          shape?: 'rectangular' | 'pill' | 'circle' | 'square'
          logo_alignment?: 'left' | 'center'
          width?: number
        },
      ): void
    }
  }
}

declare global {
  interface Window {
    google?: GoogleIdentity
  }
}

let loading: Promise<GoogleIdentity> | null = null

function loadGoogle(): Promise<GoogleIdentity> {
  loading ??= new Promise<GoogleIdentity>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.onload = () => (window.google ? resolve(window.google) : reject(new Error('Google sign-in did not load')))
    script.onerror = () => {
      loading = null
      script.remove()
      reject(new Error('Google sign-in did not load'))
    }
    document.head.appendChild(script)
  })
  return loading
}

export function GoogleButton({ clientId, onCredential }: { clientId: string; onCredential(credential: string): void }) {
  const ref = useRef<HTMLDivElement>(null)
  const callback = useRef(onCredential)
  const dark = useDarkMode()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    callback.current = onCredential
  })

  useEffect(() => {
    let cancelled = false
    loadGoogle()
      .then((google) => {
        const parent = ref.current
        if (cancelled || !parent) return
        google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => callback.current(response.credential),
          ux_mode: 'popup',
          auto_select: false,
          itp_support: true,
        })
        parent.replaceChildren()
        google.accounts.id.renderButton(parent, {
          type: 'standard',
          theme: dark ? 'filled_black' : 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'pill',
          logo_alignment: 'center',
          // Google's button takes a width between 200 and 400 pixels.
          width: Math.max(200, Math.min(400, Math.floor(parent.getBoundingClientRect().width))),
        })
      })
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [clientId, dark])

  if (failed) {
    return (
      <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-center text-xs text-muted">
        Google sign-in couldn't load (a blocker, or no connection). Use your email instead.
      </p>
    )
  }
  return <div ref={ref} className="flex h-11 w-full items-center justify-center overflow-hidden" />
}
