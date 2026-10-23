import { useEffect, useRef } from 'react'
import { readLottie } from '@/lib/lottie'

/**
 * Plays an animated sticker with lottie-web's light build, which runs nothing from the file (no
 * expressions). The player and the unpacking load only once one is shown.
 */
export function LottieSticker({ url, name, className, onFail }: { url: string; name: string; className?: string; onFail(): void }) {
  const box = useRef<HTMLDivElement>(null)
  const fail = useRef(onFail)
  useEffect(() => {
    fail.current = onFail
  })

  useEffect(() => {
    let cancelled = false
    let animation: { destroy(): void } | null = null
    void (async () => {
      const res = await fetch(url, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`The sticker couldn't be fetched (${res.status}).`)
      const animationData = await readLottie(new Uint8Array(await res.arrayBuffer()))
      const { default: lottie } = await import('lottie-web/build/player/lottie_light')
      if (cancelled || !box.current) return
      animation = lottie.loadAnimation({ container: box.current, renderer: 'svg', loop: true, autoplay: true, animationData })
    })().catch(() => {
      if (!cancelled) fail.current()
    })
    return () => {
      cancelled = true
      animation?.destroy()
    }
  }, [url])

  return <div ref={box} role="img" aria-label={name} className={className} />
}
