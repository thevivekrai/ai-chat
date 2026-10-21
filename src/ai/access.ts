/**
 * Privacy gate. Every AI function checks this before touching a thread, so a chat the user has not
 * allowed can never reach a model, even if some UI path forgets to check.
 *
 * The policy is injected by the settings store ("Allow AI to read selected threads") to keep this
 * module free of UI dependencies. Until a policy is set, everything is denied.
 */
type AccessPolicy = (threadId: string) => boolean

let policy: AccessPolicy = () => false

export function setAiAccessPolicy(next: AccessPolicy) {
  policy = next
}

export function canAiRead(threadId: string): boolean {
  return policy(threadId)
}

export class AiAccessError extends Error {
  readonly threadId: string

  constructor(threadId: string) {
    super(`AI is not allowed to read thread "${threadId}". Turn it on in Settings → Privacy & AI.`)
    this.name = 'AiAccessError'
    this.threadId = threadId
  }
}

export function assertAiCanRead(threadId: string) {
  if (!policy(threadId)) throw new AiAccessError(threadId)
}
