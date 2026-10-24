/**
 * AI providers a user can bring their own API key for. Claude and Gemini have their own APIs;
 * the rest speak the OpenAI chat API, so any OpenAI-compatible service works under "Other".
 */
/** The app's own AI, run by its server for everyone signed in. */
export const SHARED_AI_NAME = 'Shared AI'

export type KeyProviderId =
  | 'anthropic'
  | 'google'
  | 'openai'
  | 'openrouter'
  | 'groq'
  | 'mistral'
  | 'deepseek'
  | 'xai'
  | 'custom'

export interface KeyProvider {
  id: KeyProviderId
  /** What the user picks, e.g. "Claude (Anthropic)". */
  label: string
  /** The short name used in messages, e.g. "Claude". */
  name: string
  /** Where to create a key. */
  keyUrl?: string
  keyPlaceholder: string
  /** The OpenAI-compatible endpoint; absent for Claude and Gemini, and set by the user for "Other". */
  baseUrl?: string
  model: string
  /** Sorting runs for every allowed chat whenever it changes: a fast model keeps that cheap. */
  triageModel: string
  /** Suggested models; any other model id the key can use works too. */
  models: string[]
}

export const KEY_PROVIDERS: KeyProvider[] = [
  {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    name: 'Claude',
    keyUrl: 'https://platform.claude.com/settings/keys',
    keyPlaceholder: 'sk-ant-…',
    model: 'claude-opus-5-5',
    triageModel: 'claude-haiku-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  },
  {
    id: 'google',
    label: 'Gemini (Google)',
    name: 'Gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyPlaceholder: 'AIza…',
    model: 'gemini-flash-latest',
    triageModel: 'gemini-flash-lite-latest',
    models: ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  },
  {
    id: 'openai',
    label: 'ChatGPT (OpenAI)',
    name: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-…',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5-mini',
    triageModel: 'gpt-5-nano',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (hundreds of models)',
    name: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/settings/keys',
    keyPlaceholder: 'sk-or-…',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
    triageModel: 'openrouter/auto',
    models: ['openrouter/auto'],
  },
  {
    id: 'groq',
    label: 'Groq',
    name: 'Groq',
    keyUrl: 'https://console.groq.com/keys',
    keyPlaceholder: 'gsk_…',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    triageModel: 'llama-3.1-8b-instant',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    name: 'Mistral',
    keyUrl: 'https://console.mistral.ai/api-keys',
    keyPlaceholder: 'Your Mistral key',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-large-latest',
    triageModel: 'mistral-small-latest',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    name: 'DeepSeek',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyPlaceholder: 'sk-…',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    triageModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'xai',
    label: 'Grok (xAI)',
    name: 'Grok',
    keyUrl: 'https://console.x.ai',
    keyPlaceholder: 'xai-…',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4',
    triageModel: 'grok-3-mini',
    models: ['grok-4', 'grok-3-mini'],
  },
  {
    id: 'custom',
    label: 'Other (OpenAI-compatible)',
    name: 'Your AI service',
    keyPlaceholder: 'Your API key',
    model: '',
    triageModel: '',
    models: [],
  },
]

export const keyProvider = (id: KeyProviderId): KeyProvider => KEY_PROVIDERS.find((p) => p.id === id)!

export const isKeyProvider = (id: string): id is KeyProviderId => KEY_PROVIDERS.some((p) => p.id === id)
