import type {
  ExtensionDescriptor,
  HookRuntimeClock,
  HookTimerHandle,
  ResolvedHookPolicy,
  RuntimeSchema,
} from '../../src/extensions/extension-contracts.ts'
import { createHookPolicyRef } from '../../src/extensions/extension-contracts.ts'
import { ExtensionTestHost } from '../../src/extensions/extension-test-host.ts'

export const activationPolicyRef = createHookPolicyRef('activation')
export const notificationPolicyRef = createHookPolicyRef('notification')
export const transformPolicyRef = createHookPolicyRef('transform')
export const guardPolicyRef = createHookPolicyRef('guard')
export const shutdownPolicyRef = createHookPolicyRef('shutdown')

export const testPolicies: readonly ResolvedHookPolicy[] = Object.freeze([
  Object.freeze({
    ref: activationPolicyRef,
    dispatch: 'serial',
    handlerTimeoutMs: 100,
    errorPolicy: 'fail-fast',
    rollback: 'resource-scope',
    trackLateSettlement: true,
  }),
  Object.freeze({
    ref: notificationPolicyRef,
    dispatch: 'parallel',
    handlerTimeoutMs: 100,
    errorPolicy: 'isolate',
    rollback: 'none',
    trackLateSettlement: true,
  }),
  Object.freeze({
    ref: transformPolicyRef,
    dispatch: 'serial',
    handlerTimeoutMs: 100,
    errorPolicy: 'fail-fast',
    rollback: 'operation-scope',
    trackLateSettlement: true,
  }),
  Object.freeze({
    ref: guardPolicyRef,
    dispatch: 'serial',
    handlerTimeoutMs: 100,
    errorPolicy: 'deny',
    rollback: 'operation-scope',
    trackLateSettlement: true,
  }),
  Object.freeze({
    ref: shutdownPolicyRef,
    dispatch: 'serial',
    handlerTimeoutMs: 100,
    errorPolicy: 'aggregate',
    rollback: 'none',
    trackLateSettlement: true,
  }),
])

export function createTestHost(
  options: {
    readonly generation?: string
    readonly clock?: HookRuntimeClock
    readonly contributionSelections?: Readonly<
      Record<string, Readonly<Record<string, string>>>
    >
    readonly traceSink?: ConstructorParameters<
      typeof ExtensionTestHost
    >[0]['traceSink']
  } = {}
): ExtensionTestHost {
  return new ExtensionTestHost({
    generation: options.generation ?? 'test-generation',
    policies: testPolicies,
    ...(options.contributionSelections === undefined
      ? {}
      : { contributionSelections: options.contributionSelections }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.traceSink === undefined
      ? {}
      : { traceSink: options.traceSink }),
  })
}

export function extension(
  id: string,
  options: {
    readonly dependencies?: readonly string[]
    readonly capabilities?: readonly string[]
  } = {}
): ExtensionDescriptor {
  return {
    id,
    version: '1.0.0',
    dependencies: options.dependencies ?? [],
    capabilities: options.capabilities ?? [],
  }
}

export function objectSchema<Value>(
  parse: (record: Readonly<Record<string, unknown>>) => Value
): RuntimeSchema<Value> {
  return {
    parse(value: unknown): Value {
      if (!isRecord(value)) throw new TypeError('Expected an object.')
      return parse(value)
    },
  }
}

export function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string
): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new TypeError(`Expected ${key} to be a string.`)
  }
  return value
}

export class ManualHookClock implements HookRuntimeClock {
  readonly #timers: Array<{
    readonly at: number
    readonly callback: () => void
    cancelled: boolean
  }> = []
  #now = 0

  public now(): number {
    return this.#now
  }

  public setTimer(delayMs: number, callback: () => void): HookTimerHandle {
    const timer = {
      at: this.#now + delayMs,
      callback,
      cancelled: false,
    }
    this.#timers.push(timer)
    return { cancel: () => (timer.cancelled = true) }
  }

  public advance(ms: number): void {
    this.#now += ms
    const ready = this.#timers
      .filter((timer) => !timer.cancelled && timer.at <= this.#now)
      .sort((left, right) => left.at - right.at)
    for (const timer of ready) {
      timer.cancelled = true
      timer.callback()
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
