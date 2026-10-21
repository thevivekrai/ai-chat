import type { NetworkId } from '@/data/types'
import { cn } from '@/lib/cn'
import { NETWORKS } from '@/lib/networks'

export function NetworkDot({ network, className }: { network: NetworkId; className?: string }) {
  return (
    <span
      role="img"
      aria-label={NETWORKS[network].name}
      title={NETWORKS[network].name}
      className={cn('inline-block size-2 shrink-0 rounded-full', NETWORKS[network].dot, className)}
    />
  )
}
