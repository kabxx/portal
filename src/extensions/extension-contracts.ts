import type {
  ResourceDisposer,
  ResourceRegistration,
} from '../shared/resource-scope.ts'

export type ExtensionId = string
export type ContributionPointId = string
export type ContributionId = string
export type HandlerId = string
export type ServiceId = string
export type HookId = string
export type HookPolicyId = string
export type Capability = string

export type ResourceScopeKind =
  | 'portal'
  | 'session'
  | 'surface'
  | 'browser'
  | 'context'
  | 'page'
  | 'command'
  | 'thread'
  | 'provider-session'
  | 'runtime'
  | 'turn'
  | 'tool'
  | 'attachment'
  | 'spawn'

export type HookMode = 'observe' | 'waterfall' | 'guard'
export type HookErrorPolicy = 'fail-fast' | 'isolate' | 'deny' | 'aggregate'

export interface RuntimeSchema<Value> {
  parse(value: unknown): Value
}

export type ScopedResourceFactory<Resource> = (
  signal: AbortSignal
) => Resource | Promise<Resource>

export type ScopedResourceDisposer<Resource> = (
  resource: Resource,
  context: { readonly reason: unknown; readonly signal: AbortSignal }
) => void | Promise<void>

export interface ResourceScopeRegistration {
  readonly kind: ResourceScopeKind
  readonly signal: AbortSignal
  defer(label: string, disposer: ResourceDisposer): ResourceRegistration
  acquire<Resource>(
    label: string,
    factory: ScopedResourceFactory<Resource>,
    disposer: ScopedResourceDisposer<Resource>
  ): Promise<Resource>
}

export interface ServiceRef<Service> {
  readonly key: symbol
  readonly id: ServiceId
  readonly version: number
  readonly scope: ResourceScopeKind
  readonly __service?: Service
}

export interface ContributionRef<Value> {
  readonly key: symbol
  readonly id: ContributionPointId
  readonly version: number
  readonly __value?: Value
}

export interface HookRef<Input, Output, Mode extends HookMode = HookMode> {
  readonly key: symbol
  readonly id: HookId
  readonly version: number
  readonly mode: Mode
  readonly __types?: (input: Input) => Output
}

export interface HookPolicyRef {
  readonly key: symbol
  readonly id: HookPolicyId
}

export interface ResolvedHookPolicy {
  readonly ref: HookPolicyRef
  readonly dispatch: 'serial' | 'parallel'
  readonly handlerTimeoutMs: number
  readonly errorPolicy: HookErrorPolicy
  readonly rollback: 'none' | 'operation-scope' | 'resource-scope'
  readonly trackLateSettlement: boolean
}

export type Decision =
  | { readonly kind: 'allow' }
  | {
      readonly kind: 'deny'
      readonly code: string
      readonly message: string
    }

export interface HookTraceRedaction {
  readonly input?: unknown
  readonly output?: unknown
}

export type HookTraceRedactor<Input, Output> = (
  input: Readonly<Input>,
  output: Output | undefined
) => HookTraceRedaction

export interface HookSpecBase<Input, Output, Mode extends HookMode> {
  readonly ref: HookRef<Input, Output, Mode>
  readonly scope: ResourceScopeKind
  readonly scopeAccess: 'active' | 'terminal'
  readonly inputSchema: RuntimeSchema<Input>
  readonly policy: HookPolicyRef
  readonly allowedServices: readonly ServiceRef<unknown>[]
  readonly allowedCapabilities: readonly Capability[]
  readonly redact: HookTraceRedactor<Input, Output>
  readonly stability: 'experimental' | 'stable'
}

export interface ObserveHookSpec<Input> extends HookSpecBase<
  Input,
  void,
  'observe'
> {
  readonly ref: HookRef<Input, void, 'observe'>
}

export interface WaterfallHookSpec<Input, Patch> extends HookSpecBase<
  Input,
  Patch,
  'waterfall'
> {
  readonly ref: HookRef<Input, Patch, 'waterfall'>
  readonly patchSchema: RuntimeSchema<Patch>
  readonly applyPatch: (current: Readonly<Input>, patch: Patch) => Input
}

export interface GuardHookSpec<Input> extends HookSpecBase<
  Input,
  Decision,
  'guard'
> {
  readonly ref: HookRef<Input, Decision, 'guard'>
  readonly decisionSchema: RuntimeSchema<Decision>
}

export type InitialHookSpec<Input, Output> =
  | ObserveHookSpec<Input>
  | WaterfallHookSpec<Input, Output>
  | GuardHookSpec<Input>

export interface ContributionSpec<Value> {
  readonly ref: ContributionRef<Value>
  readonly schema: RuntimeSchema<Value>
  readonly identityOf: (value: Value) => ContributionId
  readonly conflictKeyOf: (value: Value) => string
  readonly maxPerConflictKey: number | 'many'
  readonly selection: 'single' | 'all' | 'explicit-key'
  readonly ordering: 'none' | 'dependency-edges'
  readonly allowedServices: readonly ServiceRef<unknown>[]
  readonly allowedCapabilities: readonly Capability[]
}

export interface ContributionRegistration<Value> {
  readonly id: ContributionId
  readonly value: Value
  readonly requiredServices: readonly ServiceRef<unknown>[]
  readonly requiredCapabilities: readonly Capability[]
  readonly before?: readonly ContributionId[]
  readonly after?: readonly ContributionId[]
}

export interface ServiceAccessor {
  get<Service>(ref: ServiceRef<Service>): Promise<Service>
}

export interface ServiceFactory<Service> {
  readonly dependencies: readonly ServiceRef<unknown>[]
  create(context: ServiceFactoryContext): Promise<Service>
}

export interface ServiceFactoryContext {
  readonly services: ServiceAccessor
  readonly scope: ResourceScopeRegistration
  readonly signal: AbortSignal
  readonly deadline: number
}

export interface ExtensionDescriptor {
  readonly id: ExtensionId
  readonly version: string
  readonly dependencies: readonly ExtensionId[]
  readonly capabilities: readonly Capability[]
}

export interface ExtensionRegistrationApi {
  provide<Service>(
    ref: ServiceRef<Service>,
    factory: ServiceFactory<Service>
  ): void
  contribute<Value>(
    ref: ContributionRef<Value>,
    registration: ContributionRegistration<Value>
  ): void
  handle<Input, Output, Mode extends HookMode>(
    ref: HookRef<Input, Output, Mode>,
    registration: HookHandlerRegistration<Input, Output>
  ): void
}

export interface ExtensionModule {
  register(api: ExtensionRegistrationApi): unknown
}

export interface HookInvocationContextBase {
  readonly extensionId: ExtensionId
  readonly generation: string
  readonly signal: AbortSignal
  readonly deadline: number
  readonly traceId: string
}

export interface ActiveHookInvocationContext extends HookInvocationContextBase {
  readonly scopeAccess: 'active'
  readonly scope: ResourceScopeRegistration
  readonly services: ServiceAccessor
}

export interface TerminalScopeView {
  readonly kind: ResourceScopeKind
  readonly resourceId: string
  readonly closedAt: number
}

export interface TerminalHookInvocationContext extends HookInvocationContextBase {
  readonly scopeAccess: 'terminal'
  readonly scope: TerminalScopeView
}

export type HookInvocationContext =
  ActiveHookInvocationContext | TerminalHookInvocationContext

export type HookHandler<Input, Output> = (
  input: Readonly<Input>,
  context: HookInvocationContext
) => Promise<Output>

export interface HookHandlerRegistration<Input, Output> {
  readonly id: HandlerId
  readonly handler: HookHandler<Input, Output>
  readonly requiredServices: readonly ServiceRef<unknown>[]
  readonly requiredCapabilities: readonly Capability[]
  readonly before?: readonly HandlerId[]
  readonly after?: readonly HandlerId[]
}

export interface ResolvedHookHandler<Input, Output> {
  readonly id: HandlerId
  readonly owner: ExtensionId
  readonly handler: HookHandler<Input, Output>
  readonly requiredServices: readonly ServiceRef<unknown>[]
  readonly requiredCapabilities: readonly Capability[]
  readonly resolvedIndex: number
}

export interface ResolvedObservePlan<Input> {
  readonly mode: 'observe'
  readonly generation: string
  readonly spec: ObserveHookSpec<Input>
  readonly policy: ResolvedHookPolicy
  readonly handlers: readonly ResolvedHookHandler<Input, void>[]
}

export interface ResolvedWaterfallPlan<Input, Patch> {
  readonly mode: 'waterfall'
  readonly generation: string
  readonly spec: WaterfallHookSpec<Input, Patch>
  readonly policy: ResolvedHookPolicy
  readonly handlers: readonly ResolvedHookHandler<Input, Patch>[]
}

export interface ResolvedGuardPlan<Input> {
  readonly mode: 'guard'
  readonly generation: string
  readonly spec: GuardHookSpec<Input>
  readonly policy: ResolvedHookPolicy
  readonly handlers: readonly ResolvedHookHandler<Input, Decision>[]
}

export type ResolvedHookPlan<Input, Output> =
  | ResolvedObservePlan<Input>
  | ResolvedWaterfallPlan<Input, Output>
  | ResolvedGuardPlan<Input>

export interface ResolvedContribution<Value> {
  readonly id: ContributionId
  readonly owner: ExtensionId
  readonly value: Value
  readonly requiredServices: readonly ServiceRef<unknown>[]
  readonly requiredCapabilities: readonly Capability[]
  readonly resolvedIndex: number
}

export type HookTraceEventKind =
  | 'hook.started'
  | 'hook.completed'
  | 'hook.failed'
  | 'handler.started'
  | 'handler.completed'
  | 'handler.denied'
  | 'handler.failed'
  | 'handler.timedOut'
  | 'handler.skipped'
  | 'handler.lateSettled'

export interface HookTraceEvent {
  readonly kind: HookTraceEventKind
  readonly traceId: string
  readonly generation: string
  readonly hookId: HookId
  readonly hookVersion: number
  readonly timestamp: number
  readonly handlerId?: HandlerId
  readonly extensionId?: ExtensionId
  readonly resolvedIndex?: number
  readonly resultCategory?: string
  readonly data?: HookTraceRedaction
}

export type HookTraceSink = (event: HookTraceEvent) => void

export interface HookTimerHandle {
  cancel(): void
}

export interface HookRuntimeClock {
  now(): number
  setTimer(delayMs: number, callback: () => void): HookTimerHandle
}

export interface ActiveHookInvocationOptions {
  readonly scopeAccess: 'active'
  readonly scope: import('./scope-registration.ts').ExtensionResourceScope
  readonly signal?: AbortSignal
  readonly deadline?: number
  readonly traceId?: string
}

export interface TerminalHookInvocationOptions {
  readonly scopeAccess: 'terminal'
  readonly scope: TerminalScopeView
  readonly signal?: AbortSignal
  readonly deadline?: number
  readonly traceId?: string
}

export type HookInvocationOptions =
  ActiveHookInvocationOptions | TerminalHookInvocationOptions

export function createServiceRef<Service>(options: {
  readonly id: ServiceId
  readonly version: number
  readonly scope: ResourceScopeKind
}): ServiceRef<Service> {
  assertVersion(options.version)
  return Object.freeze({
    key: Symbol(options.id),
    id: assertStableId('Service', options.id),
    version: options.version,
    scope: options.scope,
  })
}

export function createContributionRef<Value>(options: {
  readonly id: ContributionPointId
  readonly version: number
}): ContributionRef<Value> {
  assertVersion(options.version)
  return Object.freeze({
    key: Symbol(options.id),
    id: assertStableId('Contribution point', options.id),
    version: options.version,
  })
}

export function createHookRef<Input, Output, Mode extends HookMode>(options: {
  readonly id: HookId
  readonly version: number
  readonly mode: Mode
}): HookRef<Input, Output, Mode> {
  assertVersion(options.version)
  return Object.freeze({
    key: Symbol(options.id),
    id: assertHookId(options.id),
    version: options.version,
    mode: options.mode,
  })
}

export function createHookPolicyRef(id: HookPolicyId): HookPolicyRef {
  return Object.freeze({
    key: Symbol(id),
    id: assertStableId('Hook policy', id),
  })
}

export function assertStableId(kind: string, id: string): string {
  if (!/^[a-z0-9][a-z0-9._:/-]*$/.test(id)) {
    throw new TypeError(
      `${kind} ID must use lowercase letters, numbers, dots, colons, slashes, or hyphens.`
    )
  }
  return id
}

export function assertHookId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id)) {
    throw new TypeError(
      'Hook ID must use ASCII letters, numbers, dots, colons, slashes, or hyphens.'
    )
  }
  return id
}

function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new RangeError('API version must be a positive integer.')
  }
}
