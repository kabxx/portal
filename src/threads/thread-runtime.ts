import type { ConversationHistoryResult } from '../providers/conversation-history.ts'
import type { ToolCall, ToolResult } from '../tools/core/tool-registry.ts'
import type { ToolProgressEvent } from '../tools/core/tool-definition.ts'

export interface ThreadRuntimeHandlers {
  readonly onAssistantStream?: (message: string) => void | Promise<void>
  readonly onAssistantStreamReset?: () => void | Promise<void>
  readonly onAssistantText?: (message: string) => void | Promise<void>
  readonly onStatus?: (message: string) => void | Promise<void>
  readonly onToolCall?: (
    toolCall: ToolCall,
    rawPayload: string,
    metadata?: ThreadToolCallMetadata
  ) => void | Promise<void>
  readonly onToolResult?: (
    toolResult: ToolResult,
    toolCall: ToolCall,
    metadata?: ThreadToolCallMetadata
  ) => void | Promise<void>
  readonly onToolProgress?: (
    event: ToolProgressEvent,
    toolCall: ToolCall | null,
    toolCallId: string
  ) => void
  readonly signal?: AbortSignal
  readonly maxToolCalls?: number
}

export interface ThreadToolCallMetadata {
  readonly toolCallId: string
  readonly originalInput: Record<string, unknown> | string
  readonly effectiveInput: Record<string, unknown> | string
  readonly rewrittenBy: readonly string[]
}

export interface ThreadProviderCapabilityState {
  readonly name: string
  readonly state: string
}

export interface ThreadProviderCapabilityCatalog {
  readonly capabilities: readonly ThreadProviderCapabilityState[]
  readonly usage: string
}

export interface ThreadProviderCapabilityResult {
  readonly status:
    'ok' | 'invalid-args' | 'unknown-capability' | 'unsupported-provider'
  readonly message: string
}

/** Kernel-facing runtime for one admitted conversation. */
export interface ThreadRuntime {
  readonly conversationId: string | null
  readonly conversationUrl: string
  preflightInitialInput(
    input: string,
    signal?: AbortSignal
  ): Promise<{ readonly status: 'unknown' | 'within_limit' | 'over_limit' }>
  onUnexpectedPageClose(listener: () => void): () => void
  submitUserInput(
    input: string,
    handlers?: ThreadRuntimeHandlers
  ): Promise<string>
  restore(options?: { readonly signal?: AbortSignal }): Promise<void>
  loadHistory(options?: {
    readonly signal?: AbortSignal
  }): Promise<ConversationHistoryResult>
  stopGeneration(): Promise<void>
  readonly listProviderCapabilities?: (
    signal: AbortSignal
  ) => Promise<ThreadProviderCapabilityCatalog>
  readonly executeProviderCapability?: (
    name: string,
    args: readonly string[],
    signal: AbortSignal
  ) => Promise<ThreadProviderCapabilityResult>
  close(): Promise<void>
}
