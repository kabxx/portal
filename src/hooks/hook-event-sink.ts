import type { HookEventSink, HookExecutionEvent } from './hook-types.ts'

export class HookEventBus implements HookEventSink {
  private readonly listeners = new Set<(event: HookExecutionEvent) => void>()

  public emit(event: HookExecutionEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  public subscribe(listener: (event: HookExecutionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
