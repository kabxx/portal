export interface ClaudeSseEvent {
  event: string | null
  data: unknown
}

export interface ClaudeCompletionStreamSnapshot {
  text: string
  messageStopped: boolean
  stopReason: string | null
  sawActivity: boolean
  errorMessage: string | null
}

export class ClaudeSseProtocolError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'ClaudeSseProtocolError'
  }
}

export class ClaudeSseDecoder {
  private buffer = ''
  private eventName: string | null = null
  private dataLines: string[] = []

  public push(chunk: string): ClaudeSseEvent[] {
    this.buffer += chunk
    const events: ClaudeSseEvent[] = []
    while (true) {
      const newlineIndex = this.buffer.indexOf('\n')
      if (newlineIndex < 0) break
      let line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      const event = this.consumeLine(line)
      if (event !== null) events.push(event)
    }
    return events
  }

  public finish(): void {
    if (
      this.buffer.length > 0 ||
      this.eventName !== null ||
      this.dataLines.length > 0
    ) {
      throw new ClaudeSseProtocolError(
        'Claude response ended with an incomplete SSE frame.'
      )
    }
  }

  private consumeLine(line: string): ClaudeSseEvent | null {
    if (line === '') {
      if (this.dataLines.length === 0) {
        this.eventName = null
        return null
      }
      const rawData = this.dataLines.join('\n')
      const eventName = this.eventName
      this.eventName = null
      this.dataLines = []
      try {
        return { event: eventName, data: JSON.parse(rawData) as unknown }
      } catch (error) {
        throw new ClaudeSseProtocolError(
          `Claude returned invalid SSE JSON: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }
    if (line.startsWith(':')) return null

    const separatorIndex = line.indexOf(':')
    const field = separatorIndex < 0 ? line : line.slice(0, separatorIndex)
    let value = separatorIndex < 0 ? '' : line.slice(separatorIndex + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') this.eventName = value || null
    if (field === 'data') this.dataLines.push(value)
    return null
  }
}

export class ClaudeCompletionStream {
  private readonly decoder = new ClaudeSseDecoder()
  private text = ''
  private messageStopped = false
  private stopReason: string | null = null
  private sawActivity = false
  private errorMessage: string | null = null

  public push(chunk: string): ClaudeCompletionStreamSnapshot {
    for (const event of this.decoder.push(chunk)) {
      this.consumeEvent(event)
    }
    return this.snapshot
  }

  public finish(): ClaudeCompletionStreamSnapshot {
    this.decoder.finish()
    return this.snapshot
  }

  public get snapshot(): ClaudeCompletionStreamSnapshot {
    return {
      text: this.text,
      messageStopped: this.messageStopped,
      stopReason: this.stopReason,
      sawActivity: this.sawActivity,
      errorMessage: this.errorMessage,
    }
  }

  private consumeEvent(event: ClaudeSseEvent): void {
    this.sawActivity = true
    const data = asRecord(event.data)
    const type = stringValue(data?.type) ?? event.event
    if (type === 'error' || event.event === 'error') {
      this.errorMessage =
        stringValue(data?.message) ??
        stringValue(asRecord(data?.error)?.message) ??
        'Claude returned an SSE error.'
      return
    }
    if (type === 'content_block_delta') {
      const delta = asRecord(data?.delta)
      if (stringValue(delta?.type) === 'text_delta') {
        this.text += stringValue(delta?.text) ?? ''
      }
      return
    }
    if (type === 'message_delta') {
      const delta = asRecord(data?.delta)
      this.stopReason = stringValue(delta?.stop_reason) ?? this.stopReason
      return
    }
    if (type === 'message_stop') {
      this.messageStopped = true
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
