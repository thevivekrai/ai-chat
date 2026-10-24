import { useEffect, useRef, useState } from 'react'
import { useOnScreen } from '@/hooks/useOnScreen'

/**
 * A video sticker (Telegram's WebM ones), looping without sound. It loads once it's (nearly) on
 * screen, and only plays while it is.
 */
export function VideoSticker({ url, name, className, onFail }: { url: string; name: string; className?: string; onFail(): void }) {
  const video = useRef<HTMLVideoElement>(null)
  const onScreen = useOnScreen(video)
  const [seen, setSeen] = useState(false)
  if (onScreen && !seen) setSeen(true)

  useEffect(() => {
    const el = video.current
    if (!el || !seen) return
    if (onScreen) void el.play().catch(() => undefined)
    else el.pause()
  }, [onScreen, seen, url])

  return (
    <video
      ref={video}
      src={seen ? url : undefined}
      loop
      muted
      playsInline
      preload="none"
      aria-label={name}
      onError={() => seen && onFail()}
      className={className}
    />
  )
}
