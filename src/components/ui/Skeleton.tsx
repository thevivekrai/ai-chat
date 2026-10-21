import { cn } from '@/lib/cn'

/** Shimmering text lines shown while the (mock) model is working. */
export function SkeletonLines({ lines = 2, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton h-3" style={{ width: i === lines - 1 ? '62%' : '100%' }} />
      ))}
    </div>
  )
}
