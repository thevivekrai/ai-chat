import { assertAiCanRead } from './access'
import { simulateLatency } from './latency'
import { generate, llmConfigured } from './llm'
import { cannedTasks } from './mock/canned'
import { heuristicTasks } from './mock/heuristics'
import { buildTasksPrompt } from './prompts'
import type { AiThread, ExtractedTask } from './types'

/** Finds to-dos and dates in a chat ("Send invoice by Friday") so they can be added to Tasks. */
export async function extractTasks(thread: AiThread): Promise<ExtractedTask[]> {
  assertAiCanRead(thread.id)

  if (llmConfigured()) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const { tasks } = await generate(buildTasksPrompt(thread, new Date(), timeZone))
    const ids = new Set(thread.messages.map((m) => m.id))
    const fallbackSource = thread.messages.findLast((m) => !m.fromMe)?.id ?? thread.messages.at(-1)?.id ?? ''
    return tasks
      .filter((t) => t.title.trim())
      .map((t, i) => {
        // Keep the model honest: a source that isn't in the chat, or a date that doesn't parse, is dropped.
        const sourceMessageId = ids.has(t.sourceMessageId) ? t.sourceMessageId : fallbackSource
        const due = t.dueAt ? Date.parse(t.dueAt) : NaN
        return {
          id: `${sourceMessageId}#${i}`,
          title: t.title.trim(),
          dueAt: Number.isNaN(due) ? null : new Date(due).toISOString(),
          dueText: Number.isNaN(due) ? null : t.dueText,
          sourceMessageId,
        }
      })
  }

  await simulateLatency('tasks')
  const now = Date.now()
  return cannedTasks(thread, now) ?? heuristicTasks(thread, now)
}
