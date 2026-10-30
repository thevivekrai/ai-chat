import { SECURITY_QUESTIONS, SECURITY_QUESTIONS_NEEDED } from '../../src/data/server/types.ts'
import type { Sealer } from '../crypto.ts'
import type { UserDoc } from '../db.ts'
import { HttpError } from '../http.ts'
import { hashPassword, verifyPassword } from './passwords.ts'

/**
 * Security questions: the last way back into an account whose password and recovery key are both
 * lost. Answers are kept only as scrypt hashes (like passwords), so the database never holds
 * them, and they're compared loosely: "St. Xavier's School" matches "st xaviers school".
 */

export interface SecurityAnswer {
  question: string
  /** scrypt hash of the answer as `normalized` leaves it. */
  answerHash: string
}

/** An answer as it's compared: case, spaces, accents and punctuation don't matter. */
export function normalized(answer: string): string {
  return answer
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** The questions and answers chosen at sign-up (or in Settings), checked and hashed. */
export async function readSecurityAnswers(body: unknown): Promise<SecurityAnswer[]> {
  const given = (body as { securityQuestions?: unknown })?.securityQuestions
  const invalid = new HttpError(400, `Choose ${SECURITY_QUESTIONS_NEEDED} different security questions and answer each one.`)
  if (!Array.isArray(given) || given.length !== SECURITY_QUESTIONS_NEEDED) throw invalid
  const chosen = given.map((item) => {
    const { question, answer } = (item ?? {}) as { question?: unknown; answer?: unknown }
    if (typeof question !== 'string' || !(SECURITY_QUESTIONS as readonly string[]).includes(question)) throw invalid
    if (typeof answer !== 'string' || answer.length > 100) throw invalid
    const plain = normalized(answer)
    if (plain.length < 2) throw new HttpError(400, 'Give a real answer to each security question (at least 2 letters or numbers).')
    return { question, plain }
  })
  if (new Set(chosen.map((c) => c.question)).size !== chosen.length) throw invalid
  if (new Set(chosen.map((c) => c.plain)).size !== chosen.length) throw new HttpError(400, 'Give a different answer to each security question.')
  return Promise.all(chosen.map(async ({ question, plain }) => ({ question, answerHash: await hashPassword(plain) })))
}

/**
 * The questions to ask for an email. One with no account, or with no questions set, gets
 * questions all the same (always the same ones for that email), so asking can't tell anyone
 * whether an account exists or what it chose.
 */
export function questionsFor(email: string, user: UserDoc | null, sealer: Sealer): string[] {
  if (user?.securityQuestions?.length) return user.securityQuestions.map((q) => q.question)
  const tag = sealer.tag(`security-questions:${email}`)
  const first = tag[0]! % SECURITY_QUESTIONS.length
  const second = (first + 1 + (tag[1]! % (SECURITY_QUESTIONS.length - 1))) % SECURITY_QUESTIONS.length
  return [SECURITY_QUESTIONS[first]!, SECURITY_QUESTIONS[second]!]
}

/** Stands in for a missing answer, so a wrong email takes as long to refuse as wrong answers. */
const DECOY = hashPassword('not-a-real-answer')

/** Whether every answer is right. Each one is always checked, so timing gives nothing away. */
export async function answersMatch(user: UserDoc | null, answers: unknown): Promise<boolean> {
  const list = Array.isArray(answers) ? answers : []
  const expected = user?.securityQuestions ?? []
  const checks = await Promise.all(
    Array.from({ length: SECURITY_QUESTIONS_NEEDED }, async (_, i) => {
      const given = typeof list[i] === 'string' ? normalized(list[i] as string).slice(0, 100) : ''
      const hash = expected[i]?.answerHash ?? (await DECOY)
      return (await verifyPassword(given, hash)) && !!expected[i] && given.length >= 2
    }),
  )
  return expected.length === SECURITY_QUESTIONS_NEEDED && checks.every(Boolean)
}
