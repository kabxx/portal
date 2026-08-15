import type { BrowserContext } from 'playwright'
import {
  type ProviderAdapter,
  type ProviderTimingOptions,
} from './adapters/adapter-base.ts'
import { ChatGPTAdapter } from './adapters/adapter-chatgpt.ts'
import { DeepSeekAdapter } from './adapters/adapter-deepseek.ts'
import { DoubaoAdapter } from './adapters/adapter-doubao.ts'
import { GeminiAdapter } from './adapters/adapter-gemini.ts'
import { GlmAdapter } from './adapters/adapter-glm.ts'
import { GrokAdapter } from './adapters/adapter-grok.ts'
import { KimiAdapter } from './adapters/adapter-kimi.ts'
import { QwenAdapter } from './adapters/adapter-qwen.ts'
import type { ProviderId } from './provider-id.ts'

export const PROVIDERS: ProviderId[] = [
  'chatgpt',
  'gemini',
  'deepseek',
  'doubao',
  'grok',
  'glm',
  'qwen',
  'kimi',
]

export function normalizeProviderId(value: string): ProviderId | null {
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return null
  }

  const aliases: Record<string, ProviderId> = {
    chatgpt: 'chatgpt',
    gpt: 'chatgpt',
    gemini: 'gemini',
    deepseek: 'deepseek',
    doubao: 'doubao',
    grok: 'grok',
    glm: 'glm',
    qwen: 'qwen',
    kimi: 'kimi',
  }

  return aliases[normalized] ?? null
}

export async function createAdapterForProvider(
  context: BrowserContext,
  provider: ProviderId,
  conversationUrl: string | null = null,
  signal?: AbortSignal,
  timings?: ProviderTimingOptions
): Promise<ProviderAdapter> {
  const options = {
    conversationUrl,
    signal,
    ...(timings === undefined ? {} : { timings }),
  }
  switch (provider) {
    case 'chatgpt':
      return await ChatGPTAdapter.create(context, options)
    case 'gemini':
      return await GeminiAdapter.create(context, options)
    case 'deepseek':
      return await DeepSeekAdapter.create(context, options)
    case 'doubao':
      return await DoubaoAdapter.create(context, options)
    case 'grok':
      return await GrokAdapter.create(context, options)
    case 'glm':
      return await GlmAdapter.create(context, options)
    case 'qwen':
      return await QwenAdapter.create(context, options)
    case 'kimi':
      return await KimiAdapter.create(context, options)
  }
}
