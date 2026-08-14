import type { RunCommandJobManager } from '../processes/run-command-job-manager.ts'
import {
  buildRuntimeRecoveryPlan,
  tryRestoreRuntimeForRecovery,
} from '../runtime/runtime-recovery.ts'
import {
  isAbortError,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'
import type { TerminalController } from '../terminal-ui/terminal-controller.ts'
import type { ThreadLifecycleService } from '../threads/thread-lifecycle-service.ts'
import type { ThreadManager } from '../threads/thread-manager.ts'
import { buildThreadHistoryTitle } from '../threads/thread-store.ts'
import { shouldRenderFallbackThreadError } from './app-terminal-lifecycle.ts'

export interface TuiThreadInputDependencies {
  threadManager: ThreadManager
  threadLifecycle: ThreadLifecycleService
  ui: TerminalController
  runCommandJobs: Pick<RunCommandJobManager, 'list'>
  browserProfileDir: string
}

export function createTuiThreadInputHandler({
  threadManager,
  threadLifecycle,
  ui,
  runCommandJobs,
  browserProfileDir,
}: TuiThreadInputDependencies) {
  return async function submitThreadInput(
    input: string,
    displayInput = input
  ): Promise<void> {
    const activeThread = threadManager.getActiveThread()
    if (activeThread === null) {
      ui.renderWarning(
        'portal',
        'No active thread. Use /thread agent to create one, or /help to see commands.'
      )
      return
    }

    const startResult = threadLifecycle.startSend(
      activeThread.id,
      input,
      async (signal) => {
        try {
          while (true) {
            let turnErrorRendered = false
            try {
              await threadManager.submitThreadInput(activeThread.id, input, {
                signal,
                onAssistantStream: async (message) => {
                  throwIfAborted(signal)
                  ui.renderAssistantStream(activeThread, message)
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
                    activeThread,
                    toolCall.tool,
                    event,
                    toolCallId
                  )
                },
                onTurnItem: async (item) => {
                  throwIfAborted(signal)
                  if (item.kind === 'assistant_text') {
                    ui.renderAssistantMessage(activeThread, item.text)
                    return
                  }
                  if (item.kind === 'tool_call') {
                    ui.setThreadLastToolName(activeThread.id, item.toolName)
                    ui.renderToolCall(
                      activeThread,
                      item.toolName,
                      item.rawPayload,
                      item.toolCallId
                    )
                    return
                  }
                  if (item.kind === 'tool_result') {
                    ui.setThreadLastToolName(activeThread.id, item.toolName)
                    ui.renderToolResult(
                      activeThread,
                      item.toolName,
                      item.outcome,
                      item.result,
                      item.displayText,
                      item.toolCallId
                    )
                    return
                  }
                  if (item.kind === 'status') {
                    return
                  }
                  if (item.kind === 'error') {
                    ui.renderThreadError(activeThread, 'thread', item.text)
                    turnErrorRendered = true
                  }
                },
              })
              await threadLifecycle.recordActivity({
                threadId: activeThread.id,
                provider: activeThread.provider,
                conversationUrl: activeThread.runtime.conversationUrl,
                title: buildThreadHistoryTitle(displayInput),
              })
              break
            } catch (error) {
              if (isAbortError(error)) {
                ui.commitLiveAssistant(activeThread)
                const runningJobCount = runCommandJobs.list().length
                ui.renderThreadWarning(
                  activeThread,
                  'thread',
                  runningJobCount === 0
                    ? 'Cancelled current message.'
                    : [
                        'Cancelled current message.',
                        `${runningJobCount} run_command ${runningJobCount === 1 ? 'job is' : 'jobs are'} still running. Use /job to inspect or stop them.`,
                      ]
                )
                break
              }
              const plan = buildRuntimeRecoveryPlan(error, {
                provider: activeThread.provider,
                browserProfileDir,
                threadId: activeThread.id,
              })
              ui.renderThreadWarning(activeThread, plan.title, plan.lines)
              if (
                shouldRenderFallbackThreadError({
                  turnErrorRendered,
                  showFallbackError: plan.showFallbackError,
                })
              ) {
                ui.renderThreadError(activeThread, 'error', String(error))
              }
              if (!plan.canRetry) {
                break
              }
              await tryRestoreRuntimeForRecovery(error, async () => {
                await activeThread.runtime.restore()
              })
              break
            }
          }
        } catch (error) {
          ui.renderThreadError(activeThread, 'runtime', String(error))
        } finally {
          ui.clearLiveCommand(activeThread)
          ui.setThreadBusy(activeThread.id, false)
        }
      }
    )

    if (!startResult.accepted) {
      ui.renderThreadWarning(
        activeThread,
        'thread',
        startResult.reason === 'closing'
          ? `Thread ${activeThread.id} is closing.`
          : `Thread ${activeThread.id} is already running.`
      )
      return
    }

    ui.renderUserMessage(activeThread, displayInput)
    ui.setThreadBusy(activeThread.id, true)
    void startResult.operation.done.catch((error) => {
      if (!isAbortError(error)) {
        ui.renderThreadError(activeThread, 'runtime', String(error))
      }
    })
  }
}
