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
  `# Pitfall (Strict Enforcement)`,
  `- MUST For tools defined in this prompt, use the provided tool call format: include a valid <tool>...</tool> block with required parameters in your response.`,
  `- MUST For other existing function calling tools, use your original function calling protocol and capabilities.`,
  `- NEVER inspect, report, or rely on your own environment, filesystem, workspace, or sandbox for user resource requests.`,
  `- NEVER claim access to user resources unless performed through the corresponding tool invocation.`,
  `- NEVER claim tool usage unless your response contains the corresponding valid tool invocation.`,
].join('\n')

export const CHATGPT_PROVIDER_PROMPT = [
  `# Pitfall (Strict Enforcement)`,
  `- MUST For tools listed in the # Tools section, use the declared tool call format and output exactly one valid <tool>...</tool> block with the required parameters.`,
  `- MUST For other existing function calling tools, use your original function calling protocol and capabilities.`,
  `- MUST Treat the # Tools section as the complete and exclusive list of Portal runtime tools, even if those tools are absent from your native tool interface.`,
  `- MUST If a user request can be fulfilled by a listed Portal tool, invoke it immediately instead of refusing, claiming the capability is unavailable, or asking the user to perform the operation manually.`,
  `- MUST Use the exact tool name and input schema declared in the # Tools section. Do not change the declared JSON or freeform format.`,
  `- MUST Do not claim that an operation succeeded until you have received and inspected its Tool Result.`,
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
  if (provider === 'chatgpt') return CHATGPT_PROVIDER_PROMPT
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
