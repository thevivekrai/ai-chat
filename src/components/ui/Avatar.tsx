import type { NetworkId } from '@/data/types'
import { cn } from '@/lib/cn'
import { hashString, initials, isEmojiAvatar } from '@/lib/format'
import { NetworkIcon } from './NetworkIcon'

const PALETTE = [
  'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
  'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300',
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
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
  className?: string
}

export function Avatar({ name, seed = name, size = 'md', group = false, network, className }: AvatarProps) {
  const label = initials(name)
  const emoji = isEmojiAvatar(label)
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      <span
        aria-hidden
        className={cn(
          'inline-flex items-center justify-center font-semibold tracking-tight select-none',
          group ? 'rounded-[30%]' : 'rounded-full',
          emoji ? 'bg-surface-2 ring-1 ring-line ring-inset' : PALETTE[hashString(seed) % PALETTE.length],
          SIZES[size],
          emoji && EMOJI_SIZES[size],
        )}
      >
        {label}
      </span>
      {network && (
        <NetworkIcon
          network={network}
          className={cn('absolute -right-1 -bottom-1 ring-2 ring-surface-solid', BADGE_SIZES[size])}
        />
      )}
    </span>
  )
}
