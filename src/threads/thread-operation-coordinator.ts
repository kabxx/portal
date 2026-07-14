export interface OperationStopTarget {
  stopGeneration(): Promise<void>
}

export type ThreadOperationPhase = 'running' | 'cancelling' | 'closing'

export interface ThreadOperationContext {
  signal: AbortSignal
  setStopTarget(target: OperationStopTarget | null): void
}

export interface ThreadOperationSnapshot {
  threadId: string
  phase: ThreadOperationPhase
  startedAt: number
}

export interface ThreadOperationHandle extends ThreadOperationSnapshot {
  done: Promise<void>
}

export type StartThreadOperationResult =
  | { accepted: true; operation: ThreadOperationHandle }
  | { accepted: false; reason: 'running' | 'closing' }

interface MutableThreadOperation {
  token: symbol
  threadId: string
  phase: ThreadOperationPhase
  startedAt: number
  controller: AbortController
  stopTarget: OperationStopTarget | null
  done: Promise<void>
  cancellation: Promise<void> | null
}

interface ClosingThreadOperation {
  startedAt: number
  done: Promise<unknown>
}

const DEFAULT_CANCEL_SETTLE_TIMEOUT_MS = 3000

export class ThreadOperationCoordinator {
  private readonly operations = new Map<string, MutableThreadOperation>()
  private readonly closingThreads = new Map<string, ClosingThreadOperation>()

  public constructor(
    private readonly cancelSettleTimeoutMs = DEFAULT_CANCEL_SETTLE_TIMEOUT_MS
  ) {}

  public tryStart(
    threadId: string,
    stopTarget: OperationStopTarget | null,
    runner: (context: ThreadOperationContext) => Promise<void>
  ): StartThreadOperationResult {
    if (this.closingThreads.has(threadId)) {
      return { accepted: false, reason: 'closing' }
    }
    if (this.operations.has(threadId)) {
      return { accepted: false, reason: 'running' }
    }

    const token = Symbol(threadId)
    const controller = new AbortController()
    const operation: MutableThreadOperation = {
      token,
      threadId,
      phase: 'running',
      startedAt: Date.now(),
      controller,
      stopTarget,
      done: Promise.resolve(),
      cancellation: null,
    }
    this.operations.set(threadId, operation)

    operation.done = Promise.resolve()
      .then(
        async () =>
          await runner({
            signal: controller.signal,
            setStopTarget: (target) => {
              if (this.operations.get(threadId)?.token === token) {
                operation.stopTarget = target
              }
            },
          })
      )
      .finally(() => {
        if (this.operations.get(threadId)?.token === token) {
          this.operations.delete(threadId)
        }
      })

    // The owner may observe `done`, but a detached operation must never create
    // an unhandled rejection before that observer is attached.
    void operation.done.catch(() => {})

    return { accepted: true, operation: this.toHandle(operation) }
  }

  public get(threadId: string): ThreadOperationSnapshot | null {
    const operation = this.operations.get(threadId)
    if (operation !== undefined) {
      return this.toSnapshot(operation)
    }
    return this.closingThreads.has(threadId)
      ? {
          threadId,
          phase: 'closing',
          startedAt: this.closingThreads.get(threadId)!.startedAt,
        }
      : null
  }

  public list(): ThreadOperationSnapshot[] {
    return [...this.operations.values()].map((operation) =>
      this.toSnapshot(operation)
    )
  }

  public async cancel(threadId: string): Promise<void> {
    await this.cancelOperation(threadId, 'cancelling')
  }

  public close<T>(threadId: string, closeThread: () => Promise<T>): Promise<T> {
    const existing = this.closingThreads.get(threadId)
    if (existing !== undefined) {
      return existing.done as Promise<T>
    }

    const closing: ClosingThreadOperation = {
      startedAt: Date.now(),
      done: Promise.resolve(),
    }
    this.closingThreads.set(threadId, closing)
    closing.done = Promise.resolve()
      .then(async () => {
        await this.cancelOperation(threadId, 'closing')
        return await closeThread()
      })
      .finally(() => {
        if (this.closingThreads.get(threadId) === closing) {
          this.closingThreads.delete(threadId)
        }
      })
    return closing.done as Promise<T>
  }

  public async cancelAll(): Promise<void> {
    await Promise.allSettled(
      [...this.operations.keys()].map(async (threadId) => {
        await this.cancel(threadId)
      })
    )
  }

  private async cancelOperation(
    threadId: string,
    phase: Exclude<ThreadOperationPhase, 'running'>
  ): Promise<void> {
    const operation = this.operations.get(threadId)
    if (operation === undefined) {
      return
    }

    operation.phase =
      phase === 'closing' || operation.phase === 'closing'
        ? 'closing'
        : 'cancelling'
    operation.controller.abort()
    operation.cancellation ??= Promise.allSettled([
      Promise.resolve().then(
        async () => await operation.stopTarget?.stopGeneration()
      ),
      operation.done,
    ]).then(() => undefined)
    await waitForSettlement(operation.cancellation, this.cancelSettleTimeoutMs)
  }

  private toSnapshot(
    operation: MutableThreadOperation
  ): ThreadOperationSnapshot {
    return {
      threadId: operation.threadId,
      phase: operation.phase,
      startedAt: operation.startedAt,
    }
  }

  private toHandle(operation: MutableThreadOperation): ThreadOperationHandle {
    return {
      ...this.toSnapshot(operation),
      done: operation.done,
    }
  }
}

async function waitForSettlement(
  promise: Promise<void>,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}
