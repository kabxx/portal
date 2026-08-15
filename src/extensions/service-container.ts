import type {
  HookRuntimeClock,
  HookTimerHandle,
  ServiceAccessor,
  ServiceRef,
} from './extension-contracts.ts'
import {
  ExtensionCapabilityExpiredError,
  HookScopeMismatchError,
  ServiceAccessDeniedError,
  ServiceActivationError,
  UnknownRefError,
} from './extension-errors.ts'
import type {
  PendingServiceFactory,
  ResolvedServicePlan,
} from './extension-registry.ts'
import { ExtensionResourceScope } from './scope-registration.ts'

export class ServiceContainer {
  readonly #instances = new WeakMap<
    ExtensionResourceScope,
    Map<symbol, Promise<unknown>>
  >()
  readonly #clock: HookRuntimeClock

  public constructor(
    private readonly plan: ResolvedServicePlan,
    options: { readonly clock?: HookRuntimeClock } = {}
  ) {
    this.#clock = options.clock ?? systemServiceClock
  }

  public createAccessor(options: {
    readonly scope: ExtensionResourceScope
    readonly allowedServices: readonly ServiceRef<unknown>[]
    readonly signal: AbortSignal
    readonly deadline: number
    readonly assertActive?: () => void
  }): ServiceAccessor {
    const allowed = new Set(options.allowedServices.map((ref) => ref.key))
    return Object.freeze({
      get: async <Service>(ref: ServiceRef<Service>) => {
        options.assertActive?.()
        if (options.scope.resourceScope.state !== 'open') {
          throw new ExtensionCapabilityExpiredError('Service accessor')
        }
        throwIfRequestExpired(
          options.signal,
          options.deadline,
          this.#clock.now()
        )
        if (!allowed.has(ref.key)) {
          throw new ServiceAccessDeniedError(ref.id)
        }
        const service = await this.#resolve(
          ref,
          options.scope,
          options.signal,
          options.deadline
        )
        options.assertActive?.()
        if (options.scope.resourceScope.state !== 'open') {
          throw new ExtensionCapabilityExpiredError('Service accessor')
        }
        throwIfRequestExpired(
          options.signal,
          options.deadline,
          this.#clock.now()
        )
        return service
      },
    })
  }

  async #resolve<Service>(
    ref: ServiceRef<Service>,
    requestScope: ExtensionResourceScope,
    signal: AbortSignal,
    deadline: number
  ): Promise<Service> {
    const known = this.plan.refs.get(ref.key)
    if (known === undefined || known !== ref) {
      throw new UnknownRefError('Service', ref.id)
    }
    const targetScope = requestScope.find(ref.scope)
    if (targetScope === null) {
      throw new HookScopeMismatchError(
        `service:${ref.id}`,
        ref.scope,
        requestScope.kind
      )
    }
    let scopeInstances = this.#instances.get(targetScope)
    if (scopeInstances === undefined) {
      scopeInstances = new Map()
      this.#instances.set(targetScope, scopeInstances)
    }
    let instance = scopeInstances.get(ref.key)
    const sharedActivation = instance !== undefined
    if (instance === undefined) {
      const provider = this.plan.providers.get(ref.key)
      if (provider === undefined) {
        throw new UnknownRefError('Service provider', ref.id)
      }
      instance = this.#activate(provider, targetScope, signal, deadline)
      scopeInstances.set(ref.key, instance)
      void instance.catch(() => {
        if (scopeInstances?.get(ref.key) === instance) {
          scopeInstances.delete(ref.key)
        }
      })
    }
    const value = sharedActivation
      ? await awaitSharedActivation(
          instance,
          [requestScope.resourceScope.signal, signal],
          deadline,
          this.#clock
        )
      : await instance
    // The provider and Ref were paired by the generic registration API before
    // type erasure in the resolved service graph.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return value as Service
  }

  async #activate(
    provider: PendingServiceFactory,
    targetScope: ExtensionResourceScope,
    invocationSignal: AbortSignal,
    deadline: number
  ): Promise<unknown> {
    const deadlineControl = createDeadlineSignal(
      [targetScope.resourceScope.signal, invocationSignal],
      deadline,
      this.#clock
    )
    let active = true
    const assertActive = () => {
      if (!active || deadlineControl.signal.aborted) {
        throw new ExtensionCapabilityExpiredError('Service factory context')
      }
    }
    const dependencyAccessor = this.createAccessor({
      scope: targetScope,
      allowedServices: provider.dependencies,
      signal: deadlineControl.signal,
      deadline,
      assertActive,
    })
    let activationScope: ExtensionResourceScope | null = null
    try {
      throwIfAborted(deadlineControl.signal)
      for (const dependency of provider.dependencies) {
        await dependencyAccessor.get(dependency)
      }
      activationScope = targetScope.createChild(
        provider.ref.scope,
        `service:${provider.ref.id}`
      )
      const operation = Promise.resolve().then(
        async () =>
          await provider.create({
            services: dependencyAccessor,
            scope: activationScope!.createRegistration({
              signal: deadlineControl.signal,
              assertActive,
            }),
            signal: deadlineControl.signal,
            deadline,
          })
      )
      void operation.catch(() => {})
      const value = await Promise.race([
        operation,
        rejectOnAbort(deadlineControl.signal),
      ])
      throwIfAborted(deadlineControl.signal)
      if (this.#clock.now() >= deadline) {
        const error = new Error('Service activation deadline exceeded.')
        deadlineControl.abort(error)
        throw error
      }
      return value
    } catch (error) {
      active = false
      if (activationScope === null) {
        throw new ServiceActivationError(provider.ref.id, error)
      }
      try {
        const remainingMs = Math.max(0, deadline - this.#clock.now())
        const rollback = activationScope.resourceScope.dispose({
          reason: error,
          ...(Number.isFinite(remainingMs) ? { timeoutMs: remainingMs } : {}),
        })
        await settleBeforeDeadline(
          rollback,
          deadline,
          this.#clock,
          new Error(
            `Service "${provider.ref.id}" rollback exceeded its activation deadline.`
          )
        )
      } catch (cleanupError) {
        throw new ServiceActivationError(
          provider.ref.id,
          new AggregateError(
            [error, cleanupError],
            `Service "${provider.ref.id}" activation and rollback failed.`,
            { cause: error }
          )
        )
      }
      throw new ServiceActivationError(provider.ref.id, error)
    } finally {
      active = false
      deadlineControl.dispose()
    }
  }
}

function createDeadlineSignal(
  signals: readonly AbortSignal[],
  deadline: number,
  clock: HookRuntimeClock
): {
  readonly signal: AbortSignal
  abort(reason: unknown): void
  dispose(): void
} {
  const controller = new AbortController()
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason)
  }
  const listeners: Array<readonly [AbortSignal, () => void]> = []
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal.reason)
      continue
    }
    const listener = () => abort(signal.reason)
    signal.addEventListener('abort', listener, { once: true })
    listeners.push([signal, listener])
  }
  const remainingMs = deadline - clock.now()
  let timer: ReturnType<HookRuntimeClock['setTimer']> | null = null
  if (Number.isFinite(remainingMs)) {
    const deadlineError = new Error('Service activation deadline exceeded.')
    if (remainingMs <= 0) {
      abort(deadlineError)
    } else {
      timer = clock.setTimer(remainingMs, () => abort(deadlineError))
    }
  }
  return {
    signal: controller.signal,
    abort,
    dispose: () => {
      timer?.cancel()
      for (const [signal, listener] of listeners) {
        signal.removeEventListener('abort', listener)
      }
    },
  }
}

async function awaitSharedActivation<Value>(
  operation: Promise<Value>,
  signals: readonly AbortSignal[],
  deadline: number,
  clock: HookRuntimeClock
): Promise<Value> {
  const control = createDeadlineSignal(signals, deadline, clock)
  try {
    throwIfAborted(control.signal)
    return await Promise.race([operation, rejectOnAbort(control.signal)])
  } finally {
    control.dispose()
  }
}

async function settleBeforeDeadline<Value>(
  operation: Promise<Value>,
  deadline: number,
  clock: HookRuntimeClock,
  timeoutError: Error
): Promise<Value> {
  if (!Number.isFinite(deadline)) return await operation
  void operation.catch(() => undefined)
  const remainingMs = deadline - clock.now()
  if (remainingMs <= 0) throw timeoutError
  let cancelTimer = () => {}
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = clock.setTimer(remainingMs, () => reject(timeoutError))
    cancelTimer = () => timer.cancel()
  })
  try {
    try {
      const value = await Promise.race([operation, timeout])
      if (clock.now() >= deadline) throw timeoutError
      return value
    } catch (error) {
      if (error !== timeoutError && clock.now() >= deadline) {
        throw timeoutError
      }
      throw error
    }
  } finally {
    cancelTimer()
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError(signal)
  }
}

function throwIfRequestExpired(
  signal: AbortSignal,
  deadline: number,
  now: number
): void {
  throwIfAborted(signal)
  if (deadline <= now) {
    throw new Error('Service access deadline exceeded.')
  }
}

const systemServiceClock: HookRuntimeClock = Object.freeze({
  now: () => Date.now(),
  setTimer: (delayMs: number, callback: () => void): HookTimerHandle => {
    const timer = setTimeout(callback, delayMs)
    timer.unref()
    return Object.freeze({ cancel: () => clearTimeout(timer) })
  },
})

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal))
      return
    }
    signal.addEventListener('abort', () => reject(abortError(signal)), {
      once: true,
    })
  })
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error
    ? reason
    : new DOMException('Operation aborted', 'AbortError')
}
