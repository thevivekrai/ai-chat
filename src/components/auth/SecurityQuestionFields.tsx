import { ShieldQuestion } from 'lucide-react'
import { Input, Select } from '@/components/settings/parts'
import type { SecurityAnswerInput } from '@/data/server/serverApi'
import { SECURITY_QUESTIONS } from '@/data/server/types'

export type ChosenQuestions = SecurityAnswerInput[]

/**
 * Choosing security questions and answering them: at sign-up and in Settings. Each pick leaves out
 * the question already chosen in the other, so the two are always different.
 */
export function SecurityQuestionFields({ value, onChange }: { value: ChosenQuestions; onChange(next: ChosenQuestions): void }) {
  const set = (i: number, patch: Partial<SecurityAnswerInput>) => onChange(value.map((q, j) => (j === i ? { ...q, ...patch } : q)))
  return (
    <fieldset className="space-y-2.5 rounded-2xl border border-line p-3">
      <legend className="flex items-center gap-1.5 px-1 text-[13px] font-medium">
        <ShieldQuestion className="size-4 text-accent-ink" aria-hidden /> Security questions
      </legend>
      <p className="text-[11px] leading-relaxed text-faint">
        If you forget your password and lose your recovery key, these answers get you back in. Pick answers only you
        know, and that aren't on your social profiles. Case and punctuation don't matter.
      </p>
      {value.map((q, i) => (
        <div key={i} className="space-y-1.5">
          <Select aria-label={`Security question ${i + 1}`} value={q.question} onChange={(e) => set(i, { question: e.target.value })}>
            {SECURITY_QUESTIONS.filter((option) => option === q.question || !value.some((other) => other.question === option)).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
          <Input
            required
            aria-label={`Answer ${i + 1}`}
            placeholder="Your answer"
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
            value={q.answer}
            onChange={(e) => set(i, { answer: e.target.value })}
          />
        </div>
      ))}
    </fieldset>
  )
}
