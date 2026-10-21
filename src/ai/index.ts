/**
 * AI features. Each function returns canned results after a short fake delay today; look for
 * TODO(LLM) in each file for where a real model call goes, and see prompts.ts / llm.ts.
 *
 * All functions refuse to run on threads the user has not allowed (see access.ts).
 */
export { draftReply } from './draftReply'
export { summarizeThread } from './summarizeThread'
export { classifyPriority } from './classifyPriority'
export { extractTasks } from './extractTasks'
export { answerQuestion } from './answerQuestion'
export { AiAccessError, canAiRead, setAiAccessPolicy } from './access'
export * from './types'
