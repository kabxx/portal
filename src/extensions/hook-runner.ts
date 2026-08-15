import { randomUUID } from 'node:crypto'

import type {
  ActiveHookInvocationContext,
  Decision,
  HookInvocationContext,
  HookInvocationOptions,
  HookRef,
  HookRuntimeClock,
  HookTimerHandle,
  HookTraceEvent,
  HookTraceRedaction,
  HookTraceSink,
  TerminalHookInvocationContext,
} from './extension-contracts.ts'
import {
  ExtensionCapabilityExpiredError,
  HookHandlerContractError,
  HookHandlerTimeoutError,
  HookInvocationError,
  HookScopeMismatchError,
  HookShutdownAggregateError,
} from './extension-errors.ts'
import type { ResolvedExtensionGraph } from './extension-registry.ts'
import { freezeImmutableData } from './immutable-data.ts'
import type {
  RuntimeResolvedGuardPlan,
  RuntimeResolvedHookHandler,
  RuntimeResolvedHookPlan,
  RuntimeResolvedObservePlan,
  RuntimeResolvedWaterfallPlan,
} from './hook-planner.ts'
import { ServiceContainer } from './service-container.ts'

const neverAbortedSignal = new AbortController().signal

export class HookRunner {
  readonly #clock: HookRuntimeClock
  readonly #traceSink: HookTraceSink

  public constructor(
    private readonly graph: ResolvedExtensionGraph,
    private readonly services: ServiceContainer,
    options: {
      readonly clock?: HookRuntimeClock
      readonly traceSink?: HookTraceSink
    } = {}
  ) {
    this.#clock = options.clock ?? systemHookClock
    this.#traceSink = options.traceSink ?? (() => {})
  }

  public async invokeObserve<Input>(
    ref: HookRef<Input, void, 'observe'>,
    input: Input,
    options: HookInvocationOptions
  ): Promise<void> {
    const plan = this.#getPlan(ref, 'observe')
    const traceId = options.traceId ?? randomUUID()
    let validatedInput: unknown
    try {
      this.#validateScope(plan, options)
      validatedInput = freezeImmutableData(plan.spec.parseInput(input))
    } catch (error) {
      const failure = await this.#rollback(plan, options, error)
      throw new HookInvocationError(plan.spec.id, failure)
    }
    this.#trace(
      plan,
      'hook.started',
      traceId,
      undefined,
      'started',
      this.#redact(plan, validatedInput, undefined)
    )

    const errors: unknown[] = []
    try {
      if (plan.policy.dispatch === 'parallel') {
        const results = await Promise.allSettled(
          plan.handlers.map(async (handler) => {
            await this.#invokeHandler(
              plan,
              handler,
              validatedInput,
              options,
              traceId,
              (value) => {
                if (value !== undefined) {
                  throw new HookHandlerContractError(
                    plan.spec.id,
                    handler.id,
                    'must return undefined for observe mode.'
                  )
                }
              }
            )
          })
        )
        for (const result of results) {
          if (result.status === 'rejected') errors.push(result.reason)
        }
      } else {
        for (const handler of plan.handlers) {
          try {
            await this.#invokeHandler(
              plan,
              handler,
              validatedInput,
              options,
              traceId,
              (value) => {
                if (value !== undefined) {
                  throw new HookHandlerContractError(
                    plan.spec.id,
                    handler.id,
                    'must return undefined for observe mode.'
                  )
                }
              }
            )
          } catch (error) {
            errors.push(error)
            if (plan.policy.errorPolicy === 'fail-fast') break
          }
        }
      }

      if (errors.length > 0) {
        if (plan.policy.errorPolicy === 'aggregate') {
          throw new HookShutdownAggregateError(plan.spec.id, errors)
        }
        if (plan.policy.errorPolicy === 'fail-fast') {
          throw errors[0]
        }
      }
      this.#trace(
        plan,
        'hook.completed',
        traceId,
        undefined,
        errors.length === 0 ? 'completed' : 'completed_with_isolated_errors'
      )
    } catch (error) {
      const failure = await this.#rollback(plan, options, error)
      this.#trace(plan, 'hook.failed', traceId, undefined, errorName(failure))
      if (failure instanceof HookShutdownAggregateError) throw failure
      throw new HookInvocationError(plan.spec.id, failure)
    }
  }

  public async invokeWaterfall<Input, Patch>(
    ref: HookRef<Input, Patch, 'waterfall'>,
    input: Input,
    options: HookInvocationOptions
  ): Promise<Input> {
    const plan = this.#getPlan(ref, 'waterfall')
    const traceId = options.traceId ?? randomUUID()
    let current: unknown
    try {
      this.#validateScope(plan, options)
      current = freezeImmutableData(plan.spec.parseInput(input))
    } catch (error) {
      const failure = await this.#rollback(plan, options, error)
      throw new HookInvocationError(plan.spec.id, failure)
    }
    this.#trace(
      plan,
      'hook.started',
      traceId,
      undefined,
      'started',
      this.#redact(plan, current, undefined)
    )

    try {
      for (const handler of plan.handlers) {
        const patch = await this.#invokeHandler(
          plan,
          handler,
          current,
          options,
          traceId,
          (value) => plan.spec.parsePatch(value)
        )
        try {
          current = freezeImmutableData(
            plan.spec.parseInput(plan.spec.applyPatch(current, patch))
          )
        } catch (error) {
          throw new HookHandlerContractError(
            plan.spec.id,
            handler.id,
            'produced a patch that resulted in invalid input.',
            error
          )
        }
      }
      this.#trace(
        plan,
        'hook.completed',
        traceId,
        undefined,
        'completed',
        this.#redact(plan, current, undefined)
      )
      // The input schema is the runtime proof paired with the generic Ref.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return current as Input
    } catch (error) {
      const failure = await this.#rollback(plan, options, error)
      this.#trace(plan, 'hook.failed', traceId, undefined, errorName(failure))
      throw new HookInvocationError(plan.spec.id, failure)
    }
  }

  public async invokeGuard<Input>(
    ref: HookRef<Input, Decision, 'guard'>,
    input: Input,
    options: HookInvocationOptions
  ): Promise<Decision> {
    const plan = this.#getPlan(ref, 'guard')
    const traceId = options.traceId ?? randomUUID()
    let validatedInput: unknown
    try {
      this.#validateScope(plan, options)
      validatedInput = freezeImmutableData(plan.spec.parseInput(input))
    } catch (error) {
      const failure = await this.#rollback(plan, options, error)
      throw new HookInvocationError(plan.spec.id, failure)
    }
    this.#trace(
      plan,
      'hook.started',
      traceId,
      undefined,
      'started',
      this.#redact(plan, validatedInput, undefined)
    )

    for (let index = 0; index < plan.handlers.length; index += 1) {
      const handler = plan.handlers[index]!
      let decision: Decision
      try {
        decision = await this.#invokeHandler(
          plan,
          handler,
          validatedInput,
          options,
          traceId,
          (value) => plan.spec.parseDecision(value)
        )
      } catch (error) {
        const failure = await this.#rollback(plan, options, error)
        this.#traceSkipped(plan, index + 1, traceId, 'handler_error')
        this.#trace(plan, 'hook.completed', traceId, undefined, 'denied')
        if (failure !== error) {
          throw new HookInvocationError(plan.spec.id, failure)
        }
        return {
          kind: 'deny',
          code: 'hook_handler_error',
          message: `Extension guard "${handler.id}" failed safely.`,
        }
      }
      if (decision.kind === 'deny') {
        const rollbackError = await this.#rollback(plan, options, decision)
        this.#traceSkipped(plan, index + 1, traceId, 'denied')
        this.#trace(plan, 'hook.completed', traceId, undefined, 'denied')
        if (rollbackError !== decision) {
          throw new HookInvocationError(plan.spec.id, rollbackError)
        }
        return decision
      }
    }
    this.#trace(plan, 'hook.completed', traceId, undefined, 'allowed')
    return { kind: 'allow' }
  }

  #getPlan<Input, Output>(
    ref: HookRef<Input, Output, 'observe'>,
    mode: 'observe'
  ): RuntimeResolvedObservePlan
  #getPlan<Input, Output>(
    ref: HookRef<Input, Output, 'waterfall'>,
    mode: 'waterfall'
  ): RuntimeResolvedWaterfallPlan
  #getPlan<Input, Output>(
    ref: HookRef<Input, Output, 'guard'>,
    mode: 'guard'
  ): RuntimeResolvedGuardPlan
  #getPlan<Input, Output>(
    ref: HookRef<Input, Output>,
    mode: RuntimeResolvedHookPlan['mode']
  ): RuntimeResolvedHookPlan {
    const plan = this.graph.hookPlan(ref)
    if (plan.mode !== mode) {
      throw new TypeError(
        `Hook "${ref.id}" resolved as ${plan.mode}, expected ${mode}.`
      )
    }
    return plan
  }

  #validateScope(
    plan: RuntimeResolvedHookPlan,
    options: HookInvocationOptions
  ): void {
    if (plan.spec.scopeAccess !== options.scopeAccess) {
      throw new HookScopeMismatchError(
        plan.spec.id,
        `${plan.spec.scopeAccess} ${plan.spec.scope}`,
        `${options.scopeAccess} ${options.scope.kind}`
      )
    }
    if (plan.spec.scope !== options.scope.kind) {
      throw new HookScopeMismatchError(
        plan.spec.id,
        plan.spec.scope,
        options.scope.kind
      )
    }
  }

  async #invokeHandler<Result>(
    plan: RuntimeResolvedHookPlan,
    handler: RuntimeResolvedHookHandler,
    input: unknown,
    options: HookInvocationOptions,
    traceId: string,
    validate: (value: unknown) => Result
  ): Promise<Result> {
    const start = this.#clock.now()
    const invocationDeadline = options.deadline ?? Number.POSITIVE_INFINITY
    const remaining = Math.max(0, invocationDeadline - start)
    const timeoutMs = Math.min(plan.policy.handlerTimeoutMs, remaining)
    if (timeoutMs <= 0) {
      const error = new HookHandlerTimeoutError(
        plan.spec.id,
        handler.id,
        timeoutMs
      )
      this.#trace(
        plan,
        'handler.timedOut',
        traceId,
        handler,
        'deadline_exceeded'
      )
      throw error
    }

    const controller = new AbortController()
    const parentSignals = [options.signal ?? neverAbortedSignal]
    if (options.scopeAccess === 'active') {
      parentSignals.push(options.scope.resourceScope.signal)
    }
    const removeAbortListeners = linkAbortSignals(parentSignals, controller)
    if (controller.signal.aborted) {
      removeAbortListeners()
      throw abortReason(controller.signal)
    }
    const handlerDeadline = start + timeoutMs
    let capabilitiesActive = true
    const assertCapabilitiesActive = () => {
      if (!capabilitiesActive || controller.signal.aborted) {
        throw new ExtensionCapabilityExpiredError(
          `Hook context for "${handler.id}"`
        )
      }
    }
    const context = this.#createContext(
      plan,
      handler,
      options,
      controller.signal,
      handlerDeadline,
      traceId,
      assertCapabilitiesActive
    )
    let timedOut = false
    let returned = false
    let timeoutReject!: (reason: unknown) => void
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutReject = reject
    })
    const timeoutError = new HookHandlerTimeoutError(
      plan.spec.id,
      handler.id,
      timeoutMs
    )
    const triggerTimeout = () => {
      if (timedOut) return
      timedOut = true
      controller.abort(timeoutError)
      timeoutReject(timeoutError)
    }
    const timerDelay = handlerDeadline - this.#clock.now()
    let cancelTimer = () => {}
    if (timerDelay <= 0) {
      triggerTimeout()
    } else {
      const timer = this.#clock.setTimer(timerDelay, triggerTimeout)
      cancelTimer = () => timer.cancel()
    }
    this.#trace(
      plan,
      'handler.started',
      traceId,
      handler,
      'started',
      this.#redact(plan, input, undefined)
    )
    if (!controller.signal.aborted && this.#clock.now() >= handlerDeadline) {
      triggerTimeout()
    }

    let removeHandlerAbortListener = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) {
        reject(abortReason(controller.signal))
        return
      }
      const listener = () => reject(abortReason(controller.signal))
      controller.signal.addEventListener('abort', listener, { once: true })
      removeHandlerAbortListener = () =>
        controller.signal.removeEventListener('abort', listener)
    })
    const handlerOperation = Promise.resolve().then(async () => {
      if (!controller.signal.aborted && this.#clock.now() >= handlerDeadline) {
        triggerTimeout()
      }
      if (controller.signal.aborted) throw abortReason(controller.signal)
      return await handler.invoke(input, context)
    })
    const operation = handlerOperation.then((value) => {
      if (this.#clock.now() >= handlerDeadline) {
        triggerTimeout()
        throw timeoutError
      }
      return freezeImmutableData(validate(value))
    })
    void handlerOperation.then(
      (value) => {
        if (returned && plan.policy.trackLateSettlement) {
          this.#trace(
            plan,
            'handler.lateSettled',
            traceId,
            handler,
            timedOut ? 'late_fulfilled_after_timeout' : 'late_fulfilled'
          )
        }
        return value
      },
      (error: unknown) => {
        if (returned && plan.policy.trackLateSettlement) {
          this.#trace(
            plan,
            'handler.lateSettled',
            traceId,
            handler,
            timedOut
              ? 'late_rejected_after_timeout'
              : `late_rejected:${errorName(error)}`
          )
        }
      }
    )

    try {
      const value = await Promise.race([operation, timeout, aborted])
      this.#trace(
        plan,
        'handler.completed',
        traceId,
        handler,
        'completed',
        this.#redact(plan, input, value)
      )
      return value
    } catch (error) {
      this.#trace(
        plan,
        error instanceof HookHandlerTimeoutError
          ? 'handler.timedOut'
          : 'handler.failed',
        traceId,
        handler,
        errorName(error)
      )
      if (error instanceof HookHandlerTimeoutError) throw error
      if (error instanceof HookHandlerContractError) throw error
      throw new HookHandlerContractError(
        plan.spec.id,
        handler.id,
        'failed.',
        error
      )
    } finally {
      returned = true
      capabilitiesActive = false
      cancelTimer()
      removeAbortListeners()
      removeHandlerAbortListener()
      if (!controller.signal.aborted) {
        controller.abort(
          new ExtensionCapabilityExpiredError(
            `Hook context for "${handler.id}"`
          )
        )
      }
    }
  }

  #createContext(
    plan: RuntimeResolvedHookPlan,
    handler: RuntimeResolvedHookHandler,
    options: HookInvocationOptions,
    signal: AbortSignal,
    deadline: number,
    traceId: string,
    assertCapabilitiesActive: () => void
  ): HookInvocationContext {
    const base = {
      extensionId: handler.owner,
      generation: plan.generation,
      signal,
      deadline,
      traceId,
    }
    if (options.scopeAccess === 'terminal') {
      const context: TerminalHookInvocationContext = Object.freeze({
        ...base,
        scopeAccess: 'terminal',
        scope: Object.freeze({ ...options.scope }),
      })
      return context
    }
    const context: ActiveHookInvocationContext = Object.freeze({
      ...base,
      scopeAccess: 'active',
      scope: options.scope.createRegistration({
        signal,
        assertActive: assertCapabilitiesActive,
      }),
      services: this.services.createAccessor({
        scope: options.scope,
        allowedServices: handler.requiredServices,
        signal,
        deadline,
        assertActive: assertCapabilitiesActive,
      }),
    })
    return context
  }

  async #rollback(
    plan: RuntimeResolvedHookPlan,
    options: HookInvocationOptions,
    reason: unknown
  ): Promise<unknown> {
    if (options.scopeAccess !== 'active' || plan.policy.rollback === 'none') {
      return reason
    }
    try {
      const rollbackDeadline = options.deadline
      if (rollbackDeadline === undefined) {
        await options.scope.resourceScope.dispose({ reason })
      } else {
        const remainingMs = Math.max(0, rollbackDeadline - this.#clock.now())
        const cleanup = options.scope.resourceScope.dispose({
          reason,
          timeoutMs: remainingMs,
        })
        void cleanup.catch(() => undefined)
        const timeoutError = new Error(
          `Hook "${plan.spec.id}" rollback exceeded its invocation deadline.`
        )
        if (remainingMs <= 0) throw timeoutError
        let rejectTimeout!: (reason: unknown) => void
        const timeout = new Promise<never>((_resolve, reject) => {
          rejectTimeout = reject
        })
        const timer = this.#clock.setTimer(remainingMs, () =>
          rejectTimeout(timeoutError)
        )
        try {
          try {
            await Promise.race([cleanup, timeout])
            if (this.#clock.now() >= rollbackDeadline) throw timeoutError
          } catch (error) {
            if (
              error !== timeoutError &&
              this.#clock.now() >= rollbackDeadline
            ) {
              throw timeoutError
            }
            throw error
          }
        } finally {
          timer.cancel()
        }
      }
      return reason
    } catch (cleanupError) {
      return new AggregateError(
        [reason, cleanupError],
        `Hook "${plan.spec.id}" failed and scope rollback was incomplete.`,
        { cause: reason }
      )
    }
  }

  #traceSkipped(
    plan: RuntimeResolvedGuardPlan,
    startIndex: number,
    traceId: string,
    reason: string
  ): void {
    for (let index = startIndex; index < plan.handlers.length; index += 1) {
      this.#trace(
        plan,
        'handler.skipped',
        traceId,
        plan.handlers[index],
        reason
      )
    }
  }

  #redact(
    plan: RuntimeResolvedHookPlan,
    input: unknown,
    output: unknown
  ): HookTraceRedaction | undefined {
    try {
      return plan.spec.redact(input, output)
    } catch {
      return undefined
    }
  }

  #trace(
    plan: RuntimeResolvedHookPlan,
    kind: HookTraceEvent['kind'],
    traceId: string,
    handler?: RuntimeResolvedHookHandler,
    resultCategory?: string,
    data?: HookTraceRedaction
  ): void {
    const event: HookTraceEvent = {
      kind,
      traceId,
      generation: plan.generation,
      hookId: plan.spec.id,
      hookVersion: plan.spec.version,
      timestamp: this.#clock.now(),
      ...(handler === undefined
        ? {}
        : {
            handlerId: handler.id,
            extensionId: handler.owner,
            resolvedIndex: handler.resolvedIndex,
          }),
      ...(resultCategory === undefined ? {} : { resultCategory }),
      ...(data === undefined ? {} : { data }),
    }
    try {
      const result: unknown = this.#traceSink(Object.freeze(event))
      void Promise.resolve(result).catch(() => undefined)
    } catch {
      // Diagnostics must never change Hook behavior.
    }
  }
}

const systemHookClock: HookRuntimeClock = Object.freeze({
  now: () => Date.now(),
  setTimer: (delayMs: number, callback: () => void): HookTimerHandle => {
    const timer = setTimeout(callback, delayMs)
    timer.unref()
    return Object.freeze({ cancel: () => clearTimeout(timer) })
  },
})

function linkAbortSignals(
  signals: readonly AbortSignal[],
  controller: AbortController
): () => void {
  const listeners: Array<readonly [AbortSignal, () => void]> = []
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(abortReason(signal))
      continue
    }
    const listener = () => controller.abort(abortReason(signal))
    signal.addEventListener('abort', listener, { once: true })
    listeners.push([signal, listener])
  }
  return () => {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener('abort', listener)
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error
    ? reason
    : new DOMException('Operation aborted', 'AbortError')
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError'
}
