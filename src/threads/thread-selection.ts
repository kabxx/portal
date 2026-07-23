/**
 * TUI-only selection state. Runtime admission and selection are deliberately
 * separate: an API/MCP create must not change what the terminal is displaying.
 */
export class ThreadSelectionController {
  private readonly threadIds = new Set<string>()
  private activeThreadId: string | null = null

  public register(threadId: string): void {
    this.threadIds.add(threadId)
  }

  public registerMany(threadIds: Iterable<string>): void {
    for (const threadId of threadIds) {
      this.register(threadId)
    }
  }

  public list(): readonly string[] {
    return [...this.threadIds]
  }

  public getActiveId(): string | null {
    return this.activeThreadId
  }

  public switch(threadId: string): boolean {
    if (!this.threadIds.has(threadId)) {
      return false
    }
    this.activeThreadId = threadId
    return true
  }

  public detach(threadId: string): boolean {
    const removed = this.threadIds.delete(threadId)
    if (this.activeThreadId === threadId) {
      this.activeThreadId = null
    }
    return removed
  }

  public clear(): void {
    this.threadIds.clear()
    this.activeThreadId = null
  }

  public clearActive(): void {
    this.activeThreadId = null
  }

  /** Reconciles the TUI view after a query refresh without changing selection. */
  public sync(threadIds: Iterable<string>): void {
    const next = new Set(threadIds)
    for (const threadId of this.threadIds) {
      if (!next.has(threadId)) {
        this.threadIds.delete(threadId)
      }
    }
    for (const threadId of next) {
      this.threadIds.add(threadId)
    }
    if (
      this.activeThreadId !== null &&
      !this.threadIds.has(this.activeThreadId)
    ) {
      this.activeThreadId = null
    }
  }
}
