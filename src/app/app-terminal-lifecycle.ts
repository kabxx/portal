import type { TerminalController } from '../terminal-ui/terminal-controller.ts'
import type { SurfacePort } from '../surfaces/surface-port.ts'

const CLEAR_TERMINAL_ESCAPE = '\u001B[2J\u001B[3J\u001B[H'

export function clearTerminalBeforeRender(output: {
  isTTY?: boolean
  write: (data: string) => unknown
}): void {
  if (output.isTTY === true) {
    output.write(CLEAR_TERMINAL_ESCAPE)
  }
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
  surface: SurfacePort,
  threadId: string
): { keep(): void; discard(): void } {
  const previousThreadId = surface.getActiveThread()?.id ?? null
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
      const restoreThreadId =
        previousThreadId !== null &&
        surface.getThread(previousThreadId) !== null
          ? previousThreadId
          : null
      ui.discardPendingThreadTimeline(threadId, restoreThreadId)
    },
  }
}
