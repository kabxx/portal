import type {
  Capability,
  ContributionId,
  ContributionRef,
  ContributionRegistration,
  ContributionSpec,
  ExtensionDescriptor,
  ExtensionId,
  ExtensionModule,
  ExtensionRegistrationApi,
  HookHandlerRegistration,
  HookMode,
  HookRef,
  InitialHookSpec,
  ResolvedContribution,
  ResolvedHookPolicy,
  ServiceFactoryContext,
  ServiceFactory,
  ServiceRef,
} from './extension-contracts.ts'
import { assertHookId, assertStableId } from './extension-contracts.ts'
import {
  AsyncExtensionRegistrationError,
  CapabilityNotGrantedError,
  ContributionValidationError,
  DuplicateContributionIdError,
  DuplicateExtensionIdError,
  DuplicateServiceProviderError,
  ExtensionRegistrationError,
  ExtensionResolutionError,
  GraphResolutionError,
  RegistryFrozenError,
  RequirementNotAllowedError,
  UnknownRefError,
} from './extension-errors.ts'
import {
  HookPlanner,
  type PendingHookHandler,
  type RuntimeHookSpec,
  type RuntimeResolvedHookPlan,
  stableTopologicalOrder,
  toRuntimeGuardSpec,
  toRuntimeObserveSpec,
  toRuntimeWaterfallSpec,
} from './hook-planner.ts'
import { freezeImmutableData, ReadonlyMapView } from './immutable-data.ts'

export interface PendingServiceFactory {
  readonly refKey: symbol
  readonly ref: ServiceRef<unknown>
  readonly owner: ExtensionId
  readonly dependencies: readonly ServiceRef<unknown>[]
  create: ServiceFactory<unknown>['create']
}

interface RuntimeContributionSpec {
  readonly refIdentity: object
  readonly refKey: symbol
  readonly id: string
  readonly version: number
  readonly maxPerConflictKey: number | 'many'
  readonly selection: 'single' | 'all' | 'explicit-key'
  readonly ordering: 'none' | 'dependency-edges'
  readonly allowedServices: readonly ServiceRef<unknown>[]
  readonly allowedCapabilities: readonly Capability[]
  decode(value: unknown): {
    readonly value: unknown
    readonly identity: ContributionId
    readonly conflictKey: string
  }
}

interface PendingContribution {
  readonly refKey: symbol
  readonly pointId: string
  readonly id: ContributionId
  readonly owner: ExtensionId
  readonly value: unknown
  readonly conflictKey: string
  readonly requiredServices: readonly ServiceRef<unknown>[]
  readonly requiredCapabilities: readonly Capability[]
  readonly before: readonly ContributionId[]
  readonly after: readonly ContributionId[]
}

interface ExtensionTransaction {
  readonly services: PendingServiceFactory[]
  readonly contributions: PendingContribution[]
  readonly handlers: PendingHookHandler[]
}

export interface ResolvedServicePlan {
  readonly refs: ReadonlyMap<symbol, ServiceRef<unknown>>
  readonly providers: ReadonlyMap<symbol, PendingServiceFactory>
}

export class ResolvedExtensionGraph {
  readonly #contributionPlans: ReadonlyMap<
    symbol,
    readonly ResolvedContribution<unknown>[]
  >
  readonly #contributionRefs: ReadonlyMap<symbol, object>
  readonly #hookPlans: ReadonlyMap<symbol, RuntimeResolvedHookPlan>

  public constructor(
    public readonly generation: string,
    public readonly extensions: ReadonlyMap<ExtensionId, ExtensionDescriptor>,
    public readonly servicePlan: ResolvedServicePlan,
    contributionPlans: ReadonlyMap<
      symbol,
      readonly ResolvedContribution<unknown>[]
    >,
    contributionRefs: ReadonlyMap<symbol, object>,
    hookPlans: ReadonlyMap<symbol, RuntimeResolvedHookPlan>
  ) {
    this.#contributionPlans = new ReadonlyMapView(contributionPlans)
    this.#contributionRefs = new ReadonlyMapView(contributionRefs)
    this.#hookPlans = new ReadonlyMapView(hookPlans)
    Object.freeze(this)
  }

  public contributions<Value>(
    ref: ContributionRef<Value>
  ): readonly ResolvedContribution<Value>[] {
    const values = this.#contributionPlans.get(ref.key)
    if (values === undefined || this.#contributionRefs.get(ref.key) !== ref) {
      throw new UnknownRefError('Contribution', ref.id)
    }
    // Heterogeneous registries erase the type after the Ref/schema pair has
    // been validated. Ref identity restores that relation at this boundary.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return values as readonly ResolvedContribution<Value>[]
  }

  public hookPlan<Input, Output, Mode extends HookMode>(
    ref: HookRef<Input, Output, Mode>
  ): RuntimeResolvedHookPlan {
    const plan = this.#hookPlans.get(ref.key)
    if (plan === undefined || plan.spec.refIdentity !== ref) {
      throw new UnknownRefError('Hook', ref.id)
    }
    return plan
  }
}

export class ExtensionRegistry {
  readonly #generation: string
  readonly #policies: readonly ResolvedHookPolicy[]
  readonly #serviceRefs = new Map<symbol, ServiceRef<unknown>>()
  readonly #serviceIds = new Set<string>()
  readonly #contributionSpecs = new Map<symbol, RuntimeContributionSpec>()
  readonly #contributionPointIds = new Set<string>()
  readonly #hookSpecs = new Map<symbol, RuntimeHookSpec>()
  readonly #hookIds = new Set<string>()
  readonly #extensions = new Map<ExtensionId, ExtensionDescriptor>()
  readonly #services: PendingServiceFactory[] = []
  readonly #contributions: PendingContribution[] = []
  readonly #handlers: PendingHookHandler[] = []
  readonly #contributionSelections: ReadonlyMap<
    string,
    ReadonlyMap<string, string>
  >
  #state: 'mutable' | 'resolving' | 'frozen' | 'failed' = 'mutable'
  #resolved: ResolvedExtensionGraph | null = null

  public constructor(options: {
    readonly generation: string
    readonly policies: readonly ResolvedHookPolicy[]
    readonly contributionSelections?: Readonly<
      Record<string, Readonly<Record<string, string>>>
    >
  }) {
    if (options.generation.trim().length === 0) {
      throw new TypeError('Extension generation must not be empty.')
    }
    this.#generation = options.generation
    this.#policies = Object.freeze(
      options.policies.map((policy) => Object.freeze({ ...policy }))
    )
    this.#contributionSelections = new ReadonlyMapView(
      Object.entries(options.contributionSelections ?? {}).map(
        ([pointId, selections]) =>
          [pointId, new ReadonlyMapView(Object.entries(selections))] as const
      )
    )
  }

  public defineService<Service>(ref: ServiceRef<Service>): void {
    this.#assertMutable()
    assertPortalRef('Service', ref)
    if (this.#serviceRefs.has(ref.key) || this.#serviceIds.has(ref.id)) {
      throw new ExtensionResolutionError(
        `Service ref "${ref.id}" is defined more than once.`
      )
    }
    this.#serviceRefs.set(ref.key, ref)
    this.#serviceIds.add(ref.id)
  }

  public defineContribution<Value>(spec: ContributionSpec<Value>): void {
    this.#assertMutable()
    assertPortalRef('Contribution', spec.ref)
    if (
      this.#contributionSpecs.has(spec.ref.key) ||
      this.#contributionPointIds.has(spec.ref.id)
    ) {
      throw new ExtensionResolutionError(
        `Contribution spec "${spec.ref.id}" is defined more than once.`
      )
    }
    if (
      spec.maxPerConflictKey !== 'many' &&
      (!Number.isInteger(spec.maxPerConflictKey) || spec.maxPerConflictKey < 1)
    ) {
      throw new RangeError(
        `Contribution spec "${spec.ref.id}" has invalid cardinality.`
      )
    }
    if (spec.selection === 'single' && spec.maxPerConflictKey !== 1) {
      throw new RangeError(
        `Contribution spec "${spec.ref.id}" with single selection must have cardinality 1.`
      )
    }
    const parse = spec.schema.parse.bind(spec.schema)
    const identityOf = spec.identityOf.bind(spec)
    const conflictKeyOf = spec.conflictKeyOf.bind(spec)
    const runtime: RuntimeContributionSpec = Object.freeze({
      refIdentity: spec.ref,
      refKey: spec.ref.key,
      id: spec.ref.id,
      version: spec.ref.version,
      maxPerConflictKey: spec.maxPerConflictKey,
      selection: spec.selection,
      ordering: spec.ordering,
      allowedServices: Object.freeze([...spec.allowedServices]),
      allowedCapabilities: Object.freeze([...spec.allowedCapabilities]),
      decode: (raw: unknown) => {
        const value = parse(raw)
        return {
          value,
          identity: identityOf(value),
          conflictKey: conflictKeyOf(value),
        }
      },
    })
    this.#contributionSpecs.set(spec.ref.key, runtime)
    this.#contributionPointIds.add(spec.ref.id)
  }

  public defineHook<Input, Output>(spec: InitialHookSpec<Input, Output>): void {
    this.#assertMutable()
    assertPortalRef('Hook', spec.ref)
    assertPortalRef('Hook policy', spec.policy)
    if (this.#hookSpecs.has(spec.ref.key) || this.#hookIds.has(spec.ref.id)) {
      throw new ExtensionResolutionError(
        `Hook spec "${spec.ref.id}" is defined more than once.`
      )
    }
    let runtime: RuntimeHookSpec
    if ('patchSchema' in spec) {
      runtime = toRuntimeWaterfallSpec(spec)
    } else if ('decisionSchema' in spec) {
      runtime = toRuntimeGuardSpec(spec)
    } else {
      runtime = toRuntimeObserveSpec(spec)
    }
    this.#hookSpecs.set(spec.ref.key, runtime)
    this.#hookIds.add(spec.ref.id)
  }

  public register(
    descriptor: ExtensionDescriptor,
    module: ExtensionModule
  ): void {
    this.#assertMutable()
    validateDescriptor(descriptor)
    if (this.#extensions.has(descriptor.id)) {
      throw new DuplicateExtensionIdError(descriptor.id)
    }
    const frozenDescriptor = freezeDescriptor(descriptor)
    const transaction: ExtensionTransaction = {
      services: [],
      contributions: [],
      handlers: [],
    }
    let active = true
    const ensureActive = () => {
      if (!active) {
        throw new ExtensionRegistrationError(
          descriptor.id,
          'registration API is no longer active.'
        )
      }
    }
    const api: ExtensionRegistrationApi = {
      provide: <Service>(
        ref: ServiceRef<Service>,
        factory: ServiceFactory<Service>
      ) => {
        ensureActive()
        const known = this.#serviceRefs.get(ref.key)
        if (known === undefined || known !== ref) {
          throw new UnknownRefError('Service', ref.id)
        }
        const create = factory.create.bind(factory)
        transaction.services.push(
          Object.freeze({
            refKey: ref.key,
            ref: known,
            owner: descriptor.id,
            dependencies: Object.freeze([...factory.dependencies]),
            create: async (context: ServiceFactoryContext) =>
              await create(context),
          })
        )
      },
      contribute: <Value>(
        ref: ContributionRef<Value>,
        registration: ContributionRegistration<Value>
      ) => {
        ensureActive()
        const spec = this.#contributionSpecs.get(ref.key)
        if (spec === undefined || spec.refIdentity !== ref) {
          throw new UnknownRefError('Contribution', ref.id)
        }
        let decoded: ReturnType<RuntimeContributionSpec['decode']>
        try {
          decoded = spec.decode(registration.value)
        } catch (error) {
          throw new ContributionValidationError(
            registration.id,
            'schema or identity evaluation failed.',
            error
          )
        }
        const { value, identity, conflictKey } = decoded
        assertStableId('Contribution', registration.id)
        if (identity !== registration.id) {
          throw new ContributionValidationError(
            registration.id,
            `schema identity "${identity}" does not match registration ID.`
          )
        }
        if (conflictKey.trim().length === 0) {
          throw new ContributionValidationError(
            registration.id,
            'conflict key must not be empty.'
          )
        }
        transaction.contributions.push({
          refKey: ref.key,
          pointId: ref.id,
          id: registration.id,
          owner: descriptor.id,
          value: freezeImmutableData(value),
          conflictKey,
          requiredServices: Object.freeze([...registration.requiredServices]),
          requiredCapabilities: Object.freeze([
            ...registration.requiredCapabilities,
          ]),
          before: Object.freeze([...(registration.before ?? [])]),
          after: Object.freeze([...(registration.after ?? [])]),
        })
      },
      handle: <Input, Output, Mode extends HookMode>(
        ref: HookRef<Input, Output, Mode>,
        registration: HookHandlerRegistration<Input, Output>
      ) => {
        ensureActive()
        const spec = this.#hookSpecs.get(ref.key)
        if (
          spec === undefined ||
          spec.refIdentity !== ref ||
          spec.mode !== ref.mode
        ) {
          throw new UnknownRefError('Hook', ref.id)
        }
        assertStableId('Handler', registration.id)
        const handler = registration.handler
        transaction.handlers.push({
          refKey: ref.key,
          hookId: ref.id,
          id: registration.id,
          owner: descriptor.id,
          requiredServices: Object.freeze([...registration.requiredServices]),
          requiredCapabilities: Object.freeze([
            ...registration.requiredCapabilities,
          ]),
          before: Object.freeze([...(registration.before ?? [])]),
          after: Object.freeze([...(registration.after ?? [])]),
          invoke: async (input, context) =>
            await handler(
              // HookRunner validates and freezes input before this erased boundary.
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
              input as Input,
              context
            ),
        })
      },
    }

    try {
      const result = module.register(api)
      active = false
      if (isThenable(result)) {
        void Promise.resolve(result).catch(() => undefined)
        throw new AsyncExtensionRegistrationError(descriptor.id)
      }
    } catch (error) {
      active = false
      if (error instanceof ExtensionRegistrationError) throw error
      throw new ExtensionRegistrationError(
        descriptor.id,
        'register() threw an error.',
        error
      )
    }

    this.#extensions.set(descriptor.id, frozenDescriptor)
    this.#services.push(...transaction.services)
    this.#contributions.push(...transaction.contributions)
    this.#handlers.push(...transaction.handlers)
  }

  public freeze(): ResolvedExtensionGraph {
    if (this.#state === 'frozen') return this.#resolved!
    this.#assertMutable()
    this.#state = 'resolving'
    try {
      validateExtensionGraph(this.#extensions)
      this.#validateContributionSelectionPoints()
      const servicePlan = this.#resolveServices()
      this.#validateDefinitionServiceRefs()
      this.#validateKnownServiceRequirements(servicePlan)
      validateGlobalHandlerIds(this.#handlers)
      const contributionPlans = this.#resolveContributions()
      const planner = new HookPlanner(this.#policies)
      const hookPlans = planner.resolve(
        this.#generation,
        [...this.#hookSpecs.values()],
        this.#handlers,
        this.#extensions
      )
      const resolved = new ResolvedExtensionGraph(
        this.#generation,
        new ReadonlyMapView(this.#extensions),
        servicePlan,
        contributionPlans,
        new Map(
          [...this.#contributionSpecs.values()].map((spec) => [
            spec.refKey,
            spec.refIdentity,
          ])
        ),
        hookPlans
      )
      this.#resolved = resolved
      this.#state = 'frozen'
      return resolved
    } catch (error) {
      this.#state = 'failed'
      throw error
    }
  }

  #resolveServices(): ResolvedServicePlan {
    const providers = new Map<symbol, PendingServiceFactory>()
    for (const service of this.#services) {
      if (providers.has(service.refKey)) {
        throw new DuplicateServiceProviderError(service.ref.id)
      }
      providers.set(service.refKey, service)
    }
    for (const service of this.#services) {
      for (const dependency of service.dependencies) {
        const known = this.#serviceRefs.get(dependency.key)
        if (known === undefined || known !== dependency) {
          throw new UnknownRefError('Service', dependency.id)
        }
        if (!providers.has(dependency.key)) {
          throw new ExtensionResolutionError(
            `Service "${service.ref.id}" requires missing provider "${dependency.id}".`
          )
        }
        if (!canDependOnScope(service.ref.scope, dependency.scope)) {
          throw new ExtensionResolutionError(
            `Service "${service.ref.id}" at ${service.ref.scope} scope cannot depend on ${dependency.scope}-scoped service "${dependency.id}".`
          )
        }
      }
    }
    validateServiceCycles(this.#services)
    return Object.freeze({
      refs: new ReadonlyMapView(this.#serviceRefs),
      providers: new ReadonlyMapView(providers),
    })
  }

  #validateKnownServiceRequirements(servicePlan: ResolvedServicePlan): void {
    const all = [
      ...this.#contributions.map((item) => ({
        owner: item.owner,
        target: `Contribution "${item.id}"`,
        services: item.requiredServices,
      })),
      ...this.#handlers.map((item) => ({
        owner: item.owner,
        target: `Handler "${item.id}"`,
        services: item.requiredServices,
      })),
    ]
    for (const item of all) {
      for (const service of item.services) {
        const known = this.#serviceRefs.get(service.key)
        if (known === undefined || known !== service) {
          throw new UnknownRefError('Service', service.id)
        }
        if (!servicePlan.providers.has(service.key)) {
          throw new ExtensionResolutionError(
            `${item.target} requires Service "${service.id}", but no provider is registered.`
          )
        }
      }
    }
  }

  #validateDefinitionServiceRefs(): void {
    const requirements = [
      ...[...this.#contributionSpecs.values()].flatMap((spec) =>
        spec.allowedServices.map((service) => ({
          service,
          target: `Contribution point "${spec.id}"`,
        }))
      ),
      ...[...this.#hookSpecs.values()].flatMap((spec) =>
        spec.allowedServices.map((service) => ({
          service,
          target: `Hook "${spec.id}"`,
        }))
      ),
    ]
    for (const { service, target } of requirements) {
      const known = this.#serviceRefs.get(service.key)
      if (known === undefined || known !== service) {
        throw new ExtensionResolutionError(
          `${target} allows unknown Service "${service.id}".`
        )
      }
    }
  }

  #resolveContributions(): ReadonlyMap<
    symbol,
    readonly ResolvedContribution<unknown>[]
  > {
    const plans = new Map<symbol, readonly ResolvedContribution<unknown>[]>()
    const globalIds = new Set<string>()
    for (const contribution of this.#contributions) {
      if (globalIds.has(contribution.id)) {
        throw new DuplicateContributionIdError(contribution.id)
      }
      globalIds.add(contribution.id)
    }
    for (const spec of this.#contributionSpecs.values()) {
      const items = this.#contributions.filter(
        (item) => item.refKey === spec.refKey
      )
      validateContributionRequirements(spec, items, this.#extensions)
      validateContributionCardinality(spec, items)
      if (
        spec.ordering === 'none' &&
        items.some((item) => item.before.length > 0 || item.after.length > 0)
      ) {
        throw new ExtensionResolutionError(
          `Contribution point "${spec.id}" does not allow ordering edges.`
        )
      }
      const eligible = resolveContributionSelection(
        spec,
        items,
        this.#contributionSelections.get(spec.id)
      )
      const ordered =
        spec.ordering === 'dependency-edges'
          ? stableTopologicalOrder(
              `Contribution ${spec.id}`,
              eligible,
              this.#extensions
            )
          : [...eligible].sort(
              (left, right) =>
                compareAscii(left.owner, right.owner) ||
                compareAscii(left.id, right.id)
            )
      plans.set(
        spec.refKey,
        Object.freeze(
          ordered.map((item, resolvedIndex) =>
            Object.freeze({
              id: item.id,
              owner: item.owner,
              value: item.value,
              requiredServices: item.requiredServices,
              requiredCapabilities: item.requiredCapabilities,
              resolvedIndex,
            })
          )
        )
      )
    }
    return plans
  }

  #validateContributionSelectionPoints(): void {
    const specsById = new Map(
      [...this.#contributionSpecs.values()].map((spec) => [spec.id, spec])
    )
    for (const pointId of this.#contributionSelections.keys()) {
      const spec = specsById.get(pointId)
      if (spec === undefined) {
        throw new ExtensionResolutionError(
          `Explicit selection targets unknown contribution point "${pointId}".`
        )
      }
      if (spec.selection !== 'explicit-key') {
        throw new ExtensionResolutionError(
          `Contribution point "${pointId}" does not accept explicit selections.`
        )
      }
    }
  }

  #assertMutable(): void {
    if (this.#state === 'frozen' || this.#state === 'resolving') {
      throw new RegistryFrozenError()
    }
    if (this.#state === 'failed') {
      throw new ExtensionResolutionError(
        'The extension registry failed resolution and cannot be reused.'
      )
    }
  }
}

function validateDescriptor(descriptor: ExtensionDescriptor): void {
  assertStableId('Extension', descriptor.id)
  if (descriptor.version.trim().length === 0) {
    throw new TypeError('Extension version must not be empty.')
  }
  if (
    new Set(descriptor.dependencies).size !== descriptor.dependencies.length
  ) {
    throw new ExtensionResolutionError(
      `Extension "${descriptor.id}" repeats a dependency.`
    )
  }
  if (
    new Set(descriptor.capabilities).size !== descriptor.capabilities.length
  ) {
    throw new ExtensionResolutionError(
      `Extension "${descriptor.id}" repeats a capability grant.`
    )
  }
  for (const dependency of descriptor.dependencies) {
    assertStableId('Extension dependency', dependency)
    if (dependency === descriptor.id) {
      throw new ExtensionResolutionError(
        `Extension "${descriptor.id}" cannot depend on itself.`
      )
    }
  }
  for (const capability of descriptor.capabilities) {
    assertStableId('Capability', capability)
  }
}

function freezeDescriptor(
  descriptor: ExtensionDescriptor
): ExtensionDescriptor {
  return Object.freeze({
    id: descriptor.id,
    version: descriptor.version,
    dependencies: Object.freeze([...descriptor.dependencies]),
    capabilities: Object.freeze([...descriptor.capabilities]),
  })
}

function validateExtensionGraph(
  extensions: ReadonlyMap<ExtensionId, ExtensionDescriptor>
): void {
  const items = [...extensions.values()].map((extension) => ({
    id: extension.id,
    owner: extension.id,
    before: [] as string[],
    after: extension.dependencies,
  }))
  for (const extension of extensions.values()) {
    for (const dependency of extension.dependencies) {
      if (!extensions.has(dependency)) {
        throw new GraphResolutionError(
          'Extension',
          `Extension "${extension.id}" requires missing dependency "${dependency}".`
        )
      }
    }
  }
  stableTopologicalOrder('Extension', items, extensions)
}

function validateContributionRequirements(
  spec: RuntimeContributionSpec,
  items: readonly PendingContribution[],
  extensions: ReadonlyMap<ExtensionId, ExtensionDescriptor>
): void {
  const allowedServices = new Set(spec.allowedServices.map((item) => item.key))
  const allowedCapabilities = new Set(spec.allowedCapabilities)
  for (const item of items) {
    const extension = extensions.get(item.owner)!
    const granted = new Set(extension.capabilities)
    for (const service of item.requiredServices) {
      if (!allowedServices.has(service.key)) {
        throw new RequirementNotAllowedError(
          item.owner,
          `Service "${service.id}"`,
          `Contribution point "${spec.id}"`
        )
      }
    }
    for (const capability of item.requiredCapabilities) {
      if (!allowedCapabilities.has(capability)) {
        throw new RequirementNotAllowedError(
          item.owner,
          `capability "${capability}"`,
          `Contribution point "${spec.id}"`
        )
      }
      if (!granted.has(capability)) {
        throw new CapabilityNotGrantedError(item.owner, capability)
      }
    }
  }
}

function validateContributionCardinality(
  spec: RuntimeContributionSpec,
  items: readonly PendingContribution[]
): void {
  if (spec.maxPerConflictKey === 'many') return
  const counts = new Map<string, number>()
  for (const item of items) {
    const count = (counts.get(item.conflictKey) ?? 0) + 1
    counts.set(item.conflictKey, count)
    if (count > spec.maxPerConflictKey) {
      throw new ExtensionResolutionError(
        `Contribution point "${spec.id}" conflict key "${item.conflictKey}" exceeds cardinality ${spec.maxPerConflictKey}.`
      )
    }
  }
}

function resolveContributionSelection(
  spec: RuntimeContributionSpec,
  items: readonly PendingContribution[],
  selections: ReadonlyMap<string, string> | undefined
): readonly PendingContribution[] {
  if (spec.selection !== 'explicit-key') return items
  const byConflictKey = new Map<string, PendingContribution[]>()
  for (const item of items) {
    const group = byConflictKey.get(item.conflictKey) ?? []
    group.push(item)
    byConflictKey.set(item.conflictKey, group)
  }
  if (selections === undefined) {
    if (byConflictKey.size === 0) return []
    throw new ExtensionResolutionError(
      `Contribution point "${spec.id}" requires explicit selections.`
    )
  }
  for (const key of selections.keys()) {
    if (!byConflictKey.has(key)) {
      throw new ExtensionResolutionError(
        `Contribution point "${spec.id}" selects unknown conflict key "${key}".`
      )
    }
  }
  if (byConflictKey.size === 0) return []
  const selected: PendingContribution[] = []
  for (const [conflictKey, candidates] of byConflictKey) {
    const selectedId = selections.get(conflictKey)
    const candidate = candidates.find((item) => item.id === selectedId)
    if (candidate === undefined) {
      throw new ExtensionResolutionError(
        `Contribution point "${spec.id}" requires a valid selection for conflict key "${conflictKey}".`
      )
    }
    selected.push(candidate)
  }
  return selected
}

function validateServiceCycles(
  services: readonly PendingServiceFactory[]
): void {
  const byKey = new Map(services.map((service) => [service.refKey, service]))
  const visiting = new Set<symbol>()
  const visited = new Set<symbol>()
  const visit = (service: PendingServiceFactory) => {
    if (visiting.has(service.refKey)) {
      throw new GraphResolutionError(
        'Service',
        `cycle detected at "${service.ref.id}".`
      )
    }
    if (visited.has(service.refKey)) return
    visiting.add(service.refKey)
    for (const dependency of service.dependencies) {
      const provider = byKey.get(dependency.key)
      if (provider !== undefined) visit(provider)
    }
    visiting.delete(service.refKey)
    visited.add(service.refKey)
  }
  for (const service of services) visit(service)
}

function validateGlobalHandlerIds(
  handlers: readonly PendingHookHandler[]
): void {
  const ids = new Set<string>()
  for (const handler of handlers) {
    if (ids.has(handler.id)) {
      throw new ExtensionResolutionError(
        `Handler ID "${handler.id}" is registered more than once globally.`
      )
    }
    ids.add(handler.id)
  }
}

function canDependOnScope(
  consumer: ServiceRef<unknown>['scope'],
  dependency: ServiceRef<unknown>['scope']
): boolean {
  if (consumer === dependency) return true
  const parents: Readonly<
    Record<ServiceRef<unknown>['scope'], readonly string[]>
  > = {
    portal: [],
    session: ['portal'],
    surface: ['session', 'portal'],
    browser: ['session', 'portal'],
    context: ['browser', 'session', 'portal'],
    page: ['context', 'browser', 'session', 'portal'],
    command: ['session', 'portal'],
    thread: ['session', 'portal'],
    'provider-session': ['thread', 'session', 'portal'],
    runtime: ['thread', 'session', 'portal'],
    turn: ['runtime', 'thread', 'session', 'portal'],
    tool: ['turn', 'runtime', 'thread', 'session', 'portal'],
    // Every supported attachment initiator is below session, while its exact
    // command/runtime/turn/tool parent is dynamic.
    attachment: ['session', 'portal'],
    spawn: ['tool', 'turn', 'runtime', 'thread', 'session', 'portal'],
  }
  return parents[consumer].includes(dependency)
}

function isThenable(value: unknown): boolean {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return false
  }
  return typeof Reflect.get(value, 'then') === 'function'
}

function assertPortalRef(
  kind: string,
  ref: { readonly key: symbol; readonly id: string; readonly version?: number }
): void {
  if (!Object.isFrozen(ref) || typeof ref.key !== 'symbol') {
    throw new TypeError(`${kind} refs must be created and frozen by Portal.`)
  }
  if (kind === 'Hook') {
    assertHookId(ref.id)
  } else {
    assertStableId(kind, ref.id)
  }
  if (
    ref.version !== undefined &&
    (!Number.isInteger(ref.version) || ref.version < 1)
  ) {
    throw new RangeError(`${kind} ref version must be a positive integer.`)
  }
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
