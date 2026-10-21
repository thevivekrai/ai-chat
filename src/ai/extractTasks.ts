import { assertAiCanRead } from './access'
import { simulateLatency } from './latency'
import { cannedTasks } from './mock/canned'
import { heuristicTasks } from './mock/heuristics'
import type { AiThread, ExtractedTask } from './types'

/** Finds to-dos and dates in a chat ("Send invoice by Friday") so they can be added to Tasks. */
export async function extractTasks(thread: AiThread): Promise<ExtractedTask[]> {
  assertAiCanRead(thread.id)

  // TODO(LLM): replace the mock below with a real model call:
  //   const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  //   const raw = await complete(buildTasksPrompt(thread, new Date(), timeZone))
  //   return parseJson<{ tasks: Omit<ExtractedTask, 'id'>[] }>(raw).tasks.map((t, i) => ({ ...t, id: `${t.sourceMessageId}#${i}` }))
  await simulateLatency('tasks')
  const now = Date.now()
  return cannedTasks(thread, now) ?? heuristicTasks(thread, now)
}
