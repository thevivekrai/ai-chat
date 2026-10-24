/**
 * AI features. Each function calls the AI chosen in Settings → AI (llm.ts): the app's shared AI,
 * or a provider the user brought a key for. Without either it uses the built-in demo AI (mock/),
 * which needs no network.
 *
 * All functions refuse to run on threads the user has not allowed (see access.ts).
 */
export { draftReply } from './draftReply'
export { summarizeThread } from './summarizeThread'
export { classifyPriority } from './classifyPriority'
export { extractTasks } from './extractTasks'
export { answerQuestion } from './answerQuestion'
export { AiAccessError, canAiRead, setAiAccessPolicy } from './access'
export { LlmError, llmConfigured, setLlmConfig, testKey, type LlmConfig, type LlmErrorKind } from './llm'
export { isKeyProvider, KEY_PROVIDERS, keyProvider, SHARED_AI_NAME, type KeyProvider, type KeyProviderId } from './providers'
export * from './types'
