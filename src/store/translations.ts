import { create } from 'zustand'
import { AiAccessError, translate } from '@/ai'
import { turnOnAi } from './actions'
import { describeAiError } from './ai'
import { toast } from './toasts'

/**
 * Messages translated on request, kept per message and language so translating one again (or
 * flipping back and forth with the original) costs nothing.
 */

export interface TranslationEntry {
  status: 'loading' | 'ready' | 'error'
  text?: string
  from?: string
}

interface TranslationsState {
  entries: Record<string, TranslationEntry>
  /** Messages showing their translation rather than the original. */
  showing: Record<string, boolean>
  translateMessage(threadId: string, messageId: string, text: string): void
  showOriginal(messageId: string): void
}

/** The language to translate into: the one the device is set to. */
export const targetLanguage = () => (typeof navigator === 'undefined' ? 'en' : navigator.language || 'en')

export const keyOf = (messageId: string, language: string) => `${messageId}\u0000${language}`

export const useTranslations = create<TranslationsState>()((set, get) => ({
  entries: {},
  showing: {},

  translateMessage(threadId, messageId, text) {
    const key = keyOf(messageId, targetLanguage())
    set((s) => ({ showing: { ...s.showing, [messageId]: true } }))
    const known = get().entries[key]
    if (known && known.status !== 'error') return
    set((s) => ({ entries: { ...s.entries, [key]: { status: 'loading' } } }))
    translate(threadId, text, targetLanguage())
      .then((result) => set((s) => ({ entries: { ...s.entries, [key]: { status: 'ready', text: result.text, ...(result.from ? { from: result.from } : {}) } } })))
      .catch((error: unknown) => {
        set((s) => ({ entries: { ...s.entries, [key]: { status: 'error' } }, showing: { ...s.showing, [messageId]: false } }))
        // The AI only reads chats it's been allowed: asking to translate is the moment to offer that.
        if (error instanceof AiAccessError) {
          toast({
            title: 'AI is off for this chat',
            description: 'Translating sends this message to the AI. Allow it for this chat to translate.',
            group: 'translate',
            action: {
              label: 'Allow and translate',
              run: () => {
                turnOnAi({ threadIds: [threadId], quiet: true })
                get().translateMessage(threadId, messageId, text)
              },
            },
          })
          return
        }
        toast({ title: "Couldn't translate", description: describeAiError(error), group: 'translate' })
      })
  },

  showOriginal: (messageId) => set((s) => ({ showing: { ...s.showing, [messageId]: false } })),
}))
