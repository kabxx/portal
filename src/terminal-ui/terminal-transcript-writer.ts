import type { TimelineEntry } from './terminal-controller.ts'

const CLEAR_TERMINAL_ESCAPE = '\u001B[2J\u001B[3J\u001B[H'

export type TimelineAnsiRenderer = (
  entry: TimelineEntry,
  width: number
) => string

export interface TranscriptSyncResult {
  status: 'written' | 'unchanged'
}

/**
 * Owns the completed portion of the primary-screen transcript independently
 * from Ink's live frame, so a resize can replace it from the controller model.
 */
export class TerminalTranscriptWriter {
  private committedSignatures: string[] = []
  private committedTimelineVersion: number | null = null
  private committedWidth: number | null = null
  private initialized = false
  private renderedWidth: number | null = null
  private readonly renderedEntries = new Map<string, string>()

  public constructor(
    private readonly renderEntry: TimelineAnsiRenderer,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  public reset(): void {
    this.committedSignatures = []
    this.committedTimelineVersion = null
    this.committedWidth = null
    this.initialized = false
    this.renderedEntries.clear()
    this.renderedWidth = null
  }

  public sync(
    entries: readonly TimelineEntry[],
    width: number,
    forceReflow: boolean,
    writePreservingLiveFrame: (data: string) => void,
    timelineVersion = 0
  ): TranscriptSyncResult {
    if (this.committedTimelineVersion !== timelineVersion) {
      this.reset()
      this.committedTimelineVersion = timelineVersion
    }
    const signatures = entries.map(timelineEntrySignature)
    const needsFullReplay =
      forceReflow ||
      !this.initialized ||
      this.committedWidth !== width ||
      !isPrefix(this.committedSignatures, signatures)

    if (needsFullReplay) {
      const rendered = entries
        .map((entry) => this.render(entry, width))
        .join('')
      writePreservingLiveFrame(
        this.prepareTerminalOutput(`${CLEAR_TERMINAL_ESCAPE}${rendered}`)
      )
      const activeSignatures = new Set(signatures)
      for (const signature of this.renderedEntries.keys()) {
        if (!activeSignatures.has(signature)) {
          this.renderedEntries.delete(signature)
        }
      }
      this.committedSignatures = signatures
      this.committedWidth = width
      this.initialized = true
      return { status: 'written' }
    }

    if (signatures.length === this.committedSignatures.length) {
      return { status: 'unchanged' }
    }

    const appended = entries.slice(this.committedSignatures.length)
    const rendered = appended.map((entry) => this.render(entry, width)).join('')
    if (rendered !== '') {
      writePreservingLiveFrame(this.prepareTerminalOutput(rendered))
    }
    this.committedSignatures = signatures
    return { status: 'written' }
  }

  private render(entry: TimelineEntry, width: number): string {
    if (this.renderedWidth !== width) {
      this.renderedEntries.clear()
      this.renderedWidth = width
    }
    const signature = timelineEntrySignature(entry)
    const cached = this.renderedEntries.get(signature)
    if (cached !== undefined) {
      return cached
    }
    const rendered = this.renderEntry(entry, width)
    this.renderedEntries.set(signature, rendered)
    return rendered
  }

  private prepareTerminalOutput(output: string): string {
    // Ink disables Windows' automatic newline return so full-width frames do
    // not scroll. Transcript writes bypass Ink's frame writer, so restore the
    // carriage return explicitly for every line written to that console.
    return this.platform === 'win32'
      ? output.replace(/(?<!\r)\n/g, '\r\n')
      : output
  }
}

function isPrefix(
  prefix: readonly string[],
  values: readonly string[]
): boolean {
  if (prefix.length > values.length) {
    return false
  }
  return prefix.every((value, index) => value === values[index])
}

function timelineEntrySignature(entry: TimelineEntry): string {
  return JSON.stringify([
    entry.id,
    entry.tone,
    entry.label,
    entry.body,
    entry.format,
    entry.welcome ?? null,
  ])
}
