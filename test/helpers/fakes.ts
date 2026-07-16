import type { RuntimeCore } from '../../src/runtime/runtime-core.ts'
import { ProviderAdapter } from '../../src/providers/adapters/adapter-base.ts'
import type { ThreadMcpSession } from '../../src/mcp/thread-mcp-session.ts'
import type { BrowserContext } from 'playwright'

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

export function createPrototypeObject(prototype: object): unknown {
  const instance: unknown = Object.create(prototype)
  return instance
}

export function setTestProperty(
  target: object,
  key: PropertyKey,
  value: unknown
): void {
  if (!Reflect.set(target, key, value)) {
    throw new Error(`Failed to set test property: ${String(key)}`)
  }
}

export function createProviderAdapterStub(): ProviderAdapter {
  return createPrototypeObject(ProviderAdapter.prototype) as ProviderAdapter
}

interface BrowserContextStubOverrides {
  newPage?: () => Promise<unknown>
  newCDPSession?: (page: unknown) => Promise<unknown>
}

export function createBrowserContextStub(
  overrides: BrowserContextStubOverrides = {}
): BrowserContext {
  return overrides as BrowserContext
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
