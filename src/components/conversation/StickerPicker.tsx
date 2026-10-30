import { useReducer, useRef, useState, type ReactNode } from 'react'
import { Plus, Sticker as StickerIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Popover } from '@/components/ui/Popover'
import { cn } from '@/lib/cn'
import { addOwn, BUILT_IN, MAX_OWN, noteUsed, ownStickers, recentStickers, removeOwn, type Sticker } from '@/lib/stickers'
import { toast } from '@/store/toasts'

/**
 * Stickers to send, from the composer: the ones used lately, a built-in pack, and the user's own
 * pictures. A sheet on a phone, a panel above the composer on a wider screen.
 */
export function StickerPicker({ onPick, disabled }: { onPick(sticker: Sticker): void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  // Read from storage as it's drawn; adding or removing one draws it again.
  const [, refresh] = useReducer((n: number) => n + 1, 0)
  const own = open ? ownStickers() : []
  const recent = open ? recentStickers() : []
  const input = useRef<HTMLInputElement>(null)

  const pick = (sticker: Sticker) => {
    noteUsed(sticker)
    setOpen(false)
    onPick(sticker)
  }

  const add = async (file: File | undefined) => {
    if (!file) return
    try {
      await addOwn(file)
      refresh()
    } catch (error) {
      toast({ title: "Couldn't add that sticker", description: error instanceof Error ? error.message : undefined, group: 'stickers' })
    }
  }

  return (
    <Popover
      label="Stickers"
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="start"
      panelClassName="w-[22rem] p-3"
      renderTrigger={(props) => (
        <Button {...props} variant="ghost" size="icon-sm" aria-label="Stickers" title="Stickers" disabled={disabled}>
          <StickerIcon className="size-[18px]" />
        </Button>
      )}
    >
      <div className="max-h-[60dvh] space-y-3 overflow-y-auto overscroll-contain">
        {recent.length > 0 && (
          <Section title="Recent">
            {recent.map((s) => (
              <StickerButton key={`r-${s.id}`} sticker={s} onPick={pick} />
            ))}
          </Section>
        )}
        <Section title="Stickers">
          {BUILT_IN.map((s) => (
            <StickerButton key={s.id} sticker={s} onPick={pick} />
          ))}
        </Section>
        <Section title="Yours">
          {own.map((s) => (
            <StickerButton
              key={s.id}
              sticker={s}
              onPick={pick}
              onRemove={() => {
                removeOwn(s.id)
                refresh()
              }}
            />
          ))}
          {own.length < MAX_OWN && (
            <button
              type="button"
              onClick={() => input.current?.click()}
              className="grid aspect-square place-items-center rounded-2xl border border-dashed border-line text-muted transition-colors hover:bg-surface-2 hover:text-fg"
              aria-label="Add a sticker of your own"
              title="Add a sticker of your own"
            >
              <Plus className="size-5" aria-hidden />
            </button>
          )}
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              void add(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </Section>
      </div>
    </Popover>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 px-0.5 text-[11px] font-semibold tracking-wider text-faint uppercase">{title}</h3>
      <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-6">{children}</div>
    </section>
  )
}

function StickerButton({ sticker, onPick, onRemove }: { sticker: Sticker; onPick(s: Sticker): void; onRemove?(): void }) {
  return (
    <div className="group/sticker relative">
      <button
        type="button"
        onClick={() => onPick(sticker)}
        aria-label={`Send sticker: ${sticker.label}`}
        title={sticker.label}
        className={cn(
          'grid aspect-square w-full place-items-center rounded-2xl transition-[background-color,scale] hover:bg-surface-2 active:scale-95',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        )}
      >
        {sticker.emoji ? (
          <span className="text-[34px] leading-none" aria-hidden>
            {sticker.emoji}
          </span>
        ) : (
          <img src={sticker.url} alt="" className="size-full rounded-xl object-contain p-1" />
        )}
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove sticker: ${sticker.label}`}
          className="absolute -top-1 -right-1 grid size-5 place-items-center rounded-full bg-surface text-muted opacity-0 shadow-card ring-1 ring-line transition-opacity group-hover/sticker:opacity-100 focus-visible:opacity-100 max-sm:opacity-100"
        >
          <X className="size-3" aria-hidden />
        </button>
      )}
    </div>
  )
}
