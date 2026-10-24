import { APP_NAME } from '@/config'

/** The app's own icon (public/favicon.svg), the same mark the browser tab shows. */
export function LogoMark({ className }: { className?: string }) {
  return <img src="/favicon.svg" alt="" aria-hidden width={32} height={32} className={className} />
}

export function Logo() {
  return (
    <div className="flex items-center gap-2">
      <LogoMark className="size-7 shrink-0" />
      <span className="text-[15px] font-semibold tracking-tight">{APP_NAME}</span>
    </div>
  )
}
