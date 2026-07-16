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

class StubProviderAdapter extends ProviderAdapter {
  public override get conversationId(): string | null {
    return null
  }

  public override get conversationUrl(): string {
    return 'https://example.com/thread'
  }

  public override async restore(): Promise<void> {}

  public override async isLoggedIn(): Promise<boolean> {
    return true
  }

  public override async changeModel(_model: string): Promise<void> {}

  public override async attachText(_text: string): Promise<void> {}

  public override async attachFile(
    _path: string | readonly string[]
  ): Promise<void> {}

  public override async attachImage(
    _path: string | readonly string[]
  ): Promise<void> {}

  public override async submit(): Promise<string> {
    return ''
  }
}

export function createProviderAdapterStub(): ProviderAdapter {
  return new StubProviderAdapter(createBrowserContextStub())
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
