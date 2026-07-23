export const PROVIDER_IDS = [
  'chatgpt',
  'gemini',
  'deepseek',
  'doubao',
  'grok',
  'glm',
  'qwen',
  'kimi',
] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]
