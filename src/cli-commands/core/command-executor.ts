import type { HookRuntimeClock } from '../../extensions/extension-contracts.ts'
import { ExtensionCapabilityExpiredError } from '../../extensions/extension-errors.ts'
import { freezeImmutableData } from '../../extensions/immutable-data.ts'
import type { ExtensionResourceScope } from '../../extensions/scope-registration.ts'
import { ServiceContainer } from '../../extensions/service-container.ts'
import type {
  CommandExecutionContext,
  CommandResult,
  CommandTraceEvent,
  CommandTraceEventKind,
  CommandTraceSink,
  PreparedCommandInvocation,
} from './command-contracts.ts'
import {
  CommandInvocationError,
  CommandResultValidationError,
  CommandTimeoutError,
} from './command-errors.ts'
import { ResolvedCommandPlan } from './command-plan.ts'

export interface CommandExecutionOptions {
  readonly parentScope: ExtensionResourceScope
  readonly signal: AbortSignal
  readonly deadline: number
  readonly executionId?: string
}

/** @internal Construct through CommandRuntime so all resources share one clock. */
export class CommandExecutor {
  readonly #clock: HookRuntimeClock
  readonly #traceSink: CommandTraceSink
  #nextExecutionId = 1

  public constructor(
    private readonly plan: ResolvedCommandPlan,
    private readonly services: ServiceContainer,
    clock: HookRuntimeClock,
    traceSink?: CommandTraceSink
  ) {
    this.#clock = clock
    this.#traceSink = traceSink ?? (() => {})
  }

  public async execute(
    invocation: PreparedCommandInvocation,
    options: CommandExecutionOptions
  ): Promise<CommandResult> {
    const command = this.plan.resolvePrepared(invocation)
    if (
      typeof options.deadline !== 'number' ||
      (!Number.isFinite(options.deadline) &&
        options.deadline !== Number.POSITIVE_INFINITY)
    ) {
      throw new CommandInvocationError(
        command.descriptor.id,
        'Command deadline must be a finite absolute time or positive Infinity.'
      )
    }
    if (options.parentScope.kind !== 'session') {
      throw new CommandInvocationError(
        command.descriptor.id,
        `Command parent scope must be session, received ${options.parentScope.kind}.`
      )
    }
    const executionId =
      options.executionId ?? `command-${String(this.#nextExecutionId++)}`
    if (options.signal.aborted) throw abortReason(options.signal)
    if (this.#clock.now() >= options.deadline) {
      throw new CommandTimeoutError(command.descriptor.id)
    }

    const operationScope = options.parentScope.createChild(
      'command',
      executionId
    )
    const controller = new AbortController()
    const removeAbortListeners = linkAbortSignals(
      [options.parentScope.resourceScope.signal, options.signal],
      controller
    )
    let capabilitiesActive = true
    const assertCapabilitiesActive = () => {
      if (!capabilitiesActive || controller.signal.aborted) {
        throw new ExtensionCapabilityExpiredError(
          `Command context for "${command.descriptor.id}"`
        )
      }
    }
    const context: CommandExecutionContext = Object.freeze({
      extensionId: command.owner,
      generation: this.plan.generation,
      executionId,
      signal: controller.signal,
      deadline: options.deadline,
      scope: operationScope.createRegistration({
        signal: controller.signal,
        assertActive: assertCapabilitiesActive,
      }),
      services: this.services.createAccessor({
        scope: operationScope,
        allowedServices: command.requiredServices,
        signal: controller.signal,
        deadline: options.deadline,
        assertActive: assertCapabilitiesActive,
      }),
    })

    const timeoutError = new CommandTimeoutError(command.descriptor.id)
    let timedOut = false
    let returned = false
    let rejectTimeout!: (reason: unknown) => void
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject
    })
    const triggerTimeout = () => {
      if (timedOut) return
      timedOut = true
      capabilitiesActive = false
      controller.abort(timeoutError)
      rejectTimeout(timeoutError)
    }
    const remainingMs = options.deadline - this.#clock.now()
    let cancelTimer = () => {}
    if (remainingMs <= 0) {
      triggerTimeout()
    } else if (Number.isFinite(remainingMs)) {
      const timer = this.#clock.setTimer(remainingMs, triggerTimeout)
      cancelTimer = () => timer.cancel()
    }

    this.#trace(command, 'command.started', executionId, 'started')
    if (!controller.signal.aborted && this.#clock.now() >= options.deadline) {
      triggerTimeout()
    }

    let removeOperationAbortListener = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) {
        reject(abortReason(controller.signal))
        return
      }
      const listener = () => reject(abortReason(controller.signal))
      controller.signal.addEventListener('abort', listener, { once: true })
      removeOperationAbortListener = () =>
        controller.signal.removeEventListener('abort', listener)
    })
    const handlerOperation = Promise.resolve().then(async () => {
      if (!controller.signal.aborted && this.#clock.now() >= options.deadline) {
        triggerTimeout()
      }
      if (controller.signal.aborted) throw abortReason(controller.signal)
      return await command.handler(invocation, context)
    })
    void handlerOperation.then(
      () => {
        if (returned) {
          this.#trace(
            command,
            'command.lateSettled',
            executionId,
            timedOut ? 'late_fulfilled_after_timeout' : 'late_fulfilled'
          )
        }
      },
      (error: unknown) => {
        if (returned) {
          this.#trace(
            command,
            'command.lateSettled',
            executionId,
            timedOut
              ? 'late_rejected_after_timeout'
              : `late_rejected:${errorName(error)}`
          )
        }
      }
    )

    let result: CommandResult | null = null
    let failure: unknown = null
    let terminalKind: CommandTraceEventKind = 'command.completed'
    let terminalCategory: string
    try {
      const rawResult = await Promise.race([handlerOperation, timeout, aborted])
      if (this.#clock.now() >= options.deadline) {
        triggerTimeout()
        throw timeoutError
      }
      result = parseCommandResult(rawResult, command.descriptor.id)
      terminalCategory = result.disposition
    } catch (error) {
      failure = error
      terminalKind =
        error instanceof CommandTimeoutError
          ? 'command.timedOut'
          : controller.signal.aborted
            ? 'command.cancelled'
            : 'command.failed'
      terminalCategory = errorName(error)
    } finally {
      returned = true
      capabilitiesActive = false
      if (!controller.signal.aborted) {
        controller.abort(new Error('Command execution completed.'))
      }
      cancelTimer()
      removeOperationAbortListener()
      removeAbortListeners()
      try {
        const remaining = Math.max(0, options.deadline - this.#clock.now())
        const cleanup = operationScope.resourceScope.dispose({
          reason:
            failure ??
            new Error(`Command "${command.descriptor.id}" completed.`),
          ...(Number.isFinite(remaining) ? { timeoutMs: remaining } : {}),
        })
        await settleBeforeDeadline(
          cleanup,
          options.deadline,
          this.#clock,
          new Error(
            `Command "${command.descriptor.id}" cleanup exceeded its invocation deadline.`
          )
        )
      } catch (cleanupError) {
        failure =
          failure === null
            ? new CommandInvocationError(
                command.descriptor.id,
                `Command "${command.descriptor.id}" cleanup failed.`,
                { cause: cleanupError }
              )
            : new CommandInvocationError(
                command.descriptor.id,
                `Command "${command.descriptor.id}" failed and cleanup was incomplete.`,
                {
                  cause: new AggregateError(
                    [failure, cleanupError],
                    'Command execution and cleanup failed.',
                    { cause: failure }
                  ),
                }
              )
        terminalKind = 'command.failed'
        terminalCategory = errorName(failure)
      }
    }
    this.#trace(command, terminalKind, executionId, terminalCategory)
    if (failure !== null) {
      if (failure instanceof Error) throw failure
      throw new CommandInvocationError(
        command.descriptor.id,
        `Command "${command.descriptor.id}" failed.`,
        { cause: failure }
      )
    }
    return result!
  }

  #trace(
    command: ReturnType<ResolvedCommandPlan['resolvePrepared']>,
    kind: CommandTraceEventKind,
    executionId: string,
    resultCategory: string
  ): void {
    const event: CommandTraceEvent = Object.freeze({
      kind,
      generation: this.plan.generation,
      executionId,
      commandId: command.descriptor.id,
      extensionId: command.owner,
      resolvedIndex: command.resolvedIndex,
      timestamp: this.#clock.now(),
      resultCategory,
    })
    try {
      const result: unknown = this.#traceSink(event)
      void Promise.resolve(result).catch(() => undefined)
    } catch {
      // Diagnostics must never change Command behavior.
    }
  }
}

function parseCommandResult(
  value: unknown,
  commandId: ReturnType<
    ResolvedCommandPlan['resolvePrepared']
  >['descriptor']['id']
): CommandResult {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      throw new TypeError('Command result must be a plain object.')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (
      keys.length !== 1 ||
      keys[0] !== 'disposition' ||
      descriptors.disposition === undefined ||
      !('value' in descriptors.disposition)
    ) {
      throw new TypeError('Command result has unexpected fields.')
    }
    const disposition: unknown = descriptors.disposition.value
    if (disposition !== 'continue' && disposition !== 'request-stop') {
      throw new TypeError('Command result has an invalid disposition.')
    }
    return freezeImmutableData({ disposition })
  } catch (error) {
    throw new CommandResultValidationError(commandId, { cause: error })
  }
}

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

async function settleBeforeDeadline(
  operation: Promise<void>,
  deadline: number,
  clock: HookRuntimeClock,
  timeoutError: Error
): Promise<void> {
  void operation.catch(() => undefined)
  if (!Number.isFinite(deadline)) {
    await operation
    return
  }
  const remaining = deadline - clock.now()
  if (remaining <= 0) throw timeoutError
  let rejectTimeout!: (reason: unknown) => void
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject
  })
  const timer = clock.setTimer(remaining, () => rejectTimeout(timeoutError))
  try {
    try {
      await Promise.race([operation, timeout])
      if (clock.now() >= deadline) throw timeoutError
    } catch (error) {
      if (error !== timeoutError && clock.now() >= deadline) {
        throw timeoutError
      }
      throw error
    }
  } finally {
    timer.cancel()
  }
}
