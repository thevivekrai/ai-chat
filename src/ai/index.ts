/**
 * AI features. With a Claude API key configured each function calls Claude (llm.ts, claude.ts);
 * without one it uses the built-in demo AI (mock/), which needs no network.
 *
 * All functions refuse to run on threads the user has not allowed (see access.ts).
 */
export { draftReply } from './draftReply'
export { summarizeThread } from './summarizeThread'
export { classifyPriority } from './classifyPriority'
export { extractTasks } from './extractTasks'
export { answerQuestion } from './answerQuestion'
export { AiAccessError, canAiRead, setAiAccessPolicy } from './access'
export {
  CLAUDE_MODELS,
  LlmError,
  llmConfigured,
  setLlmConfig,
  testClaudeKey,
  type ClaudeModel,
  type LlmConfig,
  type LlmErrorKind,
} from './llm'
export * from './types'
