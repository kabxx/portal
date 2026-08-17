export const FIRST_PARTY_PROVIDER_IDS = [
  'chatgpt',
  'gemini',
  'deepseek',
  'doubao',
  'grok',
  'glm',
  'qwen',
  'kimi',
] as const

export type FirstPartyProviderId = (typeof FIRST_PARTY_PROVIDER_IDS)[number]
