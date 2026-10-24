import { Fragment, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { placeholderPattern } from '@/lib/format'

export interface Highlight {
  phrase: string
  title: string
  /** A date AI found (underlined), or what's being searched for in the chat (marked). */
  kind?: 'date' | 'search'
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Message text with @mentions and AI-detected dates marked up. */
export function RichText({ text, highlights = [], onAccent = false }: { text: string; highlights?: Highlight[]; onAccent?: boolean }) {
  const phrases = highlights.map((h) => escapeRegExp(h.phrase))
  const pattern = new RegExp(`(@[\\p{L}\\d_]+)${phrases.length ? `|(${phrases.join('|')})` : ''}`, 'giu')

  const parts: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last) parts.push(text.slice(last, index))
    if (match[1]) {
      parts.push(
        <span key={index} className={onAccent ? 'font-semibold' : 'font-medium text-accent-ink'}>
          {match[1]}
        </span>,
      )
    } else {
      const highlight = highlights.find((h) => h.phrase.toLowerCase() === match[0].toLowerCase())
      if (highlight?.kind === 'search') {
        parts.push(
          <mark key={index} className="rounded-[3px] bg-amber-300/80 px-px text-inherit dark:bg-amber-400/60">
            {match[0]}
          </mark>,
        )
        last = index + match[0].length
        continue
      }
      parts.push(
        <span
          key={index}
          title={highlight ? `Detected: ${highlight.title}` : undefined}
          className={cn(
            'cursor-help underline decoration-dotted decoration-2 underline-offset-[3px]',
            onAccent ? 'decoration-white/70' : 'decoration-accent/60',
          )}
        >
          {match[0]}
        </span>,
      )
    }
    last = index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts.map((p, i) => (typeof p === 'string' ? <Fragment key={`t${i}`}>{p}</Fragment> : p))}</>
}

/** Draft text with [placeholders] marked so they're hard to miss. */
export function WithBlanks({ text }: { text: string }) {
  const parts: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(placeholderPattern())) {
    const index = match.index ?? 0
    if (index > last) parts.push(text.slice(last, index))
    parts.push(
      <mark key={index} className="rounded bg-amber-500/15 px-0.5 text-amber-800 dark:text-amber-300">
        {match[0]}
      </mark>,
    )
    last = index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts.map((p, i) => (typeof p === 'string' ? <Fragment key={`t${i}`}>{p}</Fragment> : p))}</>
}
