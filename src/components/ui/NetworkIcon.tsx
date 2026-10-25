import type { NetworkId } from '@/data/types'
import { cn } from '@/lib/cn'
import { NETWORKS } from '@/lib/networks'

/**
 * The mark of the network a chat lives on, in a round badge. Marks are only used to say where a
 * chat comes from. Size it with `className` (default 16px).
 */
export function NetworkIcon({ network, className }: { network: NetworkId; className?: string }) {
  const { name, icon, image, background } = NETWORKS[network]
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      style={{ background }}
      // Matrix's mark is black, so in dark mode its badge flips to white.
      className={cn(
        'inline-grid size-4 shrink-0 place-items-center rounded-full text-white',
        network === 'matrix' && 'dark:bg-white! dark:text-black',
        className,
      )}
    >
      {image ? (
        <img src={image} alt="" aria-hidden className="size-[76%] object-contain" />
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden className="size-[62%] fill-current">
          <path d={icon} />
        </svg>
      )}
    </span>
  )
}
