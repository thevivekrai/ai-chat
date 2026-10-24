import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Download, Loader2, Mic, Music, Pause, Play } from 'lucide-react'
import type { Attachment } from '@/data/types'
import { cn } from '@/lib/cn'
import { downloadUrl } from '@/lib/files'
import { formatDuration } from '@/lib/format'
import { waveBars } from '@/lib/waveform'

const BARS = 36
const RATES = [1, 1.5, 2]

/** Only one plays at a time: starting one pauses the other. */
let current: HTMLAudioElement | null = null

/**
 * A voice message or audio file, played in the chat. A voice message is fetched whole the first
 * time it's played (they're small), so it can be scrubbed straight away; an audio file streams.
 */
export function AudioPlayer({ attachment: a, fromMe }: { attachment: Attachment; fromMe: boolean }) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const loading = useRef<Promise<HTMLAudioElement> | null>(null)
  const objectUrl = useRef<string | null>(null)
  const gone = useRef(false)
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'paused' | 'error'>('idle')
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(a.duration ?? 0)
  const [rate, setRate] = useState(1)
  const bars = useMemo(() => waveBars(a.waveform, BARS, a.url ?? a.name), [a.waveform, a.url, a.name])

  useEffect(
    () => () => {
      gone.current = true
      audio.current?.pause()
      if (current === audio.current) current = null
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    },
    [],
  )

  // The position, smoothly, while it plays.
  useEffect(() => {
    if (state !== 'playing') return
    let frame = 0
    const tick = () => {
      if (audio.current) setPosition(audio.current.currentTime)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [state])

  /** The audio element, with the file loaded into it: fetched once, however quickly it's tapped. */
  function load(): Promise<HTMLAudioElement> {
    loading.current ??= fetchAudio().catch((error: unknown) => {
      loading.current = null
      throw error
    })
    return loading.current
  }

  async function fetchAudio(): Promise<HTMLAudioElement> {
    setState('loading')
    let src = a.url!
    // Voice messages are small: fetched whole, so they can be scrubbed at once. Audio files (a
    // song, a long recording) stream instead.
    if (a.voice) {
      const res = await fetch(a.url!, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`Couldn't fetch it (${res.status})`)
      const blob = await res.blob()
      // Closed while it loaded: nothing to play it in.
      if (gone.current) throw new DOMException('Closed', 'AbortError')
      src = objectUrl.current = URL.createObjectURL(blob)
    }
    const el = new Audio(src)
    el.preload = 'auto'
    el.playbackRate = rate
    el.addEventListener('loadedmetadata', () => Number.isFinite(el.duration) && el.duration > 0 && setDuration(el.duration))
    el.addEventListener('play', () => setState('playing'))
    el.addEventListener('pause', () => setState((s) => (s === 'error' ? s : 'paused')))
    el.addEventListener('ended', () => {
      setPosition(0)
      el.currentTime = 0
      setState('paused')
    })
    el.addEventListener('error', () => setState('error'))
    audio.current = el
    return el
  }

  async function toggle() {
    try {
      const el = await load()
      if (!el.paused) return el.pause()
      if (current && current !== el) current.pause()
      current = el
      await el.play()
    } catch (error) {
      const name = error instanceof DOMException ? error.name : ''
      // Paused again before it started, or closed: not a failure.
      if (name === 'AbortError') return
      // Loading took long enough that the browser wants another tap (iOS Safari): ready for it.
      if (name === 'NotAllowedError') setState('paused')
      else setState('error')
    }
  }

  async function seek(fraction: number) {
    try {
      const el = await load()
      const total = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration
      if (!total) return
      el.currentTime = Math.min(total, Math.max(0, fraction * total))
      setPosition(el.currentTime)
      if (state === 'loading' || state === 'idle') setState('paused')
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setState('error')
    }
  }

  const onScrub = (e: PointerEvent<HTMLDivElement>) => {
    if (e.type === 'pointermove' && e.buttons !== 1) return
    const box = e.currentTarget.getBoundingClientRect()
    void seek((e.clientX - box.left) / box.width)
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!duration || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
    e.preventDefault()
    void seek((position + (e.key === 'ArrowRight' ? 5 : -5)) / duration)
  }

  const nextRate = () => {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length]
    setRate(next)
    if (audio.current) audio.current.playbackRate = next
  }

  const done = duration ? position / duration : 0
  const started = state === 'playing' || position > 0
  const label = a.voice ? 'Voice message' : a.name
  const dim = fromMe ? 'text-white/75' : 'text-muted'

  if (state === 'error') {
    return (
      <a
        href={a.url ? downloadUrl(a.url) : undefined}
        download={a.name}
        className={cn('mb-1.5 flex min-w-52 items-center gap-2.5 rounded-xl px-2.5 py-2', fromMe ? 'bg-white/15' : 'bg-surface ring-1 ring-line')}
      >
        {a.voice ? <Mic className="size-4 shrink-0" aria-hidden /> : <Music className="size-4 shrink-0" aria-hidden />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{label}</span>
          <span className={cn('block text-[11px]', dim)}>Can't be played here · download it</span>
        </span>
        <Download className={cn('size-4 shrink-0', dim)} aria-hidden />
      </a>
    )
  }

  return (
    <div className="mb-1 flex w-64 max-w-full items-center gap-2.5 py-0.5" role="group" aria-label={label}>
      <button
        type="button"
        onClick={() => void toggle()}
        aria-label={state === 'playing' ? `Pause ${label.toLowerCase()}` : `Play ${label.toLowerCase()}`}
        className={cn(
          'grid size-9 shrink-0 place-items-center rounded-full transition-transform active:scale-95',
          fromMe ? 'bg-white text-accent-ink' : 'bg-accent text-white',
        )}
      >
        {state === 'loading' ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : state === 'playing' ? (
          <Pause className="size-4 fill-current" aria-hidden />
        ) : (
          <Play className="ml-0.5 size-4 fill-current" aria-hidden />
        )}
      </button>
      <div className="min-w-0 flex-1">
        {!a.voice && <p className="mb-0.5 truncate text-[12.5px] font-medium">{a.name}</p>}
        <div
          role="slider"
          tabIndex={0}
          aria-label="Position"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(position)}
          aria-valuetext={`${formatDuration(position)} of ${formatDuration(duration)}`}
          onPointerDown={onScrub}
          onPointerMove={onScrub}
          onKeyDown={onKey}
          className="flex h-7 cursor-pointer touch-none items-center gap-[2px] rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {bars.map((height, i) => (
            <span
              key={i}
              aria-hidden
              style={{ height: `${Math.round(height * 100)}%` }}
              className={cn(
                'min-h-[3px] flex-1 rounded-full transition-colors',
                (i + 0.5) / bars.length <= done
                  ? fromMe
                    ? 'bg-white'
                    : 'bg-accent'
                  : fromMe
                    ? 'bg-white/40'
                    : 'bg-fg/20',
              )}
            />
          ))}
        </div>
        <div className={cn('mt-0.5 flex items-center justify-between text-[11px] tabular-nums', dim)}>
          <span>{formatDuration(started ? position : duration)}</span>
          {a.voice ? (
            <button
              type="button"
              onClick={nextRate}
              aria-label={`Playback speed ${rate}×`}
              className={cn('rounded-full px-1.5 font-semibold', fromMe ? 'bg-white/20' : 'bg-fg/10')}
            >
              {rate}×
            </button>
          ) : (
            a.url && (
              <a href={downloadUrl(a.url)} download={a.name} className="inline-flex items-center gap-1 hover:underline" title={`Download ${a.name}`}>
                <Download className="size-3" aria-hidden /> {a.size ?? 'Save'}
              </a>
            )
          )}
        </div>
      </div>
    </div>
  )
}
