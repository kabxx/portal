import {
  RuntimeCore,
  type RuntimeCoreHandlers,
} from '../../src/runtime/runtime-core.ts'
import {
  ProviderAdapter,
  type ProviderBrowserContext,
  type ProviderCdpSession,
  type ProviderPage,
} from '../../src/providers/adapters/adapter-base.ts'
import type { ThreadMcpSession } from '../../src/mcp/thread-mcp-session.ts'
import type { ConversationHistoryResult } from '../../src/providers/conversation-history.ts'
import type { CDPSession, Page } from 'playwright'
import { ToolRegistry } from '../../src/tools/core/tool-registry.ts'

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
  onUnexpectedPageClose?: (listener: () => void) => () => void
  loadHistory?: RuntimeCore['loadHistory']
}

export function createPrototypeObject(prototype: object): unknown {
  const instance: unknown = Object.create(prototype)
  return instance
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
  newPage?: () => Promise<Partial<ProviderPage>>
  newCDPSession?: (page: ProviderPage) => Promise<Partial<ProviderCdpSession>>
}

export function createBrowserContextStub(): ProviderBrowserContext<
  Page,
  CDPSession
>
export function createBrowserContextStub<TPage extends ProviderPage>(
  page: TPage
): ProviderBrowserContext<TPage, CDPSession>
export function createBrowserContextStub(
  page?: ProviderPage
): ProviderBrowserContext<ProviderPage, CDPSession> {
  return {
    newPage: async () => {
      if (page === undefined) {
        throw new Error('The test browser context has no page factory.')
      }
      return page
    },
  }
}

export function createProviderContextStub(
  overrides: BrowserContextStubOverrides
): ProviderBrowserContext<ProviderPage, ProviderCdpSession>
export function createProviderContextStub(
  overrides: BrowserContextStubOverrides
): ProviderBrowserContext<ProviderPage, ProviderCdpSession> {
  return {
    newPage: async () => normalizeProviderPage(await overrides.newPage?.()),
    ...(overrides.newCDPSession === undefined
      ? {}
      : {
          newCDPSession: async (page: ProviderPage) =>
            normalizeProviderCdpSession(await overrides.newCDPSession?.(page)),
        }),
  }
}

function normalizeProviderPage(
  page: Partial<ProviderPage> | undefined
): ProviderPage {
  return {
    close: page?.close ?? (async () => {}),
    pause: page?.pause ?? (async () => {}),
    on: page?.on ?? (() => {}),
    off: page?.off ?? (() => {}),
    isClosed: page?.isClosed ?? (() => false),
    ...(page?.addInitScript === undefined
      ? {}
      : { addInitScript: page.addInitScript }),
    ...(page?.evaluate === undefined ? {} : { evaluate: page.evaluate }),
  }
}

function normalizeProviderCdpSession(
  session: Partial<ProviderCdpSession> | undefined
): ProviderCdpSession {
  return {
    on: session?.on ?? (() => {}),
    send: session?.send ?? (async () => ({})),
    detach: session?.detach ?? (async () => {}),
  }
}

export function createFakeRuntime(
  options: FakeRuntimeOptions = {}
): RuntimeCore {
  return new FakeRuntime(options)
}

class FakeRuntime extends RuntimeCore {
  private readonly adapter: ProviderAdapter

  public constructor(private readonly fakeOptions: FakeRuntimeOptions) {
    const adapter = fakeOptions.adapter ?? createProviderAdapterStub()
    super(adapter, new ToolRegistry(adapter, []))
    this.adapter = adapter
  }

  public override get conversationId(): string | null {
    return this.fakeOptions.conversationId ?? null
  }

  public override get conversationUrl(): string {
    return this.fakeOptions.conversationUrl ?? 'https://example.com/thread'
  }

  public override get availableManualSkillNames(): readonly string[] {
    return this.fakeOptions.manualSkillNames ?? []
  }

  public override get prompt(): string {
    return ''
  }

  public override getAdapter(): ProviderAdapter {
    if (this.fakeOptions.adapter === undefined) {
      throw new Error('Fake runtime has no adapter.')
    }
    return this.adapter
  }

  public override getMcpSession(): ThreadMcpSession | null {
    return this.fakeOptions.mcpSession ?? null
  }

  public override async init(): Promise<void> {}

  public override async submitUserInput(
    input: string,
    handlers: RuntimeCoreHandlers = {}
  ): Promise<string> {
    if (this.fakeOptions.submitUserInput !== undefined) {
      return await this.fakeOptions.submitUserInput(input, handlers)
    }
    const assistantText = this.fakeOptions.assistantText ?? 'assistant reply'
    await handlers.onAssistantText?.(assistantText)
    return assistantText
  }

  public override async pause(): Promise<void> {}

  public override async stopGeneration(): Promise<void> {
    await this.fakeOptions.stopGeneration?.()
  }

  public override onUnexpectedPageClose(listener: () => void): () => void {
    return this.fakeOptions.onUnexpectedPageClose?.(listener) ?? (() => {})
  }

  public override async loadHistory(
    options: Parameters<RuntimeCore['loadHistory']>[0] = {}
  ): Promise<ConversationHistoryResult> {
    return (
      (await this.fakeOptions.loadHistory?.(options)) ?? {
        messages: [],
        complete: true,
        warning: null,
      }
    )
  }

  public override async close(): Promise<void> {
    await this.fakeOptions.close?.()
  }
}
