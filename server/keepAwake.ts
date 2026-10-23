/**
 * Free plans on some hosts (Render's, for one) stop a web service after about 15 minutes without
 * visitors and start it again on the next visit. While stopped, the server can't hold the WhatsApp
 * and Telegram connections, so messages would only come in once someone opens the site. While any
 * account is linked, this visits the server's own public address often enough to keep it running.
 */
export function keepAwake({ url, everyMs = 10 * 60_000, wanted }: { url: string; everyMs?: number; wanted(): Promise<boolean> }) {
  const health = new URL('/api/health', url).toString()
  const timer = setInterval(() => {
    void (async () => {
      if (!(await wanted())) return
      await fetch(health, { signal: AbortSignal.timeout(15_000) })
    })().catch(() => undefined) // The next visit tries again.
  }, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
