import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { LogoMark } from '@/components/layout/LogoMark'
import { Wallpaper } from '@/components/layout/Wallpaper'
import { go } from '@/routing/router'

/**
 * A page of its own, outside the inbox: help, the legal pages, and whatever a wrong address lands
 * on. They read the same signed in or out, so they can be linked to from anywhere.
 */
export function PublicPage({ title, lead, children, back = '/' }: { title: string; lead?: string; children: ReactNode; back?: string }) {
  return (
    <div className="relative min-h-dvh overflow-y-auto">
      <Wallpaper />
      <div className="relative mx-auto w-full max-w-2xl px-4 py-10 sm:py-16">
        <a
          href={back}
          onClick={(e) => {
            e.preventDefault()
            go(back)
          }}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted transition-colors hover:text-fg"
        >
          <ArrowLeft className="size-4" aria-hidden /> Back to Sytext
        </a>
        <header className="mt-6 flex items-center gap-3">
          <LogoMark className="size-9" />
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        </header>
        {lead && <p className="mt-3 text-sm leading-relaxed text-muted">{lead}</p>}
        <div className="mt-8 space-y-6 rounded-3xl border border-line bg-surface/80 p-6 shadow-card backdrop-blur-xl">{children}</div>
      </div>
    </div>
  )
}

/** A heading and its paragraphs, as the legal and help pages use. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-fg">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed text-muted">{children}</div>
    </section>
  )
}
