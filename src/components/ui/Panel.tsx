import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

/** The rounded card that holds each column. Full-bleed on phones. */
export function Panel({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface md:rounded-2xl md:border md:border-line md:shadow-card',
        className,
      )}
      {...props}
    />
  )
}
