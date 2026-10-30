import { assertAiCanRead } from './access'
import { generate, LlmError, llmConfigured } from './llm'

/**
 * A message in another language. On the device first: Chrome and Edge translate on the computer
 * itself, so nothing leaves it. Otherwise the AI chosen in Settings, for chats it may read.
 */

export interface Translation {
  text: string
  /** The language it was written in, as a name ("Hindi"), when that's known. */
  from?: string
  by: 'device' | 'ai'
}

interface BrowserTranslator {
  translate(text: string): Promise<string>
}
interface TranslatorApi {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>
  create(options: { sourceLanguage: string; targetLanguage: string }): Promise<BrowserTranslator>
}
interface DetectorApi {
  create(): Promise<{ detect(text: string): Promise<{ detectedLanguage: string; confidence: number }[]> }>
}

const languageName = (code: string, inLanguage: string) => {
  try {
    return new Intl.DisplayNames([inLanguage], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

/** On-device, where the browser has it: null when it can't (no API, or not this pair of languages). */
async function onDevice(text: string, target: string): Promise<Translation | null> {
  const scope = globalThis as unknown as { Translator?: TranslatorApi; LanguageDetector?: DetectorApi }
  if (!scope.Translator || !scope.LanguageDetector) return null
  try {
    const [best] = await (await scope.LanguageDetector.create()).detect(text)
    const source = best?.detectedLanguage
    if (!source || source === 'und' || best.confidence < 0.5) return null
    if (source.split('-')[0] === target.split('-')[0]) return { text, from: languageName(source, target), by: 'device' }
    const availability = await scope.Translator.availability({ sourceLanguage: source, targetLanguage: target })
    if (availability === 'unavailable') return null
    const translator = await scope.Translator.create({ sourceLanguage: source, targetLanguage: target })
    return { text: await translator.translate(text), from: languageName(source, target), by: 'device' }
  } catch {
    return null
  }
}

/** Translates a message into `target` (a language tag such as "en" or "hi-IN"). */
export async function translate(threadId: string, text: string, target: string): Promise<Translation> {
  const local = await onDevice(text, target)
  if (local) return local
  if (!llmConfigured()) throw new LlmError('auth', 'Translating needs an AI here: turn on the shared AI in Settings → AI.')
  assertAiCanRead(threadId)
  const into = languageName(target, 'en')
  const result = await generate({
    task: 'translate',
    system: [
      `Translate the user's message into ${into}. Keep its meaning, tone, names, numbers, emoji and line breaks;`,
      'add nothing and explain nothing. If it is already in that language, return it unchanged.',
      'Romanised Hindi and other languages written in Latin letters count as their language, not English.',
      '"from" is the English name of the language it was written in.',
    ].join(' '),
    user: text,
    effort: 'low',
  })
  return { text: result.text.trim(), from: result.from.trim() || undefined, by: 'ai' }
}
