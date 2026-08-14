import { tokenizeCommandInput } from '../cli-commands/core/command-registry.ts'
import type { TerminalController } from '../terminal-ui/terminal-controller.ts'
import type { ThreadManager } from '../threads/thread-manager.ts'

const CLEAR_TERMINAL_ESCAPE = '\u001B[2J\u001B[3J\u001B[H'

export function clearTerminalBeforeRender(output: {
  isTTY?: boolean
  write: (data: string) => unknown
}): void {
  if (output.isTTY === true) {
    output.write(CLEAR_TERMINAL_ESCAPE)
  }
}

export function clearInteractiveTerminal(
  inkApp: { clear: () => void },
  output: { isTTY?: boolean; write: (data: string) => unknown }
): void {
  if (output.isTTY !== true) {
    return
  }
  inkApp.clear()
  output.write(CLEAR_TERMINAL_ESCAPE)
}

export function canRunCommandWhileThreadBusy(input: string): boolean {
  const [command, subcommand] = tokenizeCommandInput(input)
  if (
    command === '/help' ||
    command === '/providers' ||
    command === '/job' ||
    command === '/keybinding' ||
    command === '/mcp' ||
    command === '/exit'
  ) {
    return true
  }
  if (command === '/thread') {
    return (
      subcommand === undefined ||
      [
        'agent',
        'chat',
        'list',
        'history',
        'resume',
        'switch',
        'status',
        'close',
        'detach',
      ].includes(subcommand)
    )
  }
  if (command === '/skill') {
    return subcommand === undefined || subcommand === 'list'
  }
  if (command === '/hook') {
    return true
  }
  return false
}

export function shouldRenderFallbackThreadError({
  turnErrorRendered,
  showFallbackError,
}: {
  turnErrorRendered: boolean
  showFallbackError: boolean
}): boolean {
  return !turnErrorRendered && showFallbackError
}

export function showPendingThreadTimeline(
  ui: TerminalController,
  threadManager: ThreadManager,
  threadId: string
): { keep(): void; discard(): void } {
  const previousThreadId = threadManager.getActiveThread()?.id ?? null
  let settled = false
  ui.showThreadTimeline(threadId)

  return {
    keep() {
      settled = true
    },
    discard() {
      if (settled) {
        return
      }
      settled = true
      ui.removeThreadTimeline(threadId)
      if (
        previousThreadId !== null &&
        threadManager.getThread(previousThreadId) !== null
      ) {
        ui.showThreadTimeline(previousThreadId)
      } else {
        ui.showHomeTimeline()
      }
    },
  }
}
