import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

/** The glass slab that holds each column. Full-bleed on phones. */
export function Panel({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'glass relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:glass-edge md:rounded-3xl md:shadow-glass',
        className,
      )}
      {...props}
    />
  )
}
