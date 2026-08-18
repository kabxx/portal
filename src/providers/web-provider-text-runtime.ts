import { randomUUID } from 'node:crypto'
import {
  isProviderAdapterError,
  type ProviderAdapter,
} from './adapters/adapter-base.ts'
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
} from '../runtime/runtime-cancellation.ts'
import {
  checkComposerLimit,
  ComposerLimitExceededError,
  createComposerLimitToolDelivery,
  type ComposerTextOrigin,
} from './composer-limit.ts'
import {
  RuntimeCore,
  type RuntimeCoreHandlers,
  type RuntimeCoreOptions,
} from '../runtime/runtime-core.ts'
import type {
  AttachmentReader,
  AttachmentRef,
} from '../attachments/attachment-contracts.ts'

export type { RuntimeCoreHandlers } from '../runtime/runtime-core.ts'

interface OutboundToolResult {
  toolName: string
  toolResult: ToolResult
}

/**
 * Text Tool extraction is a private web-Provider implementation detail.
 * Kernel RuntimeCore deliberately does not expose this execution loop.
 */
export class WebProviderTextRuntime extends RuntimeCore {
  readonly #toolRegistry: ToolRegistry
  readonly #requestAttemptLimit: number
  readonly #attachmentReader: AttachmentReader | null

  public constructor(
    adapter: ProviderAdapter,
    toolRegistry: ToolRegistry,
    options: RuntimeCoreOptions
  ) {
    super(adapter, options)
    this.#toolRegistry = toolRegistry
    this.#requestAttemptLimit = options.requestAttemptLimit ?? 3
    this.#attachmentReader = options.attachmentReader ?? null
  }

  public override async submitUserInput(
    input: string,
    handlers: RuntimeCoreHandlers = {}
  ): Promise<string> {
    let user = await this.prepareExchangeInput(input, handlers.signal)
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
        await this.#toolRegistry.extractToolCall(assistant)
      throwIfAborted(handlers.signal)
      if (
        extractedToolCall === null ||
        !isToolCallAtResponseEnd(extractedToolCall)
      ) {
        await handlers.onAssistantText?.(assistant)
        return assistant
      }

      const toolPayload = extractedToolCall.rawPayload
      const prepared = this.#toolRegistry.prepareToolCall(
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
      const metadata = {
        toolCallId,
        originalInput: structuredClone(toolCall.params),
        effectiveInput: structuredClone(toolCall.params),
        rewrittenBy: [],
      }
      await handlers.onToolCall?.(toolCall, toolPayload, metadata)

      if (!prepared.ok) {
        await handlers.onToolResult?.(prepared.result, toolCall, metadata)
        user = this.#toolRegistry.formatToolResultMessage(
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

      toolCallCount += 1
      if (
        handlers.maxToolCalls !== undefined &&
        toolCallCount > handlers.maxToolCalls
      ) {
        throw new Error(
          `Runtime exceeded the maximum of ${handlers.maxToolCalls} tool calls`
        )
      }
      const toolResult = await prepared.execute({
        ...(handlers.signal === undefined ? {} : { signal: handlers.signal }),
        onProgress: (event) =>
          handlers.onToolProgress?.(event, toolCall, toolCallId),
        toolCallId,
      })
      throwIfAborted(handlers.signal)
      await this.deliverAttachments(toolResult, handlers.signal)
      throwIfAborted(handlers.signal)
      await handlers.onToolResult?.(toolResult, toolCall, metadata)
      user = this.#toolRegistry.formatToolResultMessage(
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
    if (this.#attachmentReader === null) {
      throw new Error('Attachment delivery is unavailable in this runtime.')
    }
    throwIfAborted(signal)
    await this.getAdapter().attachAttachment(ref, this.#attachmentReader)
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
      this.getAdapter().setSubmitTextReporter(async (message) => {
        throwIfAborted(handlers.signal)
        streamed = true
        await handlers.onAssistantStream?.(
          this.#toolRegistry.projectStreamingAssistantText(message)
        )
      })
      this.getAdapter().setSubmitStatusReporter(async (message) => {
        throwIfAborted(handlers.signal)
        await handlers.onStatus?.(message)
      })
      try {
        await this.getAdapter().attachText(payload)
        throwIfAborted(handlers.signal)
        return await this.getAdapter().submitWithResponseTimeout({
          signal: handlers.signal,
        })
      } finally {
        this.getAdapter().setSubmitTextReporter(null)
        this.getAdapter().setSubmitStatusReporter(null)
      }
    }

    const response = await this.retryProviderRequest(
      submitAttempt,
      { signal: handlers.signal },
      async () => {
        if (streamed) await handlers.onAssistantStreamReset?.()
      }
    )
    throwIfAborted(handlers.signal)
    return response
  }

  private async retryProviderRequest<T>(
    fn: () => Promise<T>,
    options: AbortOptions = {},
    onRetryAttempt?: () => void | Promise<void>
  ): Promise<T> {
    return await retryAsync(fn, {
      maxAttempts: this.#requestAttemptLimit,
      retryIf: async (error, attempt) => {
        if (isAbortError(error) || !isProviderAdapterError(error)) return false
        return error.retryable && attempt + 1 < error.maxAttempts
      },
      onRetry: async (error) => {
        throwIfAborted(options.signal)
        if (isProviderAdapterError(error) && error.recovery === 'restore') {
          await abortable(
            this.getAdapter().restore({ signal: options.signal }),
            options.signal
          )
          throwIfAborted(options.signal)
        }
        await onRetryAttempt?.()
      },
    })
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
      await this.getAdapter().getComposerLimit({ signal })
    )
    throwIfAborted(signal)
    if (check.status !== 'over_limit') return text
    if (origin !== 'tool_result' || outboundToolResult === null) {
      throw new ComposerLimitExceededError(check, origin)
    }
    const replacement = this.#toolRegistry.formatToolResultMessage(
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

  private async emitAssistantTextSegment(
    segment: string,
    handlers: RuntimeCoreHandlers
  ): Promise<void> {
    const normalizedSegment = segment.trim()
    if (normalizedSegment) await handlers.onAssistantText?.(normalizedSegment)
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
