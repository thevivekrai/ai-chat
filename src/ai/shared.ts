/**
 * The app's shared AI: requests go to this app's server, which calls Gemini with the server's own
 * key (server/ai.ts), so signed-in users get real AI without a key of their own.
 */
import { LlmError, type LlmErrorKind, type LlmOutputs, type LlmRequest, type LlmTask } from './llm'
import { SHARED_AI_NAME } from './providers'
import { parseOutput } from './schemas'

export async function runShared<K extends LlmTask>(request: LlmRequest<K>): Promise<LlmOutputs[K]> {
  let res: Response
  try {
    res = await fetch('/api/ai/generate', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
  } catch {
    throw new LlmError('network', "Can't reach the server. Check your connection and try again.")
  }
  const data = (await res.json().catch(() => null)) as { output?: unknown; error?: string; kind?: LlmErrorKind } | null
  if (res.ok && data?.output !== undefined) {
    // Checked again here: the answer is used as it is.
    return parseOutput(request.task, JSON.stringify(data.output), SHARED_AI_NAME)
  }
  if (res.status === 401) throw new LlmError('auth', 'Sign in again to use the shared AI.')
  throw new LlmError(data?.kind ?? 'overloaded', data?.error ?? `The shared AI isn't answering (${res.status}). Try again shortly.`)
}
