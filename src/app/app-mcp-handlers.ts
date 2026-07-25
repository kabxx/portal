import type { ProjectInstructionWarning } from '../instructions/project-instructions.ts'
import { ApiHttpError } from '../api/api-server.ts'
import type { McpMessageOperationStore } from '../mcp-server/mcp-message-operations.ts'
import type {
  PortalMcpHandlers,
  PortalMcpThreadSummary,
} from '../mcp-server/mcp-server-types.ts'
import { resolveConversationUrl } from '../providers/provider-conversation-url.ts'
import { resolveProviderModel } from '../providers/provider-model-catalog.ts'
import {
  isAbortError,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'
import type { TerminalController } from '../terminal-ui/terminal-controller.ts'
import type {
  ProvisionResult,
  ThreadLifecycleService,
} from '../threads/thread-lifecycle-service.ts'
import type { ThreadManager } from '../threads/thread-manager.ts'
import type { ThreadOperationCoordinator } from '../threads/thread-operation-coordinator.ts'
import { buildThreadHistoryTitle } from '../threads/thread-store.ts'
import {
  stopMcpForegroundOperation,
  type McpForegroundOperation,
  type StopTarget,
} from './app-lifecycle.ts'
import { PROVIDERS, normalizeProviderId } from './app-provider-catalog.ts'

export interface McpHandlerDependencies {
  threadManager: ThreadManager
  threadOperations: ThreadOperationCoordinator
  threadLifecycle: ThreadLifecycleService
  ui: TerminalController
  messageOperations: McpMessageOperationStore
  foregroundOperations: Set<McpForegroundOperation>
  shutdownCloseTimeoutMs: number
  isForegroundOperationActive: () => boolean
  withCancellableOperation: <T>(
    stopTarget: StopTarget | null,
    runOperation: (
      signal: AbortSignal,
      setStopTarget: (target: StopTarget | null) => void
    ) => Promise<T>
  ) => Promise<T>
}

export function createMcpHandlers({
  threadManager,
  threadOperations,
  threadLifecycle,
  ui,
  messageOperations,
  foregroundOperations,
  shutdownCloseTimeoutMs,
  isForegroundOperationActive,
  withCancellableOperation,
}: McpHandlerDependencies): PortalMcpHandlers {
  const getThread = (threadId: string) => {
    const thread = threadManager.getThread(threadId)
    if (thread === null) {
      throw new Error(`Unknown thread: ${threadId}`)
    }
    return thread
  }

  const toThreadSummary = (threadId: string): PortalMcpThreadSummary => {
    const thread = getThread(threadId)
    return {
      id: thread.id,
      provider: thread.provider,
      title: thread.title,
      conversationUrl: thread.runtime.conversationUrl,
      busy: threadOperations.get(thread.id) !== null,
      turnCount: thread.turnCount,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    }
  }

  const withForegroundOperation = async <T>(
    requestSignal: AbortSignal,
    runOperation: (
      signal: AbortSignal,
      setStopTarget: (target: StopTarget | null) => void
    ) => Promise<T>
  ): Promise<T> => {
    if (isForegroundOperationActive()) {
      throw new Error('Another foreground operation is already running.')
    }
    throwIfAborted(requestSignal)
    const controller = new AbortController()
    const operation: McpForegroundOperation = {
      controller,
      stopTarget: null,
      done: Promise.resolve(),
      cancellation: null,
    }
    foregroundOperations.add(operation)
    const stopAfterRequestAbort = () => {
      void stopMcpForegroundOperation(operation, shutdownCloseTimeoutMs)
    }
    requestSignal.addEventListener('abort', stopAfterRequestAbort, {
      once: true,
    })
    try {
      const done = withCancellableOperation(
        null,
        async (operationSignal, setStopTarget) =>
          await runOperation(
            AbortSignal.any([
              requestSignal,
              controller.signal,
              operationSignal,
            ]),
            (target) => {
              operation.stopTarget = target
              setStopTarget(target)
            }
          )
      )
      operation.done = done
      return await done
    } finally {
      requestSignal.removeEventListener('abort', stopAfterRequestAbort)
      foregroundOperations.delete(operation)
    }
  }

  return {
    listProviders: () => ({ providers: [...PROVIDERS] }),
    listThreads: () => ({
      threads: threadManager.listThreads().map(({ id }) => toThreadSummary(id)),
    }),
    getThread: async (threadId) => toThreadSummary(threadId),
    createThread: async (
      { provider: providerValue, model, option, mode },
      signal
    ) => {
      const provider = normalizeProviderId(providerValue)
      if (provider === null) {
        throw new Error(`Unsupported provider: ${providerValue}`)
      }
      const resolvedModel = resolveProviderModel(provider, model, option)
      const created = await withForegroundOperation(
        signal,
        async (operationSignal, setStopTarget) => {
          void setStopTarget
          return requireProvisionResult(
            await threadLifecycle.create(
              {
                provider,
                model: resolvedModel,
                mode,
                source: 'mcp',
                activate: false,
              },
              operationSignal
            ),
            'THREAD_CREATE_FAILED'
          )
        }
      )
      return toThreadSummary(created.threadId)
    },
    resumeThread: async (conversationUrl, signal) => {
      const resolved = resolveConversationUrl(conversationUrl)
      if (resolved === null) {
        throw new Error('Conversation URL is invalid or unsupported.')
      }
      const resumed = await withForegroundOperation(
        signal,
        async (operationSignal, setStopTarget) => {
          void setStopTarget
          return requireProvisionResult(
            await threadLifecycle.resume(
              {
                conversationUrl: resolved.conversationUrl,
                source: 'mcp',
                activate: false,
              },
              operationSignal
            ),
            'THREAD_RESUME_FAILED'
          )
        }
      )
      return toThreadSummary(resumed.threadId)
    },
    closeThread: async (threadId) => {
      getThread(threadId)
      ui.setThreadBusy(threadId, true)
      try {
        const closed = (await threadLifecycle.close(threadId, 'user')).closed
        if (!closed) {
          throw new Error(`Unknown thread: ${threadId}`)
        }
        return { closed: true, threadId }
      } finally {
        if (threadOperations.get(threadId) === null) {
          ui.setThreadBusy(threadId, false)
        }
        if (threadManager.getThread(threadId) === null) {
          ui.removeThreadTimeline(threadId)
        }
      }
    },
    sendMessage: async (threadId, input) => {
      const thread = getThread(threadId)
      const operation = messageOperations.begin(threadId)
      const startResult = threadLifecycle.startSend(
        threadId,
        input,
        async (signal) => {
          try {
            const result = await threadManager.submitThreadInput(
              threadId,
              input,
              {
                signal,
                source: 'mcp',
                onAssistantStream: async (message) => {
                  throwIfAborted(signal)
                  ui.renderAssistantStream(thread, message)
                },
                onManualSkill: async (name) => {
                  throwIfAborted(signal)
                  ui.renderThreadInfo(thread, 'skill', `Using skill: ${name}`)
                },
                onInstructionWarning: async (warning) => {
                  throwIfAborted(signal)
                  ui.renderThreadWarning(
                    thread,
                    'instructions',
                    formatInstructionWarning(warning)
                  )
                },
                onToolProgress: (event, toolCall, toolCallId) => {
                  if (
                    signal.aborted ||
                    (toolCall?.tool !== 'run_command' &&
                      toolCall?.tool !== 'spawn')
                  ) {
                    return
                  }
                  ui.renderToolProgress(
                    thread,
                    toolCall.tool,
                    event,
                    toolCallId
                  )
                },
                onTurnItem: async (item) => {
                  throwIfAborted(signal)
                  if (item.kind === 'assistant_text') {
                    ui.renderAssistantMessage(thread, item.text)
                  } else if (item.kind === 'tool_call') {
                    ui.setThreadLastToolName(thread.id, item.toolName)
                    ui.renderToolCall(
                      thread,
                      item.toolName,
                      item.rawPayload,
                      item.toolCallId
                    )
                  } else if (item.kind === 'tool_result') {
                    ui.setThreadLastToolName(thread.id, item.toolName)
                    ui.renderToolResult(
                      thread,
                      item.toolName,
                      item.outcome,
                      item.result,
                      item.displayText,
                      item.toolCallId
                    )
                  } else if (item.kind === 'error') {
                    ui.renderThreadError(thread, 'thread', item.text)
                  }
                },
              }
            )
            if (result === null) {
              throw new Error(`Unknown thread: ${threadId}`)
            }
            await threadLifecycle.recordActivity({
              threadId: thread.id,
              provider: thread.provider,
              conversationUrl: thread.runtime.conversationUrl,
              title: buildThreadHistoryTitle(input),
            })
            messageOperations.complete(operation.operationId, result.assistant)
          } catch (error) {
            if (isAbortError(error)) {
              messageOperations.cancelled(operation.operationId)
            } else {
              messageOperations.fail(
                operation.operationId,
                error instanceof Error ? error.message : String(error)
              )
            }
            throw error
          } finally {
            ui.clearLiveCommand(thread)
            ui.setThreadBusy(thread.id, false)
          }
        }
      )

      if (!startResult.accepted) {
        messageOperations.remove(operation.operationId)
        throw new Error(
          startResult.reason === 'closing'
            ? `Thread ${threadId} is closing.`
            : `Thread ${threadId} already has an active operation.`
        )
      }
      messageOperations.attachHandle(
        operation.operationId,
        startResult.operation
      )
      ui.renderUserMessage(thread, input)
      ui.setThreadBusy(thread.id, true)
      return messageOperations.get(operation.operationId)
    },
    waitMessage: async (operationId, timeoutMs, signal) =>
      await messageOperations.wait(operationId, timeoutMs, signal),
    cancelMessage: async (operationId) =>
      await messageOperations.cancel(operationId),
  }
}

function requireProvisionResult(
  result: ProvisionResult,
  failureCode: string
): Extract<ProvisionResult, { ok: true }> {
  if (result.ok) return result
  throw new ApiHttpError(502, failureCode, result.failure.message)
}

function formatInstructionWarning(
  warning: ProjectInstructionWarning
): string[] {
  return [
    warning.message,
    ...(warning.path === undefined ? [] : [`source: ${warning.path}`]),
  ]
}
