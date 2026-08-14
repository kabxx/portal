import {
  isAbortError,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'
import type { TerminalController } from '../terminal-ui/terminal-controller.ts'
import type { ThreadLifecycleService } from '../threads/thread-lifecycle-service.ts'
import type { ThreadManager } from '../threads/thread-manager.ts'
import type { ThreadOperationHandle } from '../threads/thread-operation-coordinator.ts'

export type ThreadReloadStartResult =
  | { accepted: true; operation: ThreadOperationHandle }
  | { accepted: false; reason: 'not_found' | 'busy' }

export function startThreadReload(
  threadId: string,
  dependencies: {
    threadManager: ThreadManager
    threadLifecycle: ThreadLifecycleService
    ui: TerminalController
  }
): ThreadReloadStartResult {
  const { threadManager, threadLifecycle, ui } = dependencies
  const thread = threadManager.getThread(threadId)
  if (thread === null) {
    return { accepted: false, reason: 'not_found' }
  }

  const startResult = threadLifecycle.startOperation(
    threadId,
    async ({ signal }) => {
      try {
        throwIfAborted(signal)
        await thread.runtime.restore({ signal })
        throwIfAborted(signal)
        ui.renderThreadInfo(thread, 'thread reload', 'Provider page reloaded.')
      } catch (error) {
        if (!isAbortError(error)) {
          ui.renderThreadWarning(
            thread,
            'thread reload',
            error instanceof Error ? error.message : String(error)
          )
        }
        throw error
      } finally {
        ui.setThreadBusy(threadId, false)
      }
    },
    null
  )

  if (!startResult.accepted) {
    return { accepted: false, reason: 'busy' }
  }
  ui.setThreadBusy(threadId, true)
  return { accepted: true, operation: startResult.operation }
}
