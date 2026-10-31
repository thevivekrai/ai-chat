import { create } from 'zustand'
import { serverApi } from '@/data/server/serverApi'
import { readJson, writeJson } from '@/data/storage'
import { toast } from './toasts'

/**
 * Notifications of new messages on this device.
 *
 * Linked accounts run on the server around the clock, so it's the server that sees a message
 * arrive; it pushes it to every device that turned notifications on (server/push.ts), and the
 * service worker (public/sw.js) shows it, whether Sytext is open or not. Here: asking the browser
 * for permission, subscribing this device, and keeping the server's copy of the subscription
 * current (it forgets devices signed out elsewhere, so the app checks in on every start).
 */

export type NotificationSupport =
  /** Push works here. */
  | 'yes'
  /** An iPhone or iPad in Safari: push works once Sytext is added to the Home Screen. */
  | 'ios-home-screen'
  /** This browser has no push. */
  | 'no'

interface Prefs {
  /** This device wants notifications (kept across sign-out, so signing back in turns them on again). */
  on: boolean
  /** Show who wrote and what (or only that a message came). */
  preview: boolean
  /** Offered once already, after signing in. */
  offered: boolean
}

const PREFS_KEY = 'tidings.notifications'
const prefs = (): Prefs => ({ on: false, preview: true, offered: false, ...readJson<Partial<Prefs>>(PREFS_KEY) })
const savePrefs = (change: Partial<Prefs>) => writeJson(PREFS_KEY, { ...prefs(), ...change })

/** What the browser offers for installing the site as an app (Chrome, Edge), once it does. */
export interface InstallPrompt extends Event {
  prompt(): Promise<void>
}

interface NotificationState {
  support: NotificationSupport
  /** Installing as an app, where the browser offers it. */
  install: InstallPrompt | null
  permission: NotificationPermission
  /** This device is subscribed and the server has it. */
  on: boolean
  preview: boolean
  busy: boolean
  /** Checks in with the server after signing in (and offers notifications once). */
  sync(): Promise<void>
  enable(): Promise<boolean>
  disable(): Promise<void>
  setPreview(preview: boolean): Promise<void>
  test(): Promise<void>
  /** Signing out: this device stops getting the account's messages. */
  forgetHere(): Promise<void>
}

export function notificationSupport(): NotificationSupport {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'no'
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return 'yes'
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  return ios ? 'ios-home-screen' : 'no'
}

const permissionNow = (): NotificationPermission => (typeof Notification === 'undefined' ? 'default' : Notification.permission)

/** The server's key, as the push manager takes it. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/** The service worker, registered at start (see registerServiceWorker). */
async function worker(): Promise<ServiceWorkerRegistration | null> {
  if (notificationSupport() !== 'yes') return null
  return (await navigator.serviceWorker.getRegistration('/')) ?? (await registerServiceWorker())
}

/** Subscribes this device (once allowed) and gives the server its subscription. */
async function subscribeHere(preview: boolean): Promise<void> {
  const registration = await worker()
  if (!registration) throw new Error('This browser can’t show notifications.')
  const { key } = await serverApi.pushKey()
  let subscription = await registration.pushManager.getSubscription()
  // Made with another server's key (the server's key changed): start afresh.
  const current = subscription?.options.applicationServerKey
  const wanted = keyBytes(key)
  const same = (a: Uint8Array) => a.length === wanted.length && a.every((byte, i) => byte === wanted[i])
  if (subscription && current && !same(new Uint8Array(current))) {
    await subscription.unsubscribe().catch(() => undefined)
    subscription = null
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) })
  await serverApi.pushSubscribe(subscription.toJSON(), preview)
}

export const useNotifications = create<NotificationState>()((set, get) => ({
  support: notificationSupport(),
  install: null,
  permission: permissionNow(),
  on: false,
  preview: prefs().preview,
  busy: false,

  async sync() {
    set({ support: notificationSupport(), permission: permissionNow(), preview: prefs().preview })
    if (get().support !== 'yes') return
    const { on, preview, offered } = prefs()
    if (on && permissionNow() === 'granted') {
      try {
        await subscribeHere(preview)
        set({ on: true })
      } catch {
        set({ on: false })
      }
      return
    }
    set({ on: false })
    // Offered once, after signing in: a tap on the toast is what lets the browser ask.
    if (!offered && permissionNow() === 'default') {
      savePrefs({ offered: true })
      toast({
        title: 'Get notified of new messages?',
        description: 'Sytext can tell you when someone writes on any of your linked accounts, even with the app closed.',
        group: 'notifications',
        action: { label: 'Turn on', run: () => void get().enable() },
      })
    }
  },

  async enable() {
    if (get().support !== 'yes' || get().busy) return false
    set({ busy: true })
    try {
      const permission = await Notification.requestPermission()
      set({ permission })
      if (permission !== 'granted') {
        toast({
          title: 'Notifications are blocked',
          description: 'Allow notifications for Sytext in your browser’s or phone’s settings, then turn them on here.',
          group: 'notifications',
        })
        return false
      }
      await subscribeHere(get().preview)
      savePrefs({ on: true, offered: true })
      set({ on: true })
      toast({ title: 'Notifications on', description: 'New messages will show up on this device, even with Sytext closed.', group: 'notifications' })
      return true
    } catch (error) {
      toast({ title: 'Couldn’t turn on notifications', description: error instanceof Error ? error.message : undefined, group: 'notifications' })
      return false
    } finally {
      set({ busy: false })
    }
  },

  async disable() {
    set({ busy: true })
    try {
      savePrefs({ on: false })
      await unsubscribeHere()
      set({ on: false })
    } finally {
      set({ busy: false })
    }
  },

  async setPreview(preview) {
    savePrefs({ preview })
    set({ preview })
    if (get().on) await subscribeHere(preview).catch(() => undefined)
  },

  async test() {
    try {
      const { sent } = await serverApi.pushTest()
      if (!sent) toast({ title: 'No device took it', description: 'Turn notifications off and on again on this device.', group: 'notifications' })
    } catch (error) {
      toast({ title: 'Couldn’t send a test', description: error instanceof Error ? error.message : undefined, group: 'notifications' })
    }
  },

  async forgetHere() {
    await unsubscribeHere()
    set({ on: false })
  },
}))

/** Takes this device off: from the server (while signed in) and from the browser's push service. */
async function unsubscribeHere() {
  const registration = await worker().catch(() => null)
  const subscription = await registration?.pushManager.getSubscription().catch(() => null)
  if (!subscription) return
  await serverApi.pushUnsubscribe(subscription.endpoint).catch(() => undefined)
  await subscription.unsubscribe().catch(() => undefined)
}

/**
 * Registers the service worker, and opens a chat when a notification is tapped while the app is
 * open (the worker says which).
 */
export async function registerServiceWorker(open?: (path: string) => void): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  if (open) {
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent<{ type?: string; path?: string }>) => {
      if (event.data?.type === 'open' && typeof event.data.path === 'string' && event.data.path.startsWith('/')) open(event.data.path)
    })
  }
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  } catch {
    return null
  }
}

// The browser offers installing once, as the page loads: kept for the Settings button.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    useNotifications.setState({ install: event as InstallPrompt })
  })
  window.addEventListener('appinstalled', () => useNotifications.setState({ install: null }))
}
