import type { McpMessageOperationStore } from '../mcp-server/mcp-message-operations.ts'
import type {
  PortalMcpHandlers,
  PortalMcpThreadSummary,
} from '../mcp-server/mcp-server-types.ts'
import {
  isAbortError,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'
import type { SurfacePortActions } from '../surfaces/surface-port.ts'
import type { CommandJobService } from '../cli-commands/core/command-services.ts'
import {
  stopMcpForegroundOperation,
  type McpForegroundOperation,
  type StopTarget,
} from './app-lifecycle.ts'

export interface McpHandlerDependencies {
  surface: SurfacePortActions
  runCommandJobs?: CommandJobService
  messageOperations: McpMessageOperationStore
  foregroundOperations: Set<McpForegroundOperation>
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
  surface,
  runCommandJobs,
  messageOperations,
  foregroundOperations,
  isForegroundOperationActive,
  withCancellableOperation,
}: McpHandlerDependencies): PortalMcpHandlers {
  const getThread = (threadId: string) => {
    const thread = surface.getThread(threadId)
    if (thread === null) throw new Error(`Unknown thread: ${threadId}`)
    return thread
  }

  const toThreadSummary = (threadId: string): PortalMcpThreadSummary => {
    const thread = getThread(threadId)
    return {
      id: thread.id,
      provider: thread.provider,
      title: thread.title ?? null,
      conversationUrl: thread.conversationUrl ?? '',
      busy: thread.busy ?? false,
      turnCount: thread.turnCount ?? 0,
      createdAt: thread.createdAt ?? 0,
      updatedAt: thread.updatedAt ?? 0,
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
      void stopMcpForegroundOperation(operation)
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
    listProviders: () => ({ providers: [...surface.listProviders()] }),
    listAgentModes: () => surface.listAgentModes(),
    ...(runCommandJobs === undefined
      ? {}
      : {
          listJobs: () => ({
            jobs: runCommandJobs.list().map((job) => ({ ...job })),
          }),
          stopJob: async (jobId: string, signal: AbortSignal) => {
            if (jobId.trim() === '')
              throw new Error('jobId must be a non-empty string.')
            const result = await runCommandJobs.stop(jobId, signal)
            if (result === 'not-found')
              throw new Error(`Unknown or finished job: ${jobId}`)
            if (result === 'timeout')
              throw new Error(`Timed out waiting for ${jobId} to stop.`)
            return { stopped: true, jobId }
          },
        }),
    listThreads: () => ({
      threads: surface
        .listThreads()
        .map((thread) => toThreadSummary(thread.id)),
    }),
    getThread: async (threadId) => toThreadSummary(threadId),
    createThread: async ({ provider, model, option, mode }, signal) => {
      const created = await withForegroundOperation(
        signal,
        async (operationSignal) =>
          await surface.createThread(
            { provider, model, option, mode, source: 'mcp', activate: false },
            operationSignal
          )
      )
      return toThreadSummary(created.thread.id)
    },
    resumeThread: async (conversationUrl, signal) => {
      const resumed = await withForegroundOperation(
        signal,
        async (operationSignal) =>
          await surface.resumeThread(
            conversationUrl,
            'mcp',
            false,
            operationSignal
          )
      )
      return toThreadSummary(resumed.thread.id)
    },
    closeThread: async (threadId) => {
      getThread(threadId)
      const result = await surface.closeThread(threadId)
      if (!result.closed) throw new Error(`Unknown thread: ${threadId}`)
      return { closed: true, threadId }
    },
    sendMessage: async (threadId, input) => {
      getThread(threadId)
      const operation = messageOperations.begin(threadId)
      let assistant = ''
      const startResult = surface.startMessage(threadId, input, (event) => {
        if (event.type === 'assistant.result') {
          assistant = event.text
        }
      })
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
      void startResult.operation.done
        .then(() =>
          messageOperations.complete(operation.operationId, assistant)
        )
        .catch((error: unknown) => {
          if (isAbortError(error))
            messageOperations.cancelled(operation.operationId)
          else messageOperations.fail(operation.operationId, String(error))
        })
        .catch(() => undefined)
      return messageOperations.get(operation.operationId)
    },
    waitMessage: async (operationId, timeoutMs, signal) =>
      await messageOperations.wait(operationId, timeoutMs, signal),
    cancelMessage: async (operationId) =>
      await messageOperations.cancel(operationId),
  }
}
