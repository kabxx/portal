import { randomUUID } from 'node:crypto'

import {
  ProviderAdapter,
  isProviderAdapterError,
} from '../providers/adapters/adapter-base.ts'
import { isToolCallAtResponseEnd } from '../tools/core/tool-registry.ts'
import type {
  PreparedToolCall,
  ToolCall,
  ToolRegistry,
  ToolResult,
} from '../tools/core/tool-registry.ts'
import { retryAsync } from '../shared/retry.ts'
import {
  abortable,
  type AbortOptions,
  isAbortError,
  throwIfAborted,
} from './runtime-cancellation.ts'
import type { ConversationHistoryResult } from '../providers/conversation-history.ts'
import type {
  AttachmentReader,
  AttachmentRef,
} from '../attachments/attachment-contracts.ts'
import {
  checkComposerLimit,
  ComposerLimitExceededError,
  createComposerLimitToolDelivery,
  type ComposerLimitCheck,
  type ComposerTextOrigin,
} from '../providers/composer-limit.ts'
import { type AgentSession } from '../agents/agent-extension.ts'
import type {
  ThreadRuntimeHandlers,
  ThreadToolCallMetadata,
} from '../threads/thread-runtime.ts'

export type RuntimeCoreHandlers = ThreadRuntimeHandlers
export type ToolCallMetadata = ThreadToolCallMetadata

interface OutboundToolResult {
  toolName: string
  toolResult: ToolResult
}

export interface RuntimeCoreOptions {
  agentSession: AgentSession | null
  requestAttemptLimit?: number
  attachmentReader?: AttachmentReader
  exchangeDelegate?: (
    input: string,
    handlers: RuntimeCoreHandlers
  ) => Promise<string>
  onClose?: () => void | Promise<void>
}

export class RuntimeCore {
  private readonly agentSession: AgentSession | null
  private readonly requestAttemptLimit: number
  private readonly attachmentReader: AttachmentReader | null
  private readonly exchangeDelegate: RuntimeCoreOptions['exchangeDelegate']
  private readonly onClose: RuntimeCoreOptions['onClose']

  constructor(
    private readonly agentAdapter: ProviderAdapter,
    private readonly toolRegistry: ToolRegistry,
    options: RuntimeCoreOptions
  ) {
    this.agentSession = options.agentSession
    this.requestAttemptLimit = options.requestAttemptLimit ?? 3
    this.attachmentReader = options.attachmentReader ?? null
    this.exchangeDelegate = options.exchangeDelegate
    this.onClose = options.onClose
  }

  public async init(options: AbortOptions = {}) {
    const initialization = this.agentSession?.initialization ?? null
    if (initialization === null) return
    await this.retryAsync(async () => {
      throwIfAborted(options.signal)
      const setupPrompt = await this.prepareOutboundText(
        initialization.prompt,
        'internal',
        null,
        options.signal
      )
      await this.agentAdapter.attachText(setupPrompt)
      throwIfAborted(options.signal)
      const response =
        await this.agentAdapter.submitWithResponseTimeout(options)
      throwIfAborted(options.signal)
      if (!initialization.accepts(response)) {
        throw new Error(
          'Agent initialization failed: response was not accepted.'
        )
      }
    }, options)
  }

  public async prepareExchangeInput(input: string): Promise<string> {
    return this.agentSession === null
      ? input
      : await this.agentSession.prepareInput(input)
  }

  public get conversationId(): string | null {
    return this.agentAdapter.conversationId
  }

  public get conversationUrl(): string {
    return this.agentAdapter.conversationUrl
  }

  public getAdapter(): ProviderAdapter {
    return this.agentAdapter
  }

  public async preflightInitialInput(
    input: string,
    signal?: AbortSignal
  ): Promise<ComposerLimitCheck> {
    const outboundText =
      this.agentSession === null
        ? input
        : await this.agentSession.previewInput(input)
    const limit = await this.agentAdapter.getComposerLimit({ signal })
    throwIfAborted(signal)
    return checkComposerLimit(outboundText, limit)
  }

  public onUnexpectedPageClose(listener: () => void): () => void {
    return this.agentAdapter.onUnexpectedPageClose(listener)
  }

  private async retryAsync<T>(
    fn: () => Promise<T>,
    options: AbortOptions = {},
    onRetryAttempt?: () => void | Promise<void>
  ) {
    return await retryAsync(fn, {
      maxAttempts: this.requestAttemptLimit,
      retryIf: async (error, attempt) => {
        if (isAbortError(error) || !isProviderAdapterError(error)) {
          return false
        }
        if (!error.retryable) {
          return false
        }
        return attempt + 1 < error.maxAttempts
      },
      onRetry: async (error) => {
        throwIfAborted(options.signal)
        if (!isProviderAdapterError(error)) {
          return
        }
        if (error.recovery === 'restore') {
          await abortable(
            this.agentAdapter.restore({ signal: options.signal }),
            options.signal
          )
          throwIfAborted(options.signal)
        }
        await onRetryAttempt?.()
      },
    })
  }

  public async submitUserInput(
    input: string,
    handlers: RuntimeCoreHandlers = {}
  ): Promise<string> {
    if (this.exchangeDelegate !== undefined) {
      return await this.exchangeDelegate(input, handlers)
    }
    let user = await this.prepareExchangeInput(input)
    let outboundOrigin: ComposerTextOrigin = 'user'
    let outboundToolResult: OutboundToolResult | null = null
    let assistant: string
    let toolCallCount = 0

    while (true) {
      throwIfAborted(handlers.signal)
      const outboundText = await this.prepareOutboundText(
        user,
        outboundOrigin,
        outboundToolResult,
        handlers.signal
      )
      assistant = await this.submitPayloadWithRetry(outboundText, handlers)

      const extractedToolCall =
        await this.toolRegistry.extractToolCall(assistant)
      throwIfAborted(handlers.signal)
      if (
        extractedToolCall === null ||
        !isToolCallAtResponseEnd(extractedToolCall)
      ) {
        await handlers.onAssistantText?.(assistant)
        return assistant
      }

      const toolPayload = extractedToolCall.rawPayload
      const prepared = this.toolRegistry.prepareToolCall(
        toolPayload,
        extractedToolCall.declaredToolName
      )
      const toolCall = requirePreparedToolCall(
        prepared,
        extractedToolCall.declaredToolName,
        toolPayload
      )
      await this.emitAssistantTextSegment(
        extractedToolCall.leadingText,
        handlers
      )
      const toolCallId = randomUUID()
      const metadata: ToolCallMetadata = {
        toolCallId,
        originalInput: structuredClone(toolCall.params),
        effectiveInput: structuredClone(toolCall.params),
        rewrittenBy: [],
      }
      await handlers.onToolCall?.(toolCall, toolPayload, metadata)

      if (!prepared.ok) {
        await handlers.onToolResult?.(prepared.result, toolCall, metadata)
        user = this.toolRegistry.formatToolResultMessage(
          toolCall.tool,
          prepared.result
        )
        outboundOrigin = 'tool_result'
        outboundToolResult = {
          toolName: toolCall.tool,
          toolResult: prepared.result,
        }
        continue
      }
      const executableToolCall = prepared.toolCall
      toolCallCount += 1
      if (
        handlers.maxToolCalls !== undefined &&
        toolCallCount > handlers.maxToolCalls
      ) {
        throw new Error(
          `Runtime exceeded the maximum of ${handlers.maxToolCalls} tool calls`
        )
      }

      const toolResult = await this.executePreparedTool(
        prepared,
        handlers,
        executableToolCall,
        toolCallId
      )
      throwIfAborted(handlers.signal)
      await this.deliverAttachments(toolResult, handlers.signal)
      throwIfAborted(handlers.signal)
      await handlers.onToolResult?.(toolResult, toolCall, metadata)
      user = this.toolRegistry.formatToolResultMessage(
        toolCall.tool,
        toolResult
      )
      outboundOrigin = 'tool_result'
      outboundToolResult = {
        toolName: toolCall.tool,
        toolResult,
      }
    }
  }

  private async deliverAttachments(
    toolResult: ToolResult,
    signal?: AbortSignal
  ): Promise<void> {
    const ref = attachmentRef(toolResult.result.attachment)
    if (ref === null) return
    if (this.attachmentReader === null) {
      throw new Error('Attachment delivery is unavailable in this runtime.')
    }
    throwIfAborted(signal)
    await this.agentAdapter.attachAttachment(ref, this.attachmentReader)
  }

  private async submitPayloadWithRetry(
    payload: string,
    handlers: RuntimeCoreHandlers
  ): Promise<string> {
    throwIfAborted(handlers.signal)
    let streamed = false
    const submitAttempt = async () => {
      throwIfAborted(handlers.signal)
      streamed = false
      this.agentAdapter.setSubmitTextReporter(async (message) => {
        throwIfAborted(handlers.signal)
        streamed = true
        await handlers.onAssistantStream?.(
          this.toolRegistry.projectStreamingAssistantText(message)
        )
      })
      this.agentAdapter.setSubmitStatusReporter(async (message) => {
        throwIfAborted(handlers.signal)
        await handlers.onStatus?.(message)
      })
      try {
        await this.agentAdapter.attachText(payload)
        throwIfAborted(handlers.signal)
        return await this.agentAdapter.submitWithResponseTimeout({
          signal: handlers.signal,
        })
      } finally {
        this.agentAdapter.setSubmitTextReporter(null)
        this.agentAdapter.setSubmitStatusReporter(null)
      }
    }

    const response = await this.retryAsync(
      submitAttempt,
      { signal: handlers.signal },
      async () => {
        if (streamed) {
          await handlers.onAssistantStreamReset?.()
        }
      }
    )
    throwIfAborted(handlers.signal)
    return response
  }

  private async prepareOutboundText(
    text: string,
    origin: ComposerTextOrigin,
    outboundToolResult: OutboundToolResult | null,
    signal?: AbortSignal
  ): Promise<string> {
    throwIfAborted(signal)
    const check = checkComposerLimit(
      text,
      await this.agentAdapter.getComposerLimit({ signal })
    )
    throwIfAborted(signal)
    if (check.status !== 'over_limit') {
      return text
    }
    if (origin !== 'tool_result' || outboundToolResult === null) {
      throw new ComposerLimitExceededError(check, origin)
    }
    const replacement = this.toolRegistry.formatToolResultMessage(
      outboundToolResult.toolName,
      outboundToolResult.toolResult,
      createComposerLimitToolDelivery(check)
    )
    const replacementCheck = checkComposerLimit(replacement, check.limit)
    if (replacementCheck.status === 'over_limit') {
      throw new ComposerLimitExceededError(replacementCheck, origin)
    }
    return replacement
  }

  private async executePreparedTool(
    prepared: Extract<
      ReturnType<ToolRegistry['prepareToolCall']>,
      { ok: true }
    >,
    handlers: RuntimeCoreHandlers,
    toolCall: ToolCall,
    toolCallId: string
  ): Promise<ToolResult> {
    return await prepared.execute({
      ...(handlers.signal === undefined ? {} : { signal: handlers.signal }),
      onProgress: (event) =>
        handlers.onToolProgress?.(event, toolCall, toolCallId),
      toolCallId,
    })
  }

  public async pause() {
    await this.agentAdapter.pause()
  }

  public async restore(options: AbortOptions = {}) {
    await this.agentAdapter.restore(options)
  }

  public async loadHistory(
    options: AbortOptions = {}
  ): Promise<ConversationHistoryResult> {
    try {
      return await this.agentAdapter.loadHistory(options)
    } finally {
      await this.agentAdapter.finishHistoryCapture()
    }
  }

  public async stopGeneration() {
    await this.agentAdapter.stopGeneration()
  }

  public async close() {
    const outcomes = await Promise.allSettled([
      this.agentAdapter.close(),
      Promise.resolve().then(async () => await this.agentSession?.close?.()),
      Promise.resolve().then(async () => await this.onClose?.()),
    ])
    const failures = outcomes
      .filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === 'rejected'
      )
      .map(({ reason }) => reason as unknown)
    if (failures.length > 0) {
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, 'Runtime close failed.')
    }
  }

  private async emitAssistantTextSegment(
    segment: string,
    handlers: RuntimeCoreHandlers
  ) {
    const normalizedSegment = segment.trim()
    if (!normalizedSegment) {
      return
    }
    await handlers.onAssistantText?.(normalizedSegment)
  }
}

function requirePreparedToolCall(
  prepared: PreparedToolCall,
  declaredToolName: string | null,
  rawPayload: string
): ToolCall {
  if (prepared.ok) return prepared.toolCall
  if (prepared.toolCall !== null) return prepared.toolCall
  if (declaredToolName !== null) {
    return { tool: declaredToolName, params: rawPayload }
  }
  throw new Error(prepared.result.displayText ?? 'Invalid Tool call.')
}

function attachmentRef(value: unknown): AttachmentRef | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('mediaType' in value) ||
    typeof value.mediaType !== 'string' ||
    !('sizeBytes' in value) ||
    typeof value.sizeBytes !== 'number' ||
    !('sha256' in value) ||
    typeof value.sha256 !== 'string'
  ) {
    return null
  }
  return {
    id: value.id,
    mediaType: value.mediaType,
    sizeBytes: value.sizeBytes,
    sha256: value.sha256,
  }
}
