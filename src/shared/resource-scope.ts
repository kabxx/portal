export type ResourceScopeState = 'open' | 'disposing' | 'disposed'

export interface ResourceCleanupContext {
  readonly reason: unknown
  readonly signal: AbortSignal
}

export type ResourceDisposer = (
  context: ResourceCleanupContext
) => void | Promise<void>

export interface ResourceRegistration {
  readonly label: string
  readonly disposed: boolean
  dispose(reason?: unknown): Promise<void>
}

export interface ResourceScopeOptions {
  readonly cleanupTimeoutMs?: number
  readonly clock?: ResourceScopeClock
}

export interface ResourceScopeTimerHandle {
  cancel(): void
}

export interface ResourceScopeClock {
  now(): number
  setTimer(delayMs: number, callback: () => void): ResourceScopeTimerHandle
}

export interface ResourceScopeDisposeOptions {
  readonly reason?: unknown
  readonly timeoutMs?: number
}

interface CleanupEntry {
  readonly label: string
  readonly disposer: ResourceDisposer
  state: 'active' | 'running' | 'done'
  runPromise: Promise<void> | null
}

interface Fulfilled<T> {
  readonly status: 'fulfilled'
  readonly value: T
}

interface Rejected {
  readonly status: 'rejected'
  readonly reason: unknown
}

type AcquisitionOutcome<T> = Fulfilled<T> | Rejected

const DEFAULT_CLEANUP_TIMEOUT_MS = 3000

export class ResourceScopeClosedError extends Error {
  public constructor(scopeName: string) {
    super(`Resource scope "${scopeName}" is closed.`)
    this.name = 'ResourceScopeClosedError'
  }
}

export class ResourceCleanupTimeoutError extends Error {
  public constructor(
    public readonly scopeName: string,
    public readonly resourceLabel: string,
    public readonly timeoutMs: number
  ) {
    super(
      `Timed out after ${timeoutMs}ms while disposing "${resourceLabel}" in resource scope "${scopeName}".`
    )
    this.name = 'ResourceCleanupTimeoutError'
  }
}

export class ResourceCleanupError extends Error {
  public constructor(
    public readonly scopeName: string,
    public readonly resourceLabel: string,
    cause: unknown
  ) {
    super(
      `Failed to dispose "${resourceLabel}" in resource scope "${scopeName}".`,
      { cause }
    )
    this.name = 'ResourceCleanupError'
  }
}

export class ResourceScopeDisposalError extends AggregateError {
  public constructor(
    public readonly scopeName: string,
    errors: readonly unknown[]
  ) {
    super(errors, `Resource scope "${scopeName}" failed to dispose cleanly.`)
    this.name = 'ResourceScopeDisposalError'
  }
}

export class ResourceScope {
  readonly #controller = new AbortController()
  readonly #cleanupTimeoutMs: number
  readonly #clock: ResourceScopeClock
  readonly #entries: CleanupEntry[] = []
  readonly #children: ResourceScope[] = []
  #state: ResourceScopeState = 'open'
  #disposePromise: Promise<void> | null = null
  #parent: ResourceScope | null = null
  #parentAbortListener: (() => void) | null = null

  public constructor(
    public readonly name: string,
    options: ResourceScopeOptions = {}
  ) {
    const cleanupTimeoutMs =
      options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS
    if (!Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs < 0) {
      throw new RangeError(
        'Resource cleanup timeout must be a finite number >= 0.'
      )
    }
    this.#cleanupTimeoutMs = cleanupTimeoutMs
    this.#clock = options.clock ?? systemResourceScopeClock
  }

  public get state(): ResourceScopeState {
    return this.#state
  }

  public get signal(): AbortSignal {
    return this.#controller.signal
  }

  public createChild(
    name: string,
    options: ResourceScopeOptions = {}
  ): ResourceScope {
    this.#assertOpen()
    const child = new ResourceScope(name, {
      cleanupTimeoutMs: options.cleanupTimeoutMs ?? this.#cleanupTimeoutMs,
      clock: options.clock ?? this.#clock,
    })
    child.#attachToParent(this)
    this.#children.push(child)
    return child
  }

  public defer(
    label: string,
    disposer: ResourceDisposer
  ): ResourceRegistration {
    this.#assertOpen()
    const entry = this.#addEntry(label, disposer)
    return this.#createRegistration(entry)
  }

  public async acquire<T>(
    label: string,
    factory: (signal: AbortSignal) => T | Promise<T>,
    disposer: (
      resource: T,
      context: ResourceCleanupContext
    ) => void | Promise<void>
  ): Promise<T> {
    this.#assertOpen()
    this.#assertLabel(label)

    const outcome = Promise.resolve()
      .then(async () => await factory(this.signal))
      .then<AcquisitionOutcome<T>, AcquisitionOutcome<T>>(
        (value) => ({ status: 'fulfilled', value }),
        (reason: unknown) => ({ status: 'rejected', reason })
      )

    const entry = this.#addEntry(label, async (context) => {
      const result = await outcome
      if (result.status === 'fulfilled') {
        await disposer(result.value, context)
      }
    })
    const registration = this.#createRegistration(entry)
    const result = await outcome

    if (result.status === 'rejected') {
      this.#deactivateEntry(entry)
      throw result.reason
    }

    if (this.#state !== 'open') {
      const closedError = new ResourceScopeClosedError(this.name)
      try {
        await registration.dispose(this.signal.reason)
      } catch (cleanupError) {
        throw new AggregateError(
          [closedError, cleanupError],
          `Resource "${label}" completed after scope "${this.name}" closed and failed cleanup.`,
          { cause: cleanupError }
        )
      }
      throw closedError
    }

    return result.value
  }

  public dispose(options: ResourceScopeDisposeOptions = {}): Promise<void> {
    if (this.#disposePromise !== null) {
      return this.#disposePromise
    }

    const timeoutMs = options.timeoutMs ?? this.#cleanupTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(
        new RangeError('Resource cleanup timeout must be a finite number >= 0.')
      )
    }

    const reason = options.reason ?? new ResourceScopeClosedError(this.name)
    this.#state = 'disposing'
    this.#controller.abort(reason)
    this.#disposePromise = this.#dispose(reason, timeoutMs)
    return this.#disposePromise
  }

  #assertOpen(): void {
    if (this.#state !== 'open') {
      throw new ResourceScopeClosedError(this.name)
    }
  }

  #addEntry(label: string, disposer: ResourceDisposer): CleanupEntry {
    this.#assertLabel(label)
    const entry: CleanupEntry = {
      label,
      disposer,
      state: 'active',
      runPromise: null,
    }
    this.#entries.push(entry)
    return entry
  }

  #assertLabel(label: string): void {
    if (label.trim().length === 0) {
      throw new TypeError('Resource label must not be empty.')
    }
  }

  #createRegistration(entry: CleanupEntry): ResourceRegistration {
    const dispose = async (reason?: unknown) => {
      const deadline = this.#clock.now() + this.#cleanupTimeoutMs
      await this.#runEntry(
        entry,
        reason ?? new ResourceScopeClosedError(this.name),
        deadline,
        this.#cleanupTimeoutMs
      )
    }
    return {
      label: entry.label,
      get disposed() {
        return entry.state === 'done'
      },
      dispose,
    }
  }

  #deactivateEntry(entry: CleanupEntry): void {
    if (entry.state === 'active') {
      entry.state = 'done'
    }
  }

  #attachToParent(parent: ResourceScope): void {
    this.#parent = parent
    const abortFromParent = () => {
      if (!this.signal.aborted) {
        this.#controller.abort(parent.signal.reason)
      }
    }
    this.#parentAbortListener = abortFromParent
    if (parent.signal.aborted) {
      abortFromParent()
      return
    }
    parent.signal.addEventListener('abort', abortFromParent, { once: true })
  }

  #detachFromParent(): void {
    const parent = this.#parent
    if (parent === null) {
      return
    }
    if (this.#parentAbortListener !== null) {
      parent.signal.removeEventListener('abort', this.#parentAbortListener)
    }
    const index = parent.#children.indexOf(this)
    if (index >= 0) {
      parent.#children.splice(index, 1)
    }
    this.#parent = null
    this.#parentAbortListener = null
  }

  async #dispose(reason: unknown, timeoutMs: number): Promise<void> {
    const errors: unknown[] = []
    const deadline = this.#clock.now() + timeoutMs
    const children = [...this.#children].reverse()
    const entries = [...this.#entries].reverse()

    try {
      for (const child of children) {
        const remainingMs = Math.max(0, deadline - this.#clock.now())
        try {
          const operation = child.dispose({ reason, timeoutMs: remainingMs })
          await this.#settleBeforeDeadline(
            operation,
            deadline,
            new ResourceCleanupTimeoutError(
              this.name,
              `child:${child.name}`,
              timeoutMs
            )
          )
        } catch (error) {
          errors.push(error)
        }
      }

      for (const entry of entries) {
        try {
          const operation = this.#runEntry(entry, reason, deadline, timeoutMs)
          await this.#settleBeforeDeadline(
            operation,
            deadline,
            new ResourceCleanupTimeoutError(this.name, entry.label, timeoutMs)
          )
        } catch (error) {
          errors.push(error)
        }
      }
    } finally {
      this.#state = 'disposed'
      this.#detachFromParent()
    }

    if (errors.length > 0) {
      throw new ResourceScopeDisposalError(this.name, errors)
    }
  }

  #runEntry(
    entry: CleanupEntry,
    reason: unknown,
    deadline: number,
    timeoutMs: number
  ): Promise<void> {
    if (entry.state === 'done') {
      return Promise.resolve()
    }
    if (entry.runPromise !== null) {
      return entry.runPromise
    }

    entry.state = 'running'
    entry.runPromise = this.#runDisposer(
      entry,
      reason,
      deadline,
      timeoutMs
    ).finally(() => {
      entry.state = 'done'
    })
    return entry.runPromise
  }

  async #runDisposer(
    entry: CleanupEntry,
    reason: unknown,
    deadline: number,
    timeoutMs: number
  ): Promise<void> {
    const controller = new AbortController()
    const timeoutError = new ResourceCleanupTimeoutError(
      this.name,
      entry.label,
      timeoutMs
    )
    const operation = Promise.resolve().then(
      async () => await entry.disposer({ reason, signal: controller.signal })
    )

    try {
      await this.#settleBeforeDeadline(operation, deadline, timeoutError, () =>
        controller.abort(timeoutError)
      )
    } catch (error) {
      if (error instanceof ResourceCleanupTimeoutError) {
        throw error
      }
      throw new ResourceCleanupError(this.name, entry.label, error)
    }
  }

  async #settleBeforeDeadline<Value>(
    operation: Promise<Value>,
    deadline: number,
    timeoutError: ResourceCleanupTimeoutError,
    onTimeout: () => void = () => {}
  ): Promise<Value> {
    void operation.catch(() => undefined)
    let expired = false
    const expire = () => {
      if (!expired) {
        expired = true
        onTimeout()
      }
      return timeoutError
    }
    const remainingMs = deadline - this.#clock.now()
    if (remainingMs <= 0) throw expire()

    let cancelTimer = () => {}
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = this.#clock.setTimer(remainingMs, () => reject(expire()))
      cancelTimer = () => timer.cancel()
    })
    try {
      try {
        const value = await Promise.race([operation, timeout])
        if (this.#clock.now() >= deadline) throw expire()
        return value
      } catch (error) {
        if (error !== timeoutError && this.#clock.now() >= deadline) {
          throw expire()
        }
        throw error
      }
    } finally {
      cancelTimer()
    }
  }
}

const systemResourceScopeClock: ResourceScopeClock = Object.freeze({
  now: () => Date.now(),
  setTimer: (
    delayMs: number,
    callback: () => void
  ): ResourceScopeTimerHandle => {
    const timer = setTimeout(callback, delayMs)
    return Object.freeze({ cancel: () => clearTimeout(timer) })
  },
})
