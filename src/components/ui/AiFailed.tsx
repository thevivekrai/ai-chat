import { AlertCircle } from 'lucide-react'
import { cn } from '@/lib/cn'

/** Shown where an AI result should be when the call failed. */
export function AiFailed({ message, onRetry, className }: { message?: string; onRetry(): void; className?: string }) {
  return (
    <div className={cn('flex items-start gap-2 text-[13px] leading-relaxed text-muted', className)} role="status">
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-rose-500" aria-hidden />
      <p className="min-w-0">
        {message ?? "Couldn't get this from AI."}{' '}
        <button type="button" onClick={onRetry} className="font-medium whitespace-nowrap text-accent-ink hover:underline">
          Try again
        </button>
      </p>
    </div>
  )
}
