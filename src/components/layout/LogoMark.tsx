import { APP_NAME } from '@/config'

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <path
        d="M9 11.5c0-1.38 1.12-2.5 2.5-2.5h9c1.38 0 2.5 1.12 2.5 2.5v6c0 1.38-1.12 2.5-2.5 2.5h-5.2l-3.4 2.7c-.5.4-1.2.04-1.2-.6V20h-.2A2.5 2.5 0 0 1 9 17.5v-6Z"
        fill="#fff"
      />
      <circle cx="13" cy="14.5" r="1.1" fill="var(--accent)" />
      <circle cx="16" cy="14.5" r="1.1" fill="var(--accent)" />
      <circle cx="19" cy="14.5" r="1.1" fill="var(--accent)" />
    </svg>
  )
}

export function Logo() {
  return (
    <div className="flex items-center gap-2">
      <LogoMark className="size-7 shrink-0" />
      <span className="text-[15px] font-semibold tracking-tight">{APP_NAME}</span>
    </div>
  )
}
