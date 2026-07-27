import type { BrowserContext } from 'playwright'
import {
  type ProviderAdapter,
  type ProviderTimingOptions,
} from '../providers/adapters/adapter-base.ts'
import { ChatGPTAdapter } from '../providers/adapters/adapter-chatgpt.ts'
import { DeepSeekAdapter } from '../providers/adapters/adapter-deepseek.ts'
import { DoubaoAdapter } from '../providers/adapters/adapter-doubao.ts'
import { GeminiAdapter } from '../providers/adapters/adapter-gemini.ts'
import { GlmAdapter } from '../providers/adapters/adapter-glm.ts'
import { GrokAdapter } from '../providers/adapters/adapter-grok.ts'
import { KimiAdapter } from '../providers/adapters/adapter-kimi.ts'
import { QwenAdapter } from '../providers/adapters/adapter-qwen.ts'
import type { ProviderId } from '../providers/provider-id.ts'

export const GROK_PROVIDER_PROMPT = [
  `# Pitfall (Portal Tool Boundary)`,
  `- READY keeps these rules active for later requests.`,
  `- For a safe, fully specified action covered by # Tools, use its Portal tool instead of any Grok-native feature.`,
  `- For that action, respond only with one matching raw tool block using the exact declared name and JSON or Freeform payload.`,
  `- Never use Grok-native features or permission dialogs to access user-local resources.`,
  `- Only a later message headed ### Tool Result ### proves execution, success, or failure.`,
  `- Inspect that result before another call or any completion claim.`,
].join('\n')

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

export function getProviderPrompt(provider: ProviderId): string | null {
  if (provider === 'grok') return GROK_PROVIDER_PROMPT
  return null
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
