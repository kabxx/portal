import type { RuntimeCore } from '../../src/runtime/runtime-core.ts'
import type { ProviderAdapter } from '../../src/providers/adapters/adapter-base.ts'
import type { ThreadMcpSession } from '../../src/mcp/thread-mcp-session.ts'

export interface FakeRuntimeOptions {
  conversationId?: string | null
  conversationUrl?: string
  assistantText?: string
  close?: () => Promise<void>
  stopGeneration?: () => Promise<void>
  adapter?: ProviderAdapter
  submitUserInput?: RuntimeCore['submitUserInput']
  mcpSession?: ThreadMcpSession | null
  manualSkillNames?: readonly string[]
}

export function createFakeRuntime(
  options: FakeRuntimeOptions = {}
): RuntimeCore {
  const assistantText = options.assistantText ?? 'assistant reply'

  return {
    conversationId: options.conversationId ?? null,
    conversationUrl: options.conversationUrl ?? 'https://example.com/thread',
    submitUserInput:
      options.submitUserInput ??
      (async (_input, handlers) => {
        await handlers?.onAssistantText?.(assistantText)
        return assistantText
      }),
    close:
      options.close ??
      (async () => {
        return undefined
      }),
    pause: async () => {
      return undefined
    },
    stopGeneration:
      options.stopGeneration ??
      (async () => {
        return undefined
      }),
    init: async () => {
      return undefined
    },
    getAdapter: () => {
      if (options.adapter === undefined) {
        throw new Error('Fake runtime has no adapter.')
      }
      return options.adapter
    },
    getMcpSession: () => options.mcpSession ?? null,
    availableManualSkillNames: options.manualSkillNames ?? [],
    prompt: '',
  } as RuntimeCore
}
