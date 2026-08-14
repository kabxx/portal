import { randomUUID } from 'node:crypto'

import {
  ProviderAdapter,
  isProviderAdapterError,
} from '../providers/adapters/adapter-base.ts'
import {
  formatToolResultMessage,
  isToolCallAtResponseEnd,
} from '../tools/core/tool-registry.ts'
import type {
  ToolCall,
  ToolRegistry,
  ToolResult,
} from '../tools/core/tool-registry.ts'
import type { ToolProgressEvent } from '../tools/core/tool-definition.ts'
import { retryAsync } from '../shared/retry.ts'
import {
  abortable,
  type AbortOptions,
  isAbortError,
  throwIfAborted,
} from './runtime-cancellation.ts'
import type { ConversationHistoryResult } from '../providers/conversation-history.ts'
import type { ProjectInstructions } from '../instructions/project-instructions.ts'
import { HookDispatcher } from '../hooks/hook-dispatcher.ts'
import type { HookExecutionScope } from '../hooks/hook-types.ts'
import {
  checkComposerLimit,
  ComposerLimitExceededError,
  createComposerLimitToolDelivery,
  type ComposerLimitCheck,
  type ComposerTextOrigin,
} from '../providers/composer-limit.ts'
import {
  hasReadyHandshakeToken,
  type RuntimeSetupMode,
} from './setup-handshake.ts'
import {
  buildSetupHandshakePrompt,
  buildSetupPrompt,
  type SetupSkill,
} from './setup-prompt.ts'

export interface RuntimeCoreHandlers {
  onAssistantStream?: (message: string) => void | Promise<void>
  onAssistantStreamReset?: () => void | Promise<void>
  onAssistantText?: (message: string) => void | Promise<void>
  onStatus?: (message: string) => void | Promise<void>
  onToolCall?: (
    toolCall: ToolCall | null,
    rawPayload: string,
    metadata?: ToolCallMetadata
  ) => void | Promise<void>
  onToolResult?: (
    toolResult: ToolResult,
    toolCall: ToolCall | null,
    metadata?: ToolCallMetadata
  ) => void | Promise<void>
  onToolProgress?: (
    event: ToolProgressEvent,
    toolCall: ToolCall | null,
    toolCallId: string
  ) => void
  signal?: AbortSignal
  executionScope?: HookExecutionScope
  maxToolCalls?: number
}

export interface ToolCallMetadata {
  toolCallId: string
  originalInput: Record<string, unknown> | string
  effectiveInput: Record<string, unknown> | string
  rewrittenBy: readonly string[]
}

interface OutboundToolResult {
  toolName: string
  toolResult: ToolResult
}

export interface RuntimeCoreOptions {
  skills?: readonly SetupSkill[]
  projectInstructions?: ProjectInstructions | null
  hookDispatcher?: HookDispatcher | null
  requestAttemptLimit?: number
  workingDirectory?: string
}

export class RuntimeCore {
  private readonly skills: readonly SetupSkill[]
  private readonly projectInstructions: ProjectInstructions | null
  private readonly hookDispatcher: HookDispatcher | null
  private readonly requestAttemptLimit: number
  private readonly workingDirectory: string
  private inlineSetupPending = false

  constructor(
    private readonly agentAdapter: ProviderAdapter,
    private readonly toolRegistry: ToolRegistry,
    options: RuntimeCoreOptions = {}
  ) {
    this.skills = [...(options.skills ?? [])]
    this.projectInstructions = options.projectInstructions ?? null
    this.hookDispatcher = options.hookDispatcher ?? null
    this.requestAttemptLimit = options.requestAttemptLimit ?? 3
    this.workingDirectory = options.workingDirectory ?? process.cwd()
  }

  public async init(
    options: AbortOptions & {
      setupMode?: Exclude<RuntimeSetupMode, 'skip' | 'inline'>
    } = {}
  ) {
    await this.retryAsync(async () => {
      throwIfAborted(options.signal)
      const setupPrompt = await this.prepareOutboundText(
        options.setupMode === 'handshake'
          ? buildSetupHandshakePrompt(this.workingDirectory)
          : this.prompt,
        'internal',
        null,
        options.signal
      )
      await this.agentAdapter.attachText(setupPrompt)
      throwIfAborted(options.signal)
      const response =
        await this.agentAdapter.submitWithResponseTimeout(options)
      throwIfAborted(options.signal)
      if (!hasReadyHandshakeToken(response)) {
        throw new Error(
          'Setup handshake failed: response did not contain READY.'
        )
      }
    }, options)
  }

  public get prompt(): string {
    return buildSetupPrompt({
      tools: this.toolRegistry.prompt,
      skills: this.skills,
      projectInstructions: this.projectInstructions?.prompt ?? null,
      workingDirectory: this.workingDirectory,
    })
  }

  public enableInlineSetup(): void {
    this.inlineSetupPending = true
  }

  public buildInlineTaskPrompt(input: string): string {
    return buildSetupPrompt({
      tools: this.toolRegistry.prompt,
      skills: this.skills,
      projectInstructions: this.projectInstructions?.prompt ?? null,
      workingDirectory: this.workingDirectory,
      task: input,
    })
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
    const outboundText = this.inlineSetupPending
      ? this.buildInlineTaskPrompt(input)
      : input
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
    let user = input
    if (this.inlineSetupPending) {
      user = this.buildInlineTaskPrompt(user)
      this.inlineSetupPending = false
    }
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
      const toolCall = prepared.toolCall
      await this.emitAssistantTextSegment(
        extractedToolCall.leadingText,
        handlers
      )
      const toolCallId = randomUUID()
      let metadata: ToolCallMetadata =
        toolCall === null
          ? {
              toolCallId,
              originalInput: toolPayload,
              effectiveInput: toolPayload,
              rewrittenBy: [],
            }
          : {
              toolCallId,
              originalInput: structuredClone(toolCall.params),
              effectiveInput: structuredClone(toolCall.params),
              rewrittenBy: [],
            }
      await handlers.onToolCall?.(toolCall, toolPayload, metadata)

      if (!prepared.ok) {
        await handlers.onToolResult?.(prepared.result, toolCall, metadata)
        user = formatToolResultMessage(
          toolCall?.tool ?? 'unknown',
          prepared.result
        )
        outboundOrigin = 'tool_result'
        outboundToolResult = {
          toolName: toolCall?.tool ?? 'unknown',
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

      let effectivePrepared = prepared
      let toolResult: ToolResult
      let toolExecutionStarted = false
      let toolExecutionSettled = false
      const executeTool = async (
        current: typeof effectivePrepared,
        currentCall: ToolCall
      ) => {
        toolExecutionStarted = true
        try {
          const result = await this.executePreparedTool(
            current,
            handlers,
            currentCall,
            toolCallId
          )
          toolExecutionSettled = true
          return result
        } catch (error) {
          if (!isAbortError(error)) toolExecutionSettled = true
          throw error
        }
      }
      const scope = handlers.executionScope
      try {
        if (this.hookDispatcher !== null && scope !== undefined) {
          const beforeEvent = this.hookDispatcher.createEvent(
            'tool.before',
            scope,
            {
              tool: executableToolCall.tool,
              params: structuredClone(executableToolCall.params),
              originalInput: structuredClone(executableToolCall.params),
            },
            { toolCallId }
          )
          const decision = await this.hookDispatcher.dispatch(
            beforeEvent,
            scope,
            handlers.signal
          )
          if (decision.action === 'deny') {
            metadata = {
              ...metadata,
              rewrittenBy: decision.rewrittenBy,
            }
            toolResult = hookBlockedResult(
              'HOOK_BLOCKED',
              decision.reason,
              decision.handler,
              metadata
            )
          } else {
            if (decision.action === 'rewrite') {
              const rewrittenCall: ToolCall = {
                tool: executableToolCall.tool,
                params: decision.params,
              }
              const rewritten = this.toolRegistry.prepareParsedToolCall(
                rewrittenCall,
                extractedToolCall.declaredToolName !== null
              )
              metadata = {
                ...metadata,
                effectiveInput: structuredClone(decision.params),
                rewrittenBy: decision.rewrittenBy,
              }
              if (!rewritten.ok) {
                toolResult = hookBlockedResult(
                  'HOOK_INVALID_REWRITE',
                  rewritten.result.displayText ??
                    'Hook rewrite failed validation',
                  decision.rewrittenBy.at(-1) ?? 'unknown',
                  metadata
                )
              } else {
                effectivePrepared = rewritten
                toolResult = await executeTool(effectivePrepared, rewrittenCall)
              }
            } else {
              toolResult = await executeTool(
                effectivePrepared,
                executableToolCall
              )
            }
          }
        } else {
          toolResult = await executeTool(effectivePrepared, executableToolCall)
        }
        throwIfAborted(handlers.signal)
      } catch (error) {
        if (
          this.hookDispatcher !== null &&
          scope !== undefined &&
          isAbortError(error)
        ) {
          await this.hookDispatcher.dispatch(
            this.hookDispatcher.createEvent(
              'tool.after',
              scope,
              {
                tool: executableToolCall.tool,
                outcome:
                  toolExecutionStarted && !toolExecutionSettled
                    ? 'unknown'
                    : 'cancelled',
                originalInput: metadata?.originalInput,
                effectiveInput: metadata?.effectiveInput,
                rewrittenBy: metadata?.rewrittenBy ?? [],
              },
              { toolCallId }
            ),
            scope
          )
        }
        throw error
      }
      if (this.hookDispatcher !== null && scope !== undefined) {
        await this.hookDispatcher.dispatch(
          this.hookDispatcher.createEvent(
            'tool.after',
            scope,
            {
              tool: executableToolCall.tool,
              outcome:
                toolResult.result.code === 'HOOK_BLOCKED' ||
                toolResult.result.code === 'HOOK_INVALID_REWRITE'
                  ? 'blocked'
                  : toolResult.outcome === 'success'
                    ? 'completed'
                    : 'failed',
              result: toolResult.result,
              originalInput: metadata?.originalInput,
              effectiveInput: metadata?.effectiveInput,
              rewrittenBy: metadata?.rewrittenBy ?? [],
            },
            { toolCallId }
          ),
          scope
        )
      }
      await handlers.onToolResult?.(toolResult, toolCall, metadata)
      user = formatToolResultMessage(toolCall?.tool ?? 'unknown', toolResult)
      outboundOrigin = 'tool_result'
      outboundToolResult = {
        toolName: toolCall?.tool ?? 'unknown',
        toolResult,
      }
    }
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
        await handlers.onAssistantStream?.(message)
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
    const replacement = formatToolResultMessage(
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
      ...(handlers.executionScope === undefined
        ? {}
        : { executionScope: handlers.executionScope }),
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
    await this.agentAdapter.close()
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

function hookBlockedResult(
  code: 'HOOK_BLOCKED' | 'HOOK_INVALID_REWRITE',
  message: string,
  handler: string,
  metadata: ToolCallMetadata
): ToolResult {
  return {
    outcome: 'error',
    result: {
      code,
      message,
      handler,
      originalInput: metadata.originalInput,
      effectiveInput: metadata.effectiveInput,
      rewrittenBy: metadata.rewrittenBy,
    },
    displayText: message,
  }
}
