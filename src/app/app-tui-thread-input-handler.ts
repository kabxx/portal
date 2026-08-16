import type { TerminalController } from '../terminal-ui/terminal-controller.ts'
import type {
  SurfaceMessageEvent,
  SurfacePortActions,
  SurfaceThread,
} from '../surfaces/surface-port.ts'

export interface TuiThreadInputDependencies {
  surface: SurfacePortActions
  ui: TerminalController
}

export function createTuiThreadInputHandler({
  surface,
  ui,
}: TuiThreadInputDependencies) {
  return async function submitThreadInput(
    input: string,
    displayInput = input
  ): Promise<void> {
    const activeThread = surface.getActiveThread()
    if (activeThread === null) {
      ui.renderWarning(
        'portal',
        'No active thread. Use /thread agent to create one, or /help to see commands.'
      )
      return
    }

    const startResult = surface.startMessage(
      activeThread.id,
      input,
      async (event) => {
        await renderSurfaceEvent(ui, activeThread, event)
      },
      displayInput
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
    void startResult.operation.done
      .catch((error: unknown) => {
        ui.renderThreadError(activeThread, 'runtime', String(error))
      })
      .then(
        () => {
          ui.clearLiveCommand(activeThread)
          ui.setThreadBusy(activeThread.id, false)
        },
        () => {
          ui.clearLiveCommand(activeThread)
          ui.setThreadBusy(activeThread.id, false)
        }
      )
      .catch(() => undefined)
  }
}

async function renderSurfaceEvent(
  ui: TerminalController,
  thread: SurfaceThread,
  event: SurfaceMessageEvent
): Promise<void> {
  if (event.type === 'assistant.delta') {
    ui.renderAssistantStream(thread, event.text)
    return
  }
  if (event.type === 'tool.progress') {
    ui.renderToolProgress(thread, event.toolName, event.event, event.toolCallId)
    return
  }
  if (event.type === 'assistant.result') return

  const item = event.item
  if (item.kind === 'assistant_text') {
    ui.renderAssistantMessage(thread, item.text)
  } else if (item.kind === 'tool_call') {
    ui.setThreadLastToolName(thread.id, item.toolName)
    ui.renderToolCall(thread, item.toolName, item.rawPayload, item.toolCallId)
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
}
