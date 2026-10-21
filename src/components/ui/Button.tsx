import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'soft'
type Size = 'sm' | 'md' | 'icon' | 'icon-sm'

const VARIANTS: Record<Variant, string> = {
  primary: 'accent-gloss shadow-accent hover:brightness-[1.07]',
  secondary: 'border border-line bg-surface text-fg shadow-card hover:border-line-strong hover:bg-pill',
  ghost: 'text-muted hover:bg-surface-2 hover:text-fg',
  soft: 'bg-accent-soft text-accent-ink hover:bg-accent/20',
}

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-2.5 text-[13px]',
  md: 'h-9 px-3.5 text-sm',
  icon: 'size-9',
  'icon-sm': 'size-8',
}

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: Variant
  size?: Size
}

export function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-xl font-medium',
        'transition-[color,background-color,border-color,box-shadow,filter,scale] duration-150 active:scale-[0.97]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  )
}
