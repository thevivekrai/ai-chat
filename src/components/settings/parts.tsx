import { cloneElement, useId, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import type { ConnectorStatus } from '@/data/api'
import { cn } from '@/lib/cn'

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-[11px] font-semibold tracking-wider text-faint uppercase">{children}</h3>
}

/** A raised glass card inside the settings sheet. */
export function Card({ className, ...props }: ComponentProps<'section'>) {
  return <section className={cn('rounded-2xl border border-line bg-surface p-4 shadow-card', className)} {...props} />
}

export function CardHeader({ icon, title, aside, children }: { icon: ReactNode; title: ReactNode; aside?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-medium">{title}</h4>
        {children && <div className="mt-0.5 text-xs leading-relaxed text-muted">{children}</div>}
      </div>
      {aside && <div className="shrink-0">{aside}</div>}
    </div>
  )
}

type FieldControl = ReactElement<{ id?: string; 'aria-describedby'?: string }>

/** A labelled input; the hint is announced as its description. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: FieldControl }) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium text-muted">
        {label}
      </label>
      {cloneElement(children, { id, 'aria-describedby': hint ? `${id}-hint` : undefined })}
      {hint && (
        <p id={`${id}-hint`} className="text-[11px] leading-relaxed text-faint">
          {hint}
        </p>
      )}
    </div>
  )
}

export const inputClass =
  'h-9 w-full rounded-xl border border-line bg-surface px-3 text-sm text-fg outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-accent/40 focus:ring-4 focus:ring-accent/10 disabled:opacity-60'

export function Input(props: ComponentProps<'input'>) {
  return <input {...props} className={cn(inputClass, props.className)} />
}

export function Select(props: ComponentProps<'select'>) {
  return <select {...props} className={cn(inputClass, 'appearance-auto pr-2', props.className)} />
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-xs leading-relaxed text-rose-600 dark:text-rose-400">
      {children}
    </p>
  )
}

const STATUS_LOOK: Record<ConnectorStatus['state'], { label: string; dot: string }> = {
  online: { label: 'Connected', dot: 'bg-emerald-500' },
  connecting: { label: 'Connecting…', dot: 'bg-amber-400 animate-pulse' },
  error: { label: 'Needs attention', dot: 'bg-rose-500' },
}

export function StatusPill({ status }: { status: ConnectorStatus }) {
  const look = STATUS_LOOK[status.state]
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
      <span className={cn('size-1.5 rounded-full', look.dot)} aria-hidden />
      {look.label}
    </span>
  )
}
