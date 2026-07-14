import { randomUUID } from 'node:crypto'

import { ProviderAdapter } from '../providers/adapters/adapter-base.ts'
import {
  isProviderAdapterError,
  type ProviderAdapterError,
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

export interface ManualSkill {
  name: string
  content: string
}

export type ManualSkillLoader = (name: string) => Promise<ManualSkill | null>

export interface RuntimeCoreHandlers {
  onAssistantStream?: (message: string) => void | Promise<void>
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
  onToolProgress?: (event: ToolProgressEvent, toolCall: ToolCall | null) => void
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

export class RuntimeCore {
  constructor(
    private readonly agentAdapter: ProviderAdapter,
    private readonly toolRegistry: ToolRegistry,
    private readonly providerPrompt: string | null = null,
    private readonly skillPrompt: string | null = null,
    private readonly mcpPrompt: string | null = null,
    private readonly mcpSession: ThreadMcpSession | null = null,
    private readonly manualSkillLoader: ManualSkillLoader | null = null,
    private readonly projectInstructions: ProjectInstructions | null = null,
    private readonly manualSkillNames: readonly string[] = [],
    private readonly hookDispatcher: HookDispatcher | null = null,
    private readonly requestAttemptLimit = 3
  ) {}

  public get availableManualSkillNames(): readonly string[] {
    return this.manualSkillNames
  }

  public async init(options: AbortOptions = {}) {
    await this.retryAsync(async () => {
      throwIfAborted(options.signal)
      await this.agentAdapter.attachText(this.prompt)
      throwIfAborted(options.signal)
      const response =
        await this.agentAdapter.submitWithResponseTimeout(options)
      throwIfAborted(options.signal)
      if (!/\bREADY\b/i.test(response)) {
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
            `- If its "## User Task" section is empty, ask what the user wants to do instead of inventing a task.`,
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
        [
          `# Setup Handshake`,
          `- This message initializes the runtime only.`,
          `- Reply with READY when initialization is complete.`,
        ].join('\n'),
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

  private async retryAsync<T>(
    fn: () => Promise<T>,
    options: AbortOptions = {}
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
    let assistant = ''
    let toolCallCount = 0

    while (true) {
      throwIfAborted(handlers.signal)
      assistant = await this.retryAsync(
        async () => {
          throwIfAborted(handlers.signal)
          await this.agentAdapter.attachText(user)
          throwIfAborted(handlers.signal)
          this.agentAdapter.setSubmitTextReporter(async (message) => {
            throwIfAborted(handlers.signal)
            await handlers.onAssistantStream?.(message)
          })
          this.agentAdapter.setSubmitStatusReporter(async (message) => {
            throwIfAborted(handlers.signal)
            await handlers.onStatus?.(message)
          })
          try {
            const response = await this.agentAdapter.submitWithResponseTimeout({
              signal: handlers.signal,
            })
            throwIfAborted(handlers.signal)
            return response
          } finally {
            this.agentAdapter.setSubmitTextReporter(null)
            this.agentAdapter.setSubmitStatusReporter(null)
          }
        },
        { signal: handlers.signal }
      )

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
              ...metadata!,
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
                ...metadata!,
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
    }
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
      onProgress: (event) => handlers.onToolProgress?.(event, toolCall),
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
