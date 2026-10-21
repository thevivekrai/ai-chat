import { cn } from '@/lib/cn'

interface SwitchProps {
  checked: boolean
  onChange(checked: boolean): void
  label: string
  disabled?: boolean
  size?: 'sm' | 'md'
}

export function Switch({ checked, onChange, label, disabled, size = 'md' }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-line-strong',
        size === 'md' ? 'h-5 w-9' : 'h-4 w-7',
      )}
    >
      <span
        className={cn(
          'inline-block rounded-full bg-white shadow-sm transition-transform duration-200',
          size === 'md' ? 'size-4' : 'size-3',
          checked ? (size === 'md' ? 'translate-x-[18px]' : 'translate-x-[14px]') : 'translate-x-0.5',
        )}
      />
    </button>
  )
}
