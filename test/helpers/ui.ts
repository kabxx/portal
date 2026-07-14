import type { TerminalController } from '../../src/terminal-ui/terminal-controller.ts'

export function latestTimelineEntry(ui: TerminalController) {
  const entry = ui.getState().timeline.at(-1)
  if (entry === undefined) {
    return undefined
  }

  const { id: _id, ...visibleEntry } = entry
  return visibleEntry
}
