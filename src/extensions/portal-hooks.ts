import type {
  ActiveHookInvocationOptions,
  Capability,
  ExtensionDescriptor,
  ExtensionModule,
  HookRuntimeClock,
  HookTimerHandle,
  HookTraceSink,
  ObserveHookSpec,
  RuntimeSchema,
  ServiceRef,
  TerminalHookInvocationOptions,
} from './extension-contracts.ts'
import { createHookRef } from './extension-contracts.ts'
import { ExtensionRegistry } from './extension-registry.ts'
import {
  activationHookPolicyRef,
  canonicalHookPolicies,
  notificationHookPolicyRef,
  shutdownHookPolicyRef,
} from './hook-policies.ts'
import { HookRunner } from './hook-runner.ts'
import { ServiceContainer } from './service-container.ts'
import {
  CommandRuntime,
  type CommandSessionRuntime,
} from '../cli-commands/core/command-runtime.ts'
import type { CommandDescriptor } from '../cli-commands/core/command-contracts.ts'
import {
  commandContributionSpec,
  commandHandlerBindingSpec,
} from '../cli-commands/core/command-plan.ts'
import { commandServiceRefs } from '../cli-commands/core/command-services.ts'

export type PortalSessionIntent = 'interactive' | 'batch'
export type PortalShutdownPreviousState =
  'resolved' | 'starting' | 'ready' | 'failed'

export interface PortalBeforeStartInput {
  readonly sessionIntent: PortalSessionIntent
  readonly previousState: 'resolved'
}

export interface PortalReadyInput {
  readonly sessionIntent: PortalSessionIntent
}

export interface PortalBeforeStopInput {
  readonly sessionIntent: PortalSessionIntent
  readonly previousState: PortalShutdownPreviousState
}

export interface PortalStoppedInput {
  readonly sessionIntent: PortalSessionIntent
  readonly previousState: PortalShutdownPreviousState
  readonly coreCleanup: {
    readonly status: 'clean' | 'errors'
    readonly errorCount: number
  }
}

export interface PortalExtensionRegistration {
  readonly descriptor: ExtensionDescriptor
  readonly module: ExtensionModule
}

/** @internal Allows domain tests to exercise the production Host integration. */
export const portalHostTestExtensions = Symbol('portal.host.testExtensions')

const noServices: readonly ServiceRef<unknown>[] = Object.freeze([])
const noCapabilities: readonly Capability[] = Object.freeze([])

export const portalBeforeStartHook = createHookRef<
  PortalBeforeStartInput,
  void,
  'observe'
>({ id: 'portal.beforeStart', version: 1, mode: 'observe' })

export const portalReadyHook = createHookRef<PortalReadyInput, void, 'observe'>(
  { id: 'portal.ready', version: 1, mode: 'observe' }
)

export const portalBeforeStopHook = createHookRef<
  PortalBeforeStopInput,
  void,
  'observe'
>({ id: 'portal.beforeStop', version: 1, mode: 'observe' })

export const portalStoppedHook = createHookRef<
  PortalStoppedInput,
  void,
  'observe'
>({ id: 'portal.stopped', version: 1, mode: 'observe' })

export const portalBeforeStartSpec: ObserveHookSpec<PortalBeforeStartInput> =
  Object.freeze({
    ref: portalBeforeStartHook,
    scope: 'portal',
    scopeAccess: 'active',
    inputSchema: schema(parseBeforeStartInput),
    policy: activationHookPolicyRef,
    allowedServices: noServices,
    allowedCapabilities: noCapabilities,
    redact: (input: Readonly<PortalBeforeStartInput>) => ({ input }),
    stability: 'experimental',
  })

export const portalReadySpec: ObserveHookSpec<PortalReadyInput> = Object.freeze(
  {
    ref: portalReadyHook,
    scope: 'portal',
    scopeAccess: 'active',
    inputSchema: schema(parseReadyInput),
    policy: activationHookPolicyRef,
    allowedServices: noServices,
    allowedCapabilities: noCapabilities,
    redact: (input: Readonly<PortalReadyInput>) => ({ input }),
    stability: 'experimental',
  }
)

export const portalBeforeStopSpec: ObserveHookSpec<PortalBeforeStopInput> =
  Object.freeze({
    ref: portalBeforeStopHook,
    scope: 'portal',
    scopeAccess: 'active',
    inputSchema: schema(parseBeforeStopInput),
    policy: shutdownHookPolicyRef,
    allowedServices: noServices,
    allowedCapabilities: noCapabilities,
    redact: (input: Readonly<PortalBeforeStopInput>) => ({ input }),
    stability: 'experimental',
  })

export const portalStoppedSpec: ObserveHookSpec<PortalStoppedInput> =
  Object.freeze({
    ref: portalStoppedHook,
    scope: 'portal',
    scopeAccess: 'terminal',
    inputSchema: schema(parseStoppedInput),
    policy: notificationHookPolicyRef,
    allowedServices: noServices,
    allowedCapabilities: noCapabilities,
    redact: (input: Readonly<PortalStoppedInput>) => ({ input }),
    stability: 'experimental',
  })

export class PortalHookRuntime implements HookRuntimeClock {
  readonly #clock: HookRuntimeClock
  readonly #runner: HookRunner
  readonly #commandRuntime: CommandRuntime

  public readonly generation: string

  public constructor(
    options: {
      readonly generation?: string
      readonly extensions?: readonly PortalExtensionRegistration[]
      readonly clock?: HookRuntimeClock
      readonly traceSink?: HookTraceSink
    } = {}
  ) {
    this.#clock = options.clock ?? systemPortalHookClock
    const registry = new ExtensionRegistry({
      generation: options.generation ?? 'portal-host-v1',
      policies: canonicalHookPolicies,
    })
    registry.defineHook(portalBeforeStartSpec)
    registry.defineHook(portalReadySpec)
    registry.defineHook(portalBeforeStopSpec)
    registry.defineHook(portalStoppedSpec)
    for (const service of commandServiceRefs) {
      registry.defineService(service)
    }
    registry.defineContribution(commandContributionSpec)
    registry.defineExecutableBinding(commandHandlerBindingSpec)
    for (const extension of options.extensions ?? []) {
      registry.register(extension.descriptor, extension.module)
    }
    const graph = registry.freeze()
    this.generation = graph.generation
    const services = new ServiceContainer(graph.servicePlan, {
      clock: this.#clock,
    })
    this.#runner = new HookRunner(graph, services, {
      clock: this.#clock,
      ...(options.traceSink === undefined
        ? {}
        : { traceSink: options.traceSink }),
    })
    this.#commandRuntime = new CommandRuntime(graph, {
      clock: this.#clock,
      serviceContainer: services,
    })
  }

  public now(): number {
    return this.#clock.now()
  }

  public setTimer(delayMs: number, callback: () => void): HookTimerHandle {
    return this.#clock.setTimer(delayMs, callback)
  }

  public async beforeStart(
    input: PortalBeforeStartInput,
    options: ActiveHookInvocationOptions
  ): Promise<void> {
    await this.#runner.invokeObserve(portalBeforeStartHook, input, options)
  }

  public async ready(
    input: PortalReadyInput,
    options: ActiveHookInvocationOptions
  ): Promise<void> {
    await this.#runner.invokeObserve(portalReadyHook, input, options)
  }

  public async beforeStop(
    input: PortalBeforeStopInput,
    options: ActiveHookInvocationOptions
  ): Promise<void> {
    await this.#runner.invokeObserve(portalBeforeStopHook, input, options)
  }

  public async stopped(
    input: PortalStoppedInput,
    options: TerminalHookInvocationOptions
  ): Promise<void> {
    await this.#runner.invokeObserve(portalStoppedHook, input, options)
  }

  public openCommandSession(
    parent: import('./scope-registration.ts').ExtensionResourceScope,
    resourceId: string
  ): CommandSessionRuntime {
    return this.#commandRuntime.openSession(parent, resourceId)
  }

  public commandCatalog(): readonly CommandDescriptor[] {
    return this.#commandRuntime.plan.catalog
  }
}

function schema<Value>(parse: (value: unknown) => Value): RuntimeSchema<Value> {
  return Object.freeze({ parse })
}

function parseBeforeStartInput(value: unknown): PortalBeforeStartInput {
  const fields = strictFields(value, ['sessionIntent', 'previousState'])
  return {
    sessionIntent: parseSessionIntent(fields.get('sessionIntent')),
    previousState: parseLiteral(
      fields.get('previousState'),
      ['resolved'] as const,
      'previousState'
    ),
  }
}

function parseReadyInput(value: unknown): PortalReadyInput {
  const fields = strictFields(value, ['sessionIntent'])
  return { sessionIntent: parseSessionIntent(fields.get('sessionIntent')) }
}

function parseBeforeStopInput(value: unknown): PortalBeforeStopInput {
  const fields = strictFields(value, ['sessionIntent', 'previousState'])
  return {
    sessionIntent: parseSessionIntent(fields.get('sessionIntent')),
    previousState: parseShutdownState(fields.get('previousState')),
  }
}

function parseStoppedInput(value: unknown): PortalStoppedInput {
  const fields = strictFields(value, [
    'sessionIntent',
    'previousState',
    'coreCleanup',
  ])
  const cleanup = strictFields(fields.get('coreCleanup'), [
    'status',
    'errorCount',
  ])
  const errorCount = cleanup.get('errorCount')
  if (!Number.isSafeInteger(errorCount) || Number(errorCount) < 0) {
    throw new TypeError(
      'coreCleanup.errorCount must be a non-negative integer.'
    )
  }
  return {
    sessionIntent: parseSessionIntent(fields.get('sessionIntent')),
    previousState: parseShutdownState(fields.get('previousState')),
    coreCleanup: {
      status: parseLiteral(
        cleanup.get('status'),
        ['clean', 'errors'] as const,
        'coreCleanup.status'
      ),
      errorCount: Number(errorCount),
    },
  }
}

function parseSessionIntent(value: unknown): PortalSessionIntent {
  return parseLiteral(value, ['interactive', 'batch'] as const, 'sessionIntent')
}

function parseShutdownState(value: unknown): PortalShutdownPreviousState {
  return parseLiteral(
    value,
    ['resolved', 'starting', 'ready', 'failed'] as const,
    'previousState'
  )
}

function parseLiteral<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  field: string
): Value {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} has an unsupported value.`)
  }
  const matched = allowed.find((candidate) => candidate === value)
  if (matched === undefined) {
    throw new TypeError(`${field} has an unsupported value.`)
  }
  return matched
}

function strictFields(
  value: unknown,
  expected: readonly string[]
): ReadonlyMap<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError('Hook input must be a plain object.')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const actual = Reflect.ownKeys(descriptors)
  if (
    actual.some((key) => typeof key !== 'string') ||
    actual.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(descriptors, key))
  ) {
    throw new TypeError('Hook input has unexpected fields.')
  }
  const fields = new Map<string, unknown>()
  for (const key of expected) {
    const descriptor = descriptors[key]
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`Hook input field "${key}" must be a data property.`)
    }
    fields.set(key, descriptor.value)
  }
  return fields
}

const systemPortalHookClock: HookRuntimeClock = Object.freeze({
  now: () => Date.now(),
  setTimer: (delayMs: number, callback: () => void): HookTimerHandle => {
    const timer = setTimeout(callback, delayMs)
    return Object.freeze({ cancel: () => clearTimeout(timer) })
  },
})
