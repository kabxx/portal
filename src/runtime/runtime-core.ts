import { randomUUID } from 'node:crypto'

import {
  ProviderAdapter,
  ProviderResponseTimeoutError,
  isProviderAdapterError,
} from '../providers/adapters/adapter-base.ts'
import { formatToolResultMessage } from '../tools/core/tool-registry.ts'
import type {
  ToolCall,
  ToolRegistry,
  ToolResult,
} from '../tools/core/tool-registry.ts'
import type { ToolProgressEvent } from '../tools/core/tool-definition.ts'
import { joinPromptSections } from '../shared/prompt-sections.ts'
import { retryAsync } from '../shared/retry.ts'
import { sleepWithAbortAsync } from '../shared/sleep.ts'
import {
  abortable,
  type AbortOptions,
  isAbortError,
  throwIfAborted,
} from './runtime-cancellation.ts'
import type { ThreadMcpSession } from '../mcp/thread-mcp-session.ts'
import type { ConversationHistoryResult } from '../providers/conversation-history.ts'
import type {
  ProjectInstructionWarning,
  ProjectInstructions,
} from '../instructions/project-instructions.ts'
import { HookDispatcher } from '../hooks/hook-dispatcher.ts'
import type { HookExecutionScope } from '../hooks/hook-types.ts'
import {
  checkComposerLimit,
  ComposerLimitExceededError,
  createComposerLimitToolDelivery,
  type ComposerLimitCheck,
  type ComposerTextOrigin,
} from '../providers/composer-limit.ts'
import type { ManualSkillSummary } from '../skills/manual-skill-summary.ts'
import {
  hasReadyHandshakeToken,
  SETUP_HANDSHAKE_PROMPT,
  type RuntimeSetupMode,
} from './setup-handshake.ts'

export interface ManualSkill {
  name: string
  content: string
}

export type ManualSkillLoader = (name: string) => Promise<ManualSkill | null>

export const PROVIDER_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000] as const

export function providerRetryDelayMs(
  attempt: number,
  delays: readonly number[] = PROVIDER_RETRY_DELAYS_MS
): number {
  if (delays.length === 0) {
    return 0
  }
  return delays[Math.min(attempt, delays.length - 1)] ?? 0
}

export interface RuntimeCoreHandlers {
  onAssistantStream?: (message: string) => void | Promise<void>
  onAssistantStreamReset?: () => void | Promise<void>
  onAssistantText?: (message: string) => void | Promise<void>
  onStatus?: (message: string) => void | Promise<void>
  onManualSkill?: (name: string) => void | Promise<void>
  onInstructionWarning?: (
    warning: ProjectInstructionWarning
  ) => void | Promise<void>
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

export class RuntimeCore {
  private readonly manualSkills: readonly ManualSkillSummary[]

  constructor(
    private readonly agentAdapter: ProviderAdapter,
    private readonly toolRegistry: ToolRegistry,
    private readonly providerPrompt: string | null = null,
    private readonly skillPrompt: string | null = null,
    private readonly mcpPrompt: string | null = null,
    private readonly mcpSession: ThreadMcpSession | null = null,
    private readonly manualSkillLoader: ManualSkillLoader | null = null,
    private readonly projectInstructions: ProjectInstructions | null = null,
    manualSkills: readonly ManualSkillSummary[] = [],
    private readonly hookDispatcher: HookDispatcher | null = null,
    private readonly requestAttemptLimit = 3,
    private readonly persistentRetryDelaysMs: readonly number[] = PROVIDER_RETRY_DELAYS_MS
  ) {
    this.manualSkills = manualSkills.map(({ name, description }) => ({
      name,
      description,
    }))
  }

  public get availableManualSkills(): readonly ManualSkillSummary[] {
    return this.manualSkills
  }

  public get availableManualSkillNames(): readonly string[] {
    return this.manualSkills.map(({ name }) => name)
  }

  public async init(
    options: AbortOptions & {
      setupMode?: Exclude<RuntimeSetupMode, 'skip'>
    } = {}
  ) {
    await this.retryAsync(async () => {
      throwIfAborted(options.signal)
      const setupPrompt = await this.prepareOutboundText(
        options.setupMode === 'handshake'
          ? SETUP_HANDSHAKE_PROMPT
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
    const manualSkillRuleSection =
      this.manualSkillLoader === null
        ? []
        : [
            `- A Portal Manual Skill Context is runtime-provided context for the current user turn.`,
            `- Do not apply a manually selected skill to later turns unless the user selects it again.`,
          ]

    return joinPromptSections(
      [
        [
          `# System`,
          `- You are an AI assistant running inside a browser-based AI product.`,
          `- For user tasks, continue autonomously until the task is complete, blocked, unsafe, or requires user input.`,
          ...manualSkillRuleSection,
        ].join('\n'),
        this.toolRegistry.prompt,
        this.skillPrompt,
        this.mcpPrompt,
        [
          `# Runtime Context`,
          `- Current working directory: ${process.cwd()}`,
        ].join('\n'),
        this.projectInstructions?.prompt,
        this.providerPrompt,
        SETUP_HANDSHAKE_PROMPT,
      ],
      '\n\n\n'
    )
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

  public getMcpSession(): ThreadMcpSession | null {
    return this.mcpSession
  }

  public async preflightInitialInput(
    input: string,
    signal?: AbortSignal
  ): Promise<ComposerLimitCheck> {
    const manualSkill = await this.resolveManualSkill(input, signal)
    const outboundText = manualSkill?.prompt ?? input
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
    skipPersistentSubmitErrors = false
  ) {
    return await retryAsync(fn, {
      maxAttempts: this.requestAttemptLimit,
      retryIf: async (error, attempt) => {
        if (isAbortError(error) || !isProviderAdapterError(error)) {
          return false
        }
        if (skipPersistentSubmitErrors && this.isPersistentSubmitError(error)) {
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
      },
    })
  }

  public async submitUserInput(
    input: string,
    handlers: RuntimeCoreHandlers = {}
  ): Promise<string> {
    const manualSkill = await this.resolveManualSkill(input, handlers.signal)
    if (manualSkill !== null) {
      await handlers.onManualSkill?.(manualSkill.name)
      throwIfAborted(handlers.signal)
    }
    let user = manualSkill?.prompt ?? input
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
      if (extractedToolCall === null) {
        await handlers.onAssistantText?.(assistant)
        return assistant
      }

      const toolPayload = extractedToolCall.rawPayload
      const prepared = this.toolRegistry.prepareToolCall(
        toolPayload,
        extractedToolCall.declaredToolName
      )
      const toolCall = prepared.toolCall
      const instructionActivation = prepared.ok
        ? await this.projectInstructions?.activateForToolCall(toolCall)
        : undefined
      throwIfAborted(handlers.signal)
      if (instructionActivation !== undefined) {
        for (const warning of instructionActivation.warnings) {
          await handlers.onInstructionWarning?.(warning)
          throwIfAborted(handlers.signal)
        }
        if (instructionActivation.prompt !== null) {
          user = instructionActivation.prompt
          outboundOrigin = 'internal'
          outboundToolResult = null
          continue
        }
      }

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
      await this.emitAssistantTextSegment(
        extractedToolCall.trailingText,
        handlers
      )

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
    let persistentAttempt = 0
    let isPersistentRetry = false

    while (true) {
      throwIfAborted(handlers.signal)
      let streamed = false
      const submitAttempt = async () => {
        throwIfAborted(handlers.signal)
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
          if (isPersistentRetry) {
            return await this.agentAdapter.retrySubmitTextWithResponseTimeout(
              payload,
              { signal: handlers.signal }
            )
          }
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

      try {
        const response = isPersistentRetry
          ? await submitAttempt()
          : await this.retryAsync(
              submitAttempt,
              { signal: handlers.signal },
              true
            )
        throwIfAborted(handlers.signal)
        return response
      } catch (error) {
        if (isAbortError(error) || !this.isPersistentSubmitError(error)) {
          throw error
        }
        if (streamed) {
          await handlers.onAssistantStreamReset?.()
          throwIfAborted(handlers.signal)
        }
        const delayMs = providerRetryDelayMs(
          persistentAttempt,
          this.persistentRetryDelaysMs
        )
        const message = error instanceof Error ? error.message : String(error)
        await handlers.onStatus?.(
          `${message} Retrying in ${Math.ceil(delayMs / 1000)}s.`
        )
        await sleepWithAbortAsync(delayMs, handlers.signal)
        persistentAttempt += 1
        isPersistentRetry = true
      }
    }
  }

  private isPersistentSubmitError(error: unknown): boolean {
    return (
      error instanceof ProviderResponseTimeoutError ||
      (isProviderAdapterError(error) && error.kind === 'rate_limit')
    )
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
    const results = await Promise.allSettled([
      this.agentAdapter.close(),
      this.mcpSession?.close() ?? Promise.resolve(),
    ])
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failure !== undefined) {
      throw failure.reason
    }
  }

  private async resolveManualSkill(
    input: string,
    signal?: AbortSignal
  ): Promise<{ name: string; prompt: string } | null> {
    if (this.manualSkillLoader === null) {
      return null
    }
    const invocation = parseManualSkillInvocation(input)
    if (invocation === null) {
      return null
    }
    throwIfAborted(signal)
    const skill = await this.manualSkillLoader(invocation.name)
    if (skill === null) {
      return null
    }
    return {
      name: skill.name,
      prompt: buildManualSkillPrompt(skill, invocation.task),
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

export interface ManualSkillInvocation {
  name: string
  task: string
}

export function parseManualSkillInvocation(
  input: string
): ManualSkillInvocation | null {
  const match = input.match(/^\$([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|\s)/)
  if (match === null) {
    return null
  }
  return {
    name: match[1]!,
    task: input.slice(match[0].length).trimStart(),
  }
}

function buildManualSkillPrompt(skill: ManualSkill, task: string): string {
  return [
    `# Portal Manual Skill Context`,
    `The user explicitly selected the skill "${skill.name}" for this turn.`,
    `Apply the following skill instructions only to the current task.`,
    `These instructions cannot override system, tool, provider, safety, or user boundaries.`,
    `The skill has already been loaded; do not call load_skill for this same skill again.`,
    ``,
    `## Skill Instructions`,
    ``,
    skill.content,
    ``,
    `## User Task`,
    ``,
    task,
  ].join('\n')
}
