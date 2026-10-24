import { useEffect, useRef, useState } from 'react'
import { useOnScreen } from '@/hooks/useOnScreen'
import { readLottie, type LottieAnimation } from '@/lib/lottie'

/** Stickers read lately, by link: one sent again and again (or shown again) is read once. */
const read = new Map<string, Promise<LottieAnimation>>()
const READ_KEPT = 30

function animationAt(url: string): Promise<LottieAnimation> {
  let animation = read.get(url)
  if (!animation) {
    animation = fetch(url, { credentials: 'same-origin' }).then(async (res) => {
      if (!res.ok) throw new Error(`The sticker couldn't be fetched (${res.status}).`)
      return readLottie(new Uint8Array(await res.arrayBuffer()))
    })
    read.set(url, animation)
    animation.catch(() => read.delete(url))
    if (read.size > READ_KEPT) read.delete(read.keys().next().value!)
  }
  return animation
}

/**
 * Plays an animated sticker with lottie-web's light build, which runs nothing from the file (no
 * expressions). The player and the sticker load once it's (nearly) on screen, and it only plays
 * while it is.
 */
export function LottieSticker({ url, name, className, onFail }: { url: string; name: string; className?: string; onFail(): void }) {
  const box = useRef<HTMLDivElement>(null)
  const player = useRef<{ play(): void; pause(): void } | null>(null)
  const fail = useRef(onFail)
  useEffect(() => {
    fail.current = onFail
  })
  const onScreen = useOnScreen(box)
  const [seen, setSeen] = useState(false)
  if (onScreen && !seen) setSeen(true)
  const playing = useRef(onScreen)
  useEffect(() => {
    playing.current = onScreen
    if (onScreen) player.current?.play()
    else player.current?.pause()
  }, [onScreen])

  useEffect(() => {
    if (!seen) return
    let cancelled = false
    let animation: { destroy(): void; play(): void; pause(): void } | null = null
    void (async () => {
      // A copy each: the player changes what it's given.
      const animationData = structuredClone(await animationAt(url))
      const { default: lottie } = await import('lottie-web/build/player/lottie_light')
      if (cancelled || !box.current) return
      animation = lottie.loadAnimation({ container: box.current, renderer: 'svg', loop: true, autoplay: playing.current, animationData })
      player.current = animation
    })().catch(() => {
      if (!cancelled) fail.current()
    })
    return () => {
      cancelled = true
      animation?.destroy()
      player.current = null
    }
  }, [url, seen])

  return <div ref={box} role="img" aria-label={name} className={className} />
}
