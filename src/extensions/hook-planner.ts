import type {
  Capability,
  Decision,
  ExtensionDescriptor,
  ExtensionId,
  HandlerId,
  HookInvocationContext,
  HookMode,
  HookPolicyRef,
  HookRef,
  HookTraceRedactor,
  ObserveHookSpec,
  ResolvedHookPolicy,
  ResourceScopeKind,
  RuntimeSchema,
  ServiceRef,
  WaterfallHookSpec,
  GuardHookSpec,
} from './extension-contracts.ts'
import {
  CapabilityNotGrantedError,
  DuplicateHandlerIdError,
  ExtensionResolutionError,
  GraphResolutionError,
  HookPolicyMismatchError,
  RequirementNotAllowedError,
} from './extension-errors.ts'

export interface RuntimeHookSpecBase {
  readonly refIdentity: object
  readonly refKey: symbol
  readonly id: string
  readonly version: number
  readonly mode: HookMode
  readonly scope: ResourceScopeKind
  readonly scopeAccess: 'active' | 'terminal'
  readonly policyKey: symbol
  readonly policyId: string
  readonly policyIdentity: object
  readonly allowedServices: readonly ServiceRef<unknown>[]
  readonly allowedCapabilities: readonly Capability[]
  readonly stability: 'experimental' | 'stable'
  parseInput(value: unknown): unknown
  redact(
    input: unknown,
    output: unknown
  ): {
    readonly input?: unknown
    readonly output?: unknown
  }
}

export interface RuntimeObserveHookSpec extends RuntimeHookSpecBase {
  readonly mode: 'observe'
}

export interface RuntimeWaterfallHookSpec extends RuntimeHookSpecBase {
  readonly mode: 'waterfall'
  parsePatch(value: unknown): unknown
  applyPatch(current: unknown, patch: unknown): unknown
}

export interface RuntimeGuardHookSpec extends RuntimeHookSpecBase {
  readonly mode: 'guard'
  parseDecision(value: unknown): Decision
}

export type RuntimeHookSpec =
  RuntimeObserveHookSpec | RuntimeWaterfallHookSpec | RuntimeGuardHookSpec

export interface PendingHookHandler {
  readonly refKey: symbol
  readonly hookId: string
  readonly id: HandlerId
  readonly owner: ExtensionId
  readonly requiredServices: readonly ServiceRef<unknown>[]
  readonly requiredCapabilities: readonly Capability[]
  readonly before: readonly HandlerId[]
  readonly after: readonly HandlerId[]
  invoke(input: unknown, context: HookInvocationContext): Promise<unknown>
}

export interface RuntimeResolvedHookHandler extends PendingHookHandler {
  readonly resolvedIndex: number
}

export interface RuntimeResolvedObservePlan {
  readonly mode: 'observe'
  readonly generation: string
  readonly spec: RuntimeObserveHookSpec
  readonly policy: ResolvedHookPolicy
  readonly handlers: readonly RuntimeResolvedHookHandler[]
}

export interface RuntimeResolvedWaterfallPlan {
  readonly mode: 'waterfall'
  readonly generation: string
  readonly spec: RuntimeWaterfallHookSpec
  readonly policy: ResolvedHookPolicy
  readonly handlers: readonly RuntimeResolvedHookHandler[]
}

export interface RuntimeResolvedGuardPlan {
  readonly mode: 'guard'
  readonly generation: string
  readonly spec: RuntimeGuardHookSpec
  readonly policy: ResolvedHookPolicy
  readonly handlers: readonly RuntimeResolvedHookHandler[]
}

export type RuntimeResolvedHookPlan =
  | RuntimeResolvedObservePlan
  | RuntimeResolvedWaterfallPlan
  | RuntimeResolvedGuardPlan

export function toRuntimeObserveSpec<Input>(
  spec: ObserveHookSpec<Input>
): RuntimeObserveHookSpec {
  return Object.freeze({
    ...runtimeSpecBase(spec),
    mode: 'observe',
  })
}

export function toRuntimeWaterfallSpec<Input, Patch>(
  spec: WaterfallHookSpec<Input, Patch>
): RuntimeWaterfallHookSpec {
  const parsePatch = spec.patchSchema.parse.bind(spec.patchSchema)
  const applyPatch = spec.applyPatch
  return Object.freeze({
    ...runtimeSpecBase(spec),
    mode: 'waterfall',
    parsePatch,
    applyPatch: (current: unknown, patch: unknown) =>
      applyPatch(
        // Runner validates and freezes both values before this erased boundary.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        current as Input,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        patch as Patch
      ),
  })
}

export function toRuntimeGuardSpec<Input>(
  spec: GuardHookSpec<Input>
): RuntimeGuardHookSpec {
  const parseDecision = spec.decisionSchema.parse.bind(spec.decisionSchema)
  return Object.freeze({
    ...runtimeSpecBase(spec),
    mode: 'guard',
    parseDecision,
  })
}

export class HookPlanner {
  readonly #policies: ReadonlyMap<symbol, ResolvedHookPolicy>

  public constructor(policies: readonly ResolvedHookPolicy[]) {
    const byKey = new Map<symbol, ResolvedHookPolicy>()
    const ids = new Set<string>()
    for (const policy of policies) {
      if (!Object.isFrozen(policy.ref)) {
        throw new ExtensionResolutionError(
          `Hook policy ref "${policy.ref.id}" was not created by Portal.`
        )
      }
      if (byKey.has(policy.ref.key) || ids.has(policy.ref.id)) {
        throw new ExtensionResolutionError(
          `Hook policy "${policy.ref.id}" is defined more than once.`
        )
      }
      if (
        !Number.isFinite(policy.handlerTimeoutMs) ||
        policy.handlerTimeoutMs < 0
      ) {
        throw new ExtensionResolutionError(
          `Hook policy "${policy.ref.id}" has an invalid timeout.`
        )
      }
      byKey.set(policy.ref.key, freezePolicy(policy))
      ids.add(policy.ref.id)
    }
    this.#policies = byKey
  }

  public resolve(
    generation: string,
    specs: readonly RuntimeHookSpec[],
    handlers: readonly PendingHookHandler[],
    extensions: ReadonlyMap<ExtensionId, ExtensionDescriptor>
  ): ReadonlyMap<symbol, RuntimeResolvedHookPlan> {
    const plans = new Map<symbol, RuntimeResolvedHookPlan>()
    const specIds = new Set<string>()

    for (const spec of specs) {
      if (plans.has(spec.refKey) || specIds.has(spec.id)) {
        throw new ExtensionResolutionError(
          `Hook spec "${spec.id}" is defined more than once.`
        )
      }
      validateSpec(spec)
      const policy = this.#policies.get(spec.policyKey)
      if (
        policy === undefined ||
        policy.ref.id !== spec.policyId ||
        policy.ref !== spec.policyIdentity
      ) {
        throw new HookPolicyMismatchError(spec.id, spec.policyId)
      }
      validatePolicyForMode(spec, policy)
      const pending = handlers.filter(
        (handler) => handler.refKey === spec.refKey
      )
      validateHandlers(spec, pending, extensions)
      const ordered = stableTopologicalOrder(
        `Hook ${spec.id}`,
        pending,
        extensions
      ).map((handler, resolvedIndex) =>
        Object.freeze({ ...handler, resolvedIndex })
      )
      switch (spec.mode) {
        case 'observe':
          plans.set(
            spec.refKey,
            Object.freeze({
              mode: 'observe',
              generation,
              spec,
              policy,
              handlers: Object.freeze(ordered),
            })
          )
          break
        case 'waterfall':
          plans.set(
            spec.refKey,
            Object.freeze({
              mode: 'waterfall',
              generation,
              spec,
              policy,
              handlers: Object.freeze(ordered),
            })
          )
          break
        case 'guard':
          plans.set(
            spec.refKey,
            Object.freeze({
              mode: 'guard',
              generation,
              spec,
              policy,
              handlers: Object.freeze(ordered),
            })
          )
          break
      }
      specIds.add(spec.id)
    }

    for (const handler of handlers) {
      if (!plans.has(handler.refKey)) {
        throw new ExtensionResolutionError(
          `Handler "${handler.id}" targets unknown Hook "${handler.hookId}".`
        )
      }
    }
    return plans
  }
}

export interface OrderedItem {
  readonly id: string
  readonly owner: ExtensionId
  readonly before: readonly string[]
  readonly after: readonly string[]
}

export function stableTopologicalOrder<Item extends OrderedItem>(
  graphName: string,
  items: readonly Item[],
  extensions: ReadonlyMap<ExtensionId, ExtensionDescriptor>
): Item[] {
  const byId = new Map<string, Item>()
  for (const item of items) {
    if (byId.has(item.id)) {
      throw new GraphResolutionError(
        graphName,
        `item ID "${item.id}" is registered more than once.`
      )
    }
    byId.set(item.id, item)
  }

  const outgoing = new Map<string, Set<string>>()
  const indegree = new Map<string, number>()
  for (const item of items) {
    outgoing.set(item.id, new Set())
    indegree.set(item.id, 0)
  }
  const addEdge = (from: string, to: string) => {
    const targets = outgoing.get(from)
    if (targets === undefined || !indegree.has(to)) {
      throw new GraphResolutionError(
        graphName,
        `ordering target "${targets === undefined ? from : to}" does not exist.`
      )
    }
    if (!targets.has(to)) {
      targets.add(to)
      indegree.set(to, indegree.get(to)! + 1)
    }
  }

  for (const item of items) {
    for (const target of item.before) addEdge(item.id, target)
    for (const target of item.after) addEdge(target, item.id)
  }
  for (const dependent of items) {
    const descriptor = extensions.get(dependent.owner)
    if (descriptor === undefined) {
      throw new GraphResolutionError(
        graphName,
        `owner Extension "${dependent.owner}" is missing.`
      )
    }
    for (const dependencyId of descriptor.dependencies) {
      for (const dependencyItem of items) {
        if (dependencyItem.owner === dependencyId) {
          addEdge(dependencyItem.id, dependent.id)
        }
      }
    }
  }

  const compare = (left: Item, right: Item) =>
    compareAscii(left.owner, right.owner) || compareAscii(left.id, right.id)
  const ready = items
    .filter((item) => indegree.get(item.id) === 0)
    .sort(compare)
  const result: Item[] = []
  while (ready.length > 0) {
    const next = ready.shift()!
    result.push(next)
    for (const target of outgoing.get(next.id)!) {
      const remaining = indegree.get(target)! - 1
      indegree.set(target, remaining)
      if (remaining === 0) {
        ready.push(byId.get(target)!)
        ready.sort(compare)
      }
    }
  }
  if (result.length !== items.length) {
    const unresolved = items
      .filter((item) => !result.includes(item))
      .map((item) => item.id)
      .sort()
    throw new GraphResolutionError(
      graphName,
      `cycle detected among ${unresolved.join(', ')}.`
    )
  }
  return result
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function runtimeSpecBase<Input, Output, Mode extends HookMode>(spec: {
  readonly ref: HookRef<Input, Output, Mode>
  readonly scope: ResourceScopeKind
  readonly scopeAccess: 'active' | 'terminal'
  readonly inputSchema: RuntimeSchema<Input>
  readonly policy: HookPolicyRef
  readonly allowedServices: readonly ServiceRef<unknown>[]
  readonly allowedCapabilities: readonly Capability[]
  readonly redact: HookTraceRedactor<Input, Output>
  readonly stability: 'experimental' | 'stable'
}): Omit<RuntimeHookSpecBase, 'mode'> {
  const parseInput = spec.inputSchema.parse.bind(spec.inputSchema)
  const redact = spec.redact
  return {
    refIdentity: spec.ref,
    refKey: spec.ref.key,
    id: spec.ref.id,
    version: spec.ref.version,
    scope: spec.scope,
    scopeAccess: spec.scopeAccess,
    policyKey: spec.policy.key,
    policyId: spec.policy.id,
    policyIdentity: spec.policy,
    allowedServices: Object.freeze([...spec.allowedServices]),
    allowedCapabilities: Object.freeze([...spec.allowedCapabilities]),
    stability: spec.stability,
    parseInput,
    redact: (input: unknown, output: unknown) =>
      redact(
        // Runner validates and freezes values before this erased boundary.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        input as Input,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        output as Output | undefined
      ),
  }
}

function validateSpec(spec: RuntimeHookSpec): void {
  if (spec.scopeAccess === 'terminal') {
    if (spec.mode !== 'observe') {
      throw new ExtensionResolutionError(
        `Terminal Hook "${spec.id}" must use observe mode.`
      )
    }
    if (spec.allowedServices.length > 0) {
      throw new ExtensionResolutionError(
        `Terminal Hook "${spec.id}" cannot expose target services.`
      )
    }
  }
}

function validatePolicyForMode(
  spec: RuntimeHookSpec,
  policy: ResolvedHookPolicy
): void {
  if (spec.mode !== 'observe' && policy.dispatch !== 'serial') {
    throw new ExtensionResolutionError(
      `Hook "${spec.id}" mode "${spec.mode}" requires serial dispatch.`
    )
  }
  if (spec.mode === 'waterfall' && policy.errorPolicy !== 'fail-fast') {
    throw new ExtensionResolutionError(
      `Waterfall Hook "${spec.id}" requires fail-fast error policy.`
    )
  }
  if (spec.mode === 'guard' && policy.errorPolicy !== 'deny') {
    throw new ExtensionResolutionError(
      `Guard Hook "${spec.id}" requires deny error policy.`
    )
  }
}

function validateHandlers(
  spec: RuntimeHookSpec,
  handlers: readonly PendingHookHandler[],
  extensions: ReadonlyMap<ExtensionId, ExtensionDescriptor>
): void {
  const ids = new Set<string>()
  const allowedServiceKeys = new Set(
    spec.allowedServices.map((service) => service.key)
  )
  const allowedCapabilities = new Set(spec.allowedCapabilities)
  for (const handler of handlers) {
    if (ids.has(handler.id)) throw new DuplicateHandlerIdError(handler.id)
    ids.add(handler.id)
    const extension = extensions.get(handler.owner)
    if (extension === undefined) {
      throw new ExtensionResolutionError(
        `Handler "${handler.id}" has unknown owner "${handler.owner}".`
      )
    }
    const granted = new Set(extension.capabilities)
    for (const service of handler.requiredServices) {
      if (!allowedServiceKeys.has(service.key)) {
        throw new RequirementNotAllowedError(
          handler.owner,
          `Service "${service.id}"`,
          `Hook "${spec.id}"`
        )
      }
    }
    for (const capability of handler.requiredCapabilities) {
      if (!allowedCapabilities.has(capability)) {
        throw new RequirementNotAllowedError(
          handler.owner,
          `capability "${capability}"`,
          `Hook "${spec.id}"`
        )
      }
      if (!granted.has(capability)) {
        throw new CapabilityNotGrantedError(handler.owner, capability)
      }
    }
  }
}

function freezePolicy(policy: ResolvedHookPolicy): ResolvedHookPolicy {
  return Object.freeze({ ...policy })
}
