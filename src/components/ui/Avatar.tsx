import type { NetworkId } from '@/data/types'
import { cn } from '@/lib/cn'
import { hashString, initials, isEmojiAvatar } from '@/lib/format'
import { NetworkIcon } from './NetworkIcon'

/* Each entry: a soft two-stop gradient plus the ink colour for the initials, so a contact's
   avatar reads as a small glossy orb rather than a flat tinted circle. */
const PALETTE = [
  'bg-gradient-to-br from-rose-200 to-rose-300/80 text-rose-800 dark:from-rose-500/30 dark:to-rose-500/10 dark:text-rose-200',
  'bg-gradient-to-br from-amber-200 to-amber-300/80 text-amber-900 dark:from-amber-500/30 dark:to-amber-500/10 dark:text-amber-200',
  'bg-gradient-to-br from-emerald-200 to-emerald-300/80 text-emerald-800 dark:from-emerald-500/30 dark:to-emerald-500/10 dark:text-emerald-200',
  'bg-gradient-to-br from-sky-200 to-sky-300/80 text-sky-800 dark:from-sky-500/30 dark:to-sky-500/10 dark:text-sky-200',
  'bg-gradient-to-br from-violet-200 to-violet-300/80 text-violet-800 dark:from-violet-500/30 dark:to-violet-500/10 dark:text-violet-200',
  'bg-gradient-to-br from-teal-200 to-teal-300/80 text-teal-800 dark:from-teal-500/30 dark:to-teal-500/10 dark:text-teal-200',
  'bg-gradient-to-br from-orange-200 to-orange-300/80 text-orange-900 dark:from-orange-500/30 dark:to-orange-500/10 dark:text-orange-200',
  'bg-gradient-to-br from-indigo-200 to-indigo-300/80 text-indigo-800 dark:from-indigo-500/30 dark:to-indigo-500/10 dark:text-indigo-200',
]

const SIZES = {
  xs: 'size-6 text-[10px]',
  sm: 'size-8 text-[11px]',
  md: 'size-10 text-[13px]',
  lg: 'size-12 text-[15px]',
}

const BADGE_SIZES = { xs: 'size-3.5', sm: 'size-4', md: 'size-5', lg: 'size-[22px]' }

const EMOJI_SIZES = { xs: 'text-sm', sm: 'text-base', md: 'text-xl', lg: 'text-2xl' }

interface AvatarProps {
  name: string
  /** Seed for the colour, so a contact keeps its colour across renames. */
  seed?: string
  size?: keyof typeof SIZES
  group?: boolean
  network?: NetworkId
  /** A photo to show instead of initials. */
  imageUrl?: string
  className?: string
}

export function Avatar({ name, seed = name, size = 'md', group = false, network, imageUrl, className }: AvatarProps) {
  const label = initials(name)
  const emoji = isEmojiAvatar(label)
  const shape = group ? 'rounded-[30%]' : 'rounded-full'
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          // Google's profile photos refuse requests that carry a referrer.
          referrerPolicy="no-referrer"
          className={cn('object-cover shadow-sm ring-1 ring-black/5 dark:ring-white/10', shape, SIZES[size])}
        />
      ) : (
        <span
          aria-hidden
          className={cn(
            'relative isolate inline-flex items-center justify-center overflow-hidden font-semibold tracking-tight select-none',
            shape,
            emoji ? 'bg-surface-2 ring-1 ring-line ring-inset' : cn(PALETTE[hashString(seed) % PALETTE.length], 'shadow-sm ring-1 ring-black/5 dark:ring-white/10'),
            SIZES[size],
            emoji && EMOJI_SIZES[size],
          )}
        >
          {/* A soft light catching the top of the orb, like the rest of the glass UI. */}
          {!emoji && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[linear-gradient(165deg,rgb(255_255_255/0.65),rgb(255_255_255/0)_55%)] dark:bg-[linear-gradient(165deg,rgb(255_255_255/0.22),rgb(255_255_255/0)_55%)]"
            />
          )}
          <span className="relative">{label}</span>
        </span>
      )}
      {network && (
        <NetworkIcon
          network={network}
          className={cn('absolute -right-1 -bottom-1 shadow-sm ring-2 ring-surface-solid', BADGE_SIZES[size])}
        />
      )}
    </span>
  )
}
