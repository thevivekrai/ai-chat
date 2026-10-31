/*
 * Sytext's service worker: shows notifications of new messages, and opens the chat on a tap.
 *
 * The server sends a push (see server/push.ts) whenever a message comes in on a linked account,
 * so this works with Sytext closed: in the browser, installed to the home screen, and in the
 * Android app (which is this site, full screen). Pages are always fetched from the network; when
 * there's none, a navigation gets a short "you're offline" page instead of the browser's error.
 */

const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sytext · Offline</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#251d56;color:#eef0ff;text-align:center;padding:24px;box-sizing:border-box}
h1{font-size:20px;margin:16px 0 8px}p{margin:0 0 20px;opacity:.8;line-height:1.5}
button{font:inherit;font-weight:600;border:0;border-radius:12px;padding:10px 18px;background:#eef0ff;color:#251d56}
</style></head><body><main><img src="/icon-192.png" width="72" height="72" alt=""><h1>You're offline</h1>
<p>Sytext needs a connection to show your chats. Your linked accounts keep receiving messages meanwhile.</p>
<button onclick="location.reload()">Try again</button></main></body></html>`

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return
  event.respondWith(
    fetch(event.request).catch(
      () => new Response(OFFLINE_PAGE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    ),
  )
})

/** The app's windows, focused ones first. */
async function windows() {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  return list.filter((c) => new URL(c.url).origin === self.location.origin).sort((a, b) => Number(b.focused) - Number(a.focused))
}

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(
    (async () => {
      // Sytext is open in front of the user: the message is already on screen.
      const open = await windows()
      if (open.some((c) => c.focused && c.visibilityState === 'visible')) return
      await self.registration.showNotification(data.title || 'Sytext', {
        body: data.body || 'New message',
        tag: data.tag || 'sytext',
        renotify: true,
        icon: '/icon-192.png',
        badge: '/badge-96.png',
        timestamp: data.at || Date.now(),
        data: { url: data.url || '/' },
      })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/', self.location.origin)
  if (url.origin !== self.location.origin) return
  event.waitUntil(
    (async () => {
      const [win] = await windows()
      if (win) {
        // The open app goes to the chat itself (no reload), then comes to the front.
        win.postMessage({ type: 'open', path: url.pathname + url.search })
        return win.focus()
      }
      return self.clients.openWindow(url.href)
    })(),
  )
})

// The browser renewed the device's subscription: tell the server the new one.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription
      const key = old?.options?.applicationServerKey
      if (!key) return
      const fresh = event.newSubscription || (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }))
      await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        // It keeps the old one's settings (previews on or off).
        body: JSON.stringify({ subscription: fresh.toJSON(), replaces: old.endpoint }),
      })
    })().catch(() => undefined),
  )
})
