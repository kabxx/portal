# Hook-first architecture

[Back to README](../../README.md)

Status: accepted for the `next/hook-first` development line. This document is
the implementation contract for replacing Portal's former conversation-only
Hook feature with a host-owned extension architecture. The branch is not a
compatibility line and must not publish a partially implemented public API.

## Goal

Every stable product boundary should be observable or extensible without
turning ordinary control flow into events. Portal owns the lifecycle, ordering,
resource, validation, and security semantics. Extensions implement declared
handlers and contributions.

The guiding rule is:

> Product capabilities are contributions. Safety and consistency invariants
> belong to the kernel.

This does not mean that every function call is a Hook. Login waiting, thread
provisioning, message submission, retries, cancellation, and shutdown remain
explicit state machines with one owner. Hook points surround stable domain
transitions; they do not become the transition engine.

## Terms

- A **Plugin package** is the user-facing name for an **Extension package**. It
  is the installation, identity, version, dependency, trust, configuration,
  state, activation, and disposal unit. One package normally contributes many
  independently validated capabilities.
- A **ContributionRef** is an opaque typed registration point owned by Portal.
  Its ContributionSpec defines value schema, identity and conflict keys,
  cardinality, compatibility, and required services.
- A **HookRef** is an opaque, typed reference exported by Portal. Extensions do
  not create global Hook names by writing arbitrary strings.
- A **HookSpec** defines one Hook's input, output, mode, execution policy,
  scope, deadline, failure policy, capabilities, redaction, and stability.
- A **Handler** implements one HookSpec and belongs to one Extension package.
- A **Contribution** is one immutable, namespaced, registration-time capability
  such as a Command, Provider transport, attachment strategy, Prompt section,
  Tool, Skill, Presenter, or Surface.
- A **ServiceRef** identifies one narrow host capability. Extensions receive
  only the ServiceRefs declared by their contributions; they do not receive a
  general-purpose Portal context.
- A **Surface** is a first-party or trusted entry experience such as the TUI,
  batch exec, or MCP listener. A Surface requests operations from PortalHost;
  it does not own kernel admission, authentication, or shutdown.
- A **ResourceScope** owns resources created for a Portal, session, browser,
  context, Page lease, Surface, thread, Provider session, runtime, turn,
  attachment, Command, or Tool operation.
- A **SafetyFinalizer** is kernel code that runs after extension transforms and
  cannot be replaced, reordered, or skipped by an extension.

The package boundary and contribution boundary deliberately differ. A complete
Provider may ship as one package while registering a descriptor, transport,
model controller, attachment strategies, capability controllers, history
reader, and diagnostics independently. Disabling or replacing one contribution
does not require inventing a second package, and installing one package does
not give all of its contributions an undifferentiated API.

## Contribution granularity

Portal splits a capability into a separate contribution when at least one of
these properties differs:

- it is optional for some implementations;
- it has a distinct conflict key or can be replaced independently;
- it requires different permissions, configuration, or trust;
- it has a different lifecycle or resource owner;
- it has independent consumers, such as a Command and Tool using the same
  attachment service;
- it needs its own schema, compatibility version, diagnostics, or tests.

Portal does not split private selectors, protocol parsing helpers, response
arbitration, state-machine steps, or every interface method into public
contributions. Those details remain inside the contribution that owns them.
Fine-grained registration must make composition explicit without hiding normal
control flow in a runtime graph.

Every contribution has a fully qualified ID, owner package, schema version,
required ServiceRefs, capabilities, optional configuration key, and explicit
conflict policy. The resolved contribution graph is immutable for one Portal
generation. Built-ins and external extensions use the same graph; first-party
code may receive private ServiceRefs, but it has no hidden registry.

Contributions and Hooks use different runtimes. An Extension synchronously
calls `registration.contribute(ref, registration)` while the graph is mutable.
Portal validates and freezes the typed registration without invoking
HookRunner. HookRef is only for runtime lifecycle and operation handlers.
Returning a Promise or thenable from `ExtensionModule.register()` is a
registration error, including for JavaScript callers that bypass TypeScript.

## Current implementation status

On `next/hook-first`, the former conversation Hook product has been removed,
ResourceScope is implemented, and TUI plus exec share one PortalHost lifecycle.
The internal Extension, Contribution, Service, and Hook registries now resolve
and freeze one typed generation. HookPlanner and HookRunner implement observe,
waterfall, and guard policies, and PortalHost invokes `portal.beforeStart`,
`portal.ready`, `portal.beforeStop`, and terminal `portal.stopped` through that
production Kernel. The first complete vertical slice is also in place:
`portal.commands` contributes every in-session built-in through
`commands.collect`, and one resolved Command plan owns parsing, execution,
help, hints, completion, admission, and diagnostics. Command Handlers receive
only their declared ServiceRefs and capabilities; the former mutable command
context and static command registry have been removed.

SurfaceRegistry, Provider facet registries, manifest loading, and the external
SDK do not exist yet. The TUI is currently a hand-written composition root with
a separable Host boundary; it is not yet the `portal.tui` Surface extension.
Exec and MCP are not yet resolved Surface extensions either. The delivery
contract below defines when Portal may claim that first-party capabilities are
plugin-based.

## Host lifecycle

The host follows one state machine:

```text
constructed
  -> registering
  -> resolved
  -> starting
  -> ready
  -> stopping
  -> stopped
```

Registration is synchronous and declarative. It may not perform I/O. The host
validates the complete extension graph and atomically freezes it at `resolved`.
Browser, database, process, network, and UI resources may be created only after
resolution. No extension or Handler is added to a running generation.

TUI, `portal exec`, and the MCP Server use the same PortalHost composition. A
resolved ActivationPlan describes the session intent and Surfaces to activate;
hard-coded `tui` or `exec` profiles are only a migration detail and are not a
public plugin identity or API.

## Resource tree

```text
portal root
├── extension activation scopes
└── portal core resources
    └── session
        ├── surface
        ├── browser
        │   └── context
        │       └── page lease
        ├── command
        └── thread
            ├── provider session (holds a page lease)
            └── runtime
                └── turn
                    └── tool
```

PageScope is physically owned by the Browser tree; ProviderSession owns only a
releasable lease and never becomes a second Page owner. Attachment is a bounded
operation scope attached to its actual initiator, which may be Runtime setup, a
Command, a turn, or a Tool. It is not always a child of a turn.

The contribution graph is portal-wide and immutable after resolution. This
architecture line has no runtime scoped contribution overlays. A child scope
receives an authorized immutable service/context view derived from its parent;
it cannot register local contributions. Every activation, Service factory, or
runtime Handler that creates a listener, timer, page, process, transport, or
other resource binds a Disposable to its ResourceScope.

Scope disposal is idempotent, asynchronous, deadline-bound, and reverse-order.
One failing disposer does not prevent the remaining disposers from running.
Startup activation occurs in a temporary child scope: success commits the
scope, while failure rolls it back. Cleanup errors are aggregated without
discarding the original operation error.

`beforeClose` and `beforeStop` run after admission closes but while the target
resource and its authorized services are still available. The owner then
disposes the target scope. `closed` and `stopped` run while the parent and
Handler-owner activation scopes still exist, receive only an immutable terminal
snapshot, and cannot resolve the disposed target's services. The owner closes
remaining Handler activation scopes after the final terminal notification.

Portal shutdown therefore has one fixed outer order:

```text
close admission
-> portal.beforeStop
-> dispose sessions and portal core resources
-> portal.stopped with a terminal DTO
-> dispose extension activation scopes
-> dispose portal root
```

## Hook modes

Each HookRef has exactly one result mode. A Handler cannot choose how its Hook
is dispatched.

| Mode        | Semantics                                                                |
| ----------- | ------------------------------------------------------------------------ |
| `observe`   | All handlers receive immutable input; results are ignored.               |
| `first`     | The first explicit `handled` result wins; truthy values are not signals. |
| `waterfall` | Handlers return patches applied serially with validation after each.     |
| `guard`     | Decisions are combined with deny-overrides semantics.                    |
| `around`    | A restricted handler may invoke `next()` exactly once or short-circuit.  |

Execution policy is separate from result mode. Read-only observers may run in
parallel. First, waterfall, guard, around, activation, and cleanup are serial
unless the HookSpec explicitly proves independence. Static contribution
registration does not use a Hook mode. Generic loop Hooks are forbidden;
retries belong to bounded domain state machines.

`first` and `around` are not part of the first kernel slice. `around` is never
allowed to wrap or skip authentication, final validation, resource ownership,
cancellation, or shutdown. Command and Tool pipelines prefer explicit
transform, guard, finalize, execute, result-transform, result-finalize, and
observe stages.

## Type and runtime contract

```ts
interface ResourceScopeRegistration {
  readonly kind: ResourceScopeKind
  readonly signal: AbortSignal
  defer(label: string, disposer: ScopedDisposer): DisposableRegistration
  acquire<Resource>(
    label: string,
    factory: ScopedResourceFactory<Resource>,
    disposer: ScopedResourceDisposer<Resource>
  ): Promise<Resource>
}

interface ServiceRef<Service> {
  readonly key: symbol
  readonly id: ServiceId
  readonly version: number
  readonly scope: ResourceScopeKind
}

interface ServiceFactory<Service> {
  readonly dependencies: readonly ServiceRef<unknown>[]
  create(context: ServiceFactoryContext): Promise<Service>
}

interface ServiceFactoryContext {
  readonly services: ServiceAccessor
  readonly scope: ResourceScopeRegistration
  readonly signal: AbortSignal
  readonly deadline: number
}

interface ContributionRef<Value> {
  readonly key: symbol
  readonly id: ContributionPointId
  readonly version: number
}

interface ContributionSpec<Value> {
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

interface ContributionRegistration<Value> {
  readonly id: ContributionId
  readonly value: Value
  readonly requiredServices: readonly ServiceRef<unknown>[]
  readonly requiredCapabilities: readonly Capability[]
  readonly before?: readonly ContributionId[]
  readonly after?: readonly ContributionId[]
}

interface HookRef<Input, Output, Mode extends HookMode> {
  readonly key: symbol
  readonly id: HookId
  readonly version: number
  readonly mode: Mode
}

interface HookPolicyRef {
  readonly key: symbol
  readonly id: HookPolicyId
}

interface ResolvedHookPolicy {
  readonly ref: HookPolicyRef
  readonly dispatch: 'serial' | 'parallel'
  readonly handlerTimeoutMs: number
  readonly errorPolicy: HookErrorPolicy
  readonly rollback: 'none' | 'operation-scope' | 'resource-scope'
  readonly trackLateSettlement: boolean
}

interface HookSpecBase<Input, Output, Mode extends HookMode> {
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

interface ObserveHookSpec<Input> extends HookSpecBase<Input, void, 'observe'> {
  readonly ref: HookRef<Input, void, 'observe'>
}

interface WaterfallHookSpec<Input, Patch> extends HookSpecBase<
  Input,
  Patch,
  'waterfall'
> {
  readonly ref: HookRef<Input, Patch, 'waterfall'>
  readonly patchSchema: RuntimeSchema<Patch>
  readonly applyPatch: (current: Readonly<Input>, patch: Patch) => Input
}

interface GuardHookSpec<Input> extends HookSpecBase<Input, Decision, 'guard'> {
  readonly ref: HookRef<Input, Decision, 'guard'>
  readonly decisionSchema: RuntimeSchema<Decision>
}

type InitialHookSpec<Input, Output> =
  | ObserveHookSpec<Input>
  | WaterfallHookSpec<Input, Output>
  | GuardHookSpec<Input>

interface ExtensionRegistrationApi {
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

interface ExtensionModule {
  register(api: ExtensionRegistrationApi): void
}

interface HookInvocationContextBase {
  readonly extensionId: ExtensionId
  readonly generation: string
  readonly signal: AbortSignal
  readonly deadline: number
  readonly traceId: string
}

interface ActiveHookInvocationContext extends HookInvocationContextBase {
  readonly scopeAccess: 'active'
  readonly scope: ResourceScopeRegistration
  readonly services: ServiceAccessor
}

interface TerminalScopeView {
  readonly kind: ResourceScopeKind
  readonly resourceId: string
  readonly closedAt: number
}

interface TerminalHookInvocationContext extends HookInvocationContextBase {
  readonly scopeAccess: 'terminal'
  readonly scope: TerminalScopeView
}

type HookInvocationContext =
  ActiveHookInvocationContext | TerminalHookInvocationContext

type HookHandler<Input, Output> = (
  input: Readonly<Input>,
  context: HookInvocationContext
) => Promise<Output>

interface HookHandlerRegistration<Input, Output> {
  readonly id: HandlerId
  readonly handler: HookHandler<Input, Output>
  readonly requiredServices: readonly ServiceRef<unknown>[]
  readonly requiredCapabilities: readonly Capability[]
  readonly before?: readonly HandlerId[]
  readonly after?: readonly HandlerId[]
}

interface ResolvedObservePlan<Input> {
  readonly generation: string
  readonly spec: ObserveHookSpec<Input>
  readonly policy: ResolvedHookPolicy
  readonly handlers: readonly ResolvedHookHandler<Input, void>[]
}

interface ResolvedWaterfallPlan<Input, Patch> {
  readonly generation: string
  readonly spec: WaterfallHookSpec<Input, Patch>
  readonly policy: ResolvedHookPolicy
  readonly handlers: readonly ResolvedHookHandler<Input, Patch>[]
}

interface ResolvedGuardPlan<Input> {
  readonly generation: string
  readonly spec: GuardHookSpec<Input>
  readonly policy: ResolvedHookPolicy
  readonly handlers: readonly ResolvedHookHandler<Input, Decision>[]
}

type ResolvedHookPlan<Input, Output> =
  | ResolvedObservePlan<Input>
  | ResolvedWaterfallPlan<Input, Output>
  | ResolvedGuardPlan<Input>
```

Hook input is one frozen object, never a positional argument list or shared
mutable context. Compatible Hook versions may add optional input properties.
Outputs use explicit `Patch`, `Decision`, or `Handled` types. TypeScript types
are backed by runtime schemas at every external boundary. Contribution schemas
are validated while registering and again when decoding external manifests.

Waterfall applies exactly one validated patch at a time with the HookSpec's pure
`applyPatch`, then validates the complete resulting input before invoking the
next Handler. Portal provides no generic deep merge. Guard Decision is a
host-owned discriminated value (`allow` or `deny` with a typed reason), and
observe Handlers return only `Promise<void>`. Guard execution is serial and
stops at the first deny or Handler error; trace records every Handler skipped by
that terminal decision.

ExtensionRegistrationApi assigns the owner from the active Extension
transaction; callers cannot spoof it in a registration value. Fully qualified
Contribution IDs are globally unique, and `identityOf(value)` must equal the
registration ID. ContributionSpec separately limits each conflict key and
states whether all values apply, exactly one value is valid, or selection must
name an explicit key. Before/after fields are rejected when the
ContributionSpec has `ordering: none`.

HookSpec allowed services and capabilities are the maximum for that HookPoint.
Each Handler's declared requirements must be a subset and must also be granted
to its owning Extension. ServiceAccessor resolves only that intersection.
Service factories activate in a temporary ResourceScope of the kind named by
ServiceRef: success commits, failure rolls back, and scope closure disposes the
service. Service dependency cycles and scope inversions fail during resolution.

ResourceScopeRegistration permits only owned `defer` and pre-registered
`acquire`; it exposes no child creation, arbitrary lookup, or parent close.
Service factories, Provider factories, Surface activators, and runtime Handlers
all receive this capability instead of the mutable ResourceScope. Planner and
Runner reject an active invocation whose registration kind does not equal
HookSpec.scope.

Terminal HookSpecs are observe-only, have `scopeAccess: terminal`, allow no
target ServiceRefs, and receive TerminalHookInvocationContext. Its
TerminalScopeView preserves the semantic kind and resource identity for tracing
without exposing `defer`, `acquire`, or target services. Runner verifies that
the terminal view kind equals HookSpec.scope. Every other HookSpec uses
`scopeAccess: active`.

Unknown HookRefs, duplicate Handler IDs, duplicate contribution IDs, missing
capabilities, invalid schemas, dependency cycles, and post-freeze registration
fail during resolution. Registration is transactional: a rejected Extension
leaves no partial handlers or contributions.

## Ordering

Resolved order is deterministic:

```text
extension dependency topology
-> explicit before/after edges
-> stable extension and handler ID tie-break
```

Numeric priorities, installation order, filesystem enumeration order, and
implicit last-wins replacement are forbidden. A missing before/after target or
an ordering cycle is a resolution error. Kernel preconditions, core operations,
and SafetyFinalizers are explicit domain code outside the Handler order. They
cannot be registered, addressed by before/after, or replaced by an extension.

## Cancellation, deadlines, and failures

Every asynchronous invocation receives an AbortSignal and deadline. HookSpec,
not Handler, owns timeout and error behavior.

- Registration failure rejects the complete Extension transaction.
- Startup or resource-creation failure rolls back the current scope.
- Transform, guard, and first-result failure abort the current operation.
- Observer failure may isolate the Handler when the HookSpec permits it.
- Cleanup continues after errors and reports an aggregate at the boundary.
- Parallel work that already started is tracked to settlement after one task
  fails; Portal never pretends it was synchronously cancelled.
- An around Handler that does not call `next()` must return a typed
  short-circuit result. Calling `next()` twice is an immediate failure.

Hook tracing records Hook ID and version, generation, resolved Handler order,
owner, start and end time, result category, timeout, cancellation, and error
ownership. HookSpec supplies redaction rules; raw prompts, Tool parameters,
tokens, cookies, paths, and provider content are not logged by default.

## Kernel-owned invariants

Extensions cannot replace or bypass:

- extension discovery, manifest validation, graph freezing, and trust;
- configuration and private state file safety;
- Browser process, profile, CDP, BrowserContext, Page lease, and close ownership;
- MCP authentication, transport limits, and cancellation;
- thread admission and the Tool protocol state machine;
- rewritten input schema, capability, safety, and resource validation;
- depth, concurrency, output, timeout, retry, and shutdown limits;
- secret brokering and diagnostic redaction;
- process-tree cleanup and bounded reverse-order disposal.

Raw Playwright objects, process environment, data directories, stores, and
internal managers are private services. Public extensions receive narrow
facades or opaque handles. Trusted in-process extensions may receive broader
services only after an explicit trust decision.

## First-party contributions

Portal's product capabilities use the same registries that support external
extensions. First-party trust may grant private ServiceRefs, but it does not
grant a hidden registration path.

| Domain                   | Contribution points                                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commands                 | `commands.collect`, `cli.commands.collect`                                                                                                                                                         |
| Prompt and Agent         | `prompt.sections.collect`, `agent.profiles.collect`                                                                                                                                                |
| Tools                    | `tools.collect`                                                                                                                                                                                    |
| Skills                   | `skills.collect`, private `skill.sources.collect`                                                                                                                                                  |
| Provider core            | `providers.collect`, `provider.transports.collect`, `provider.urlResolvers.collect`                                                                                                                |
| Provider optional facets | `provider.models.collect`, `provider.capabilities.collect`, `provider.attachments.collect`, `provider.historyReaders.collect`, `provider.composerPolicies.collect`, `provider.diagnostics.collect` |
| Surfaces                 | `surfaces.collect`, `tui.actions.collect`, `keybindings.defaults.collect`, `presentation.renderers.collect`                                                                                        |
| MCP                      | `mcp.tools.collect`, with `mcp.resources.collect` and `mcp.prompts.collect` reserved for the protocol features                                                                                     |
| Configuration            | `configuration.schemas.collect`                                                                                                                                                                    |

Resolved contributions drive execution, help, completion, diagnostics, and
tests. Duplicate names fail. Replacing a built-in requires explicitly disabling
that contribution before registering a replacement; silent shadowing is not
supported.

### Commands

A Command contribution owns its ID, aliases, argument schema, help metadata,
required ServiceRefs, required capabilities, and Handler. One
`ResolvedCommandPlan` drives parsing, execution, help, hints, completion, and
diagnostics. A Command receives narrow services instead of ThreadManager,
ThreadStore, TerminalController, or a mutable application context.

Root CLI commands and in-session commands are separate contribution types
because bootstrap commands must be discoverable without activating PortalHost.
They may be shipped by the same package. A registration conflict is a
resolution error and never an implicit last-wins replacement.

### Prompt and Agent profiles

Prompt sections are structured contributions inserted into host-owned named
slots. They declare their applicable Agent profiles, token or character budget,
required capabilities, and dependency edges. They return structured content,
not arbitrary mutations of the final prompt string.

The initial public slots are `agent.instructions`, `project.instructions`,
`skills.catalog`, `provider.context`, and `user.context`. Their relative order
is host-owned and versioned. Kernel protocol framing, Tool-call syntax, safety
constraints, and final separators use private slots that extensions cannot
target. Adding or changing a public slot requires an Atlas review; extensions
cannot invent slot names at runtime.

An Agent profile contribution selects a prompt profile, Tool set, Provider
requirements, and bounded policy settings. It does not replace RuntimeCore,
the Tool protocol, retry, cancellation, or Thread commit state machines.
Mandatory setup instructions, Tool protocol framing, secret redaction, total
size limits, and final prompt validation remain kernel invariants.

### Skills

A Skill is a declarative contribution and is therefore naturally plugin-shaped:

```ts
interface SkillContribution {
  readonly id: SkillId
  readonly title: string
  readonly description: string
  readonly activation: 'startup' | 'onDemand'
  readonly instructions: PromptContent
  readonly resources: readonly SkillResource[]
  readonly activationAliases?: readonly string[]
}
```

A Skill package may explicitly contribute Commands or Tools in addition to a
Skill, but a Skill does not implicitly acquire code execution. Script files in
a Skill are resources; running them requires an independently registered Tool
with the required process and filesystem capabilities. The host `/skill`
Command manages the resolved Skill catalog and is not copied into every Skill.

`startup` Skills enter the immutable Runtime prompt snapshot within a
host-enforced aggregate budget. `onDemand` Skills expose only their ID, title,
description, and aliases in the catalog. A kernel-owned SkillActivationService,
invoked by RuntimeCore for a Tool activation or pending selection, validates
access and returns an immutable ActivatedSkillSnapshot for that Runtime
generation. Activation does not mutate the global contribution graph.

SkillActivationService is the only content-delivery path. It builds and
finalizes the candidate snapshot under the Runtime's remaining Skill budget,
then returns it only to RuntimeCore. For an on-demand activation during a Tool
loop, RuntimeCore places the finalized instructions and opaque resource
descriptors in the next private `skill.activation` continuation; the public Tool
result contains only typed activation status. The Runtime atomically records the
Skill ID in ActiveSkillSet after that continuation is accepted. Later turn
snapshots capture the immutable active-set revision. They do not repeatedly
inject the content, but Runtime reconstruction rehydrates active instructions
through PromptCompiler under the same budget and finalizer. A failed delivery
does not commit activation.

An out-of-turn Command cannot activate content directly. It may call the narrow
SkillSelectionService to add a Skill ID to the Thread's pending selection. The
next message submission captures that selection, calls SkillActivationService,
and delivers the same finalized private continuation before user content. It
commits ActiveSkillSet only after the Provider accepts the combined submission;
cancelled or failed submissions leave the selection pending. Thus Tool and
Command entry paths share one budget, snapshot, delivery, and commit protocol.

Skill resources use package-relative logical IDs, declared media types, sizes,
and digests. The loader rejects traversal, links outside the package, excessive
counts, unsupported media, and values over host limits. Extensions receive
opaque SkillResourceHandles rather than absolute paths. A Tool must use an
authorized resource service to read or execute content.

Direct Skill contributions use `skills.collect`. Trusted first-party or
user-configured discovery adapters may contribute a `SkillSource` through the
private `skill.sources.collect` point, but public packages should normally
declare their Skills in the manifest so discovery does not execute code. A
SkillSource synthesizes a stable owner Extension ID and fully qualified Skill ID
for every discovered `SKILL.md`; filesystem load order never becomes identity.

### Tools

A Tool contribution owns metadata, an input schema, capability requirements,
an executor factory, a result schema, and optional structured presentation
metadata. The Tool executor receives only declared facades such as
`WorkspaceFileService`,
`AttachmentService`, `ProcessJobService`, or `SpawnService`. It never receives
a raw Provider adapter, Browser Page, process environment, ThreadManager, or
TerminalController.

The Tool owns the schema and redaction rules for its presentation view model.
A Presenter contribution maps a declared presentation kind and validated view
model into a Surface-neutral presentation model. The TUI Surface renders that
model with its own trusted components. A public Tool cannot ship an arbitrary
React/Ink renderer or ask a Surface to inspect its raw execution result.

PresentationSpec defines the input view-model schema and the one host-owned
PresentationModel output schema. Before Surface delivery, the kernel enforces
size, nesting, redaction, safe-link, binary-content, and unsupported-action
limits. Presenter output cannot contain callbacks, terminal controls, raw
secrets, or unvalidated markup. A presentation finalizer failure falls back to
a bounded plain result and is traced to the Presenter owner.

The kernel owns Tool selection snapshots, parsing, rewritten-input validation,
permission and resource finalizers, cancellation, concurrency, output limits,
spawn depth, result delivery, and Tool-loop state transitions. Disabling a Tool
atomically removes it from execution, prompt disclosure, help, MCP exposure,
and presentation.

### Provider packages and facets

A Provider package may bundle all of these contributions, but Portal resolves
them separately:

| Contribution          | Resolution key and cardinality                     | Responsibility                                                                     |
| --------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Provider descriptor   | one per `providerId`                               | ID, display metadata, aliases, trust, and declared facet support                   |
| Provider transport    | exactly one per `providerId`                       | inspect state, open, text exchange, conversation identity, stop, and dispose       |
| URL resolver          | unique `providerId/resolverKey`, zero or more      | pure matching and canonicalization of conversation URLs                            |
| Model controller      | unique `providerId/modelKey`, zero or more         | model and option metadata plus session-bound inspect/select                        |
| Capability controller | unique `providerId/capabilityKey`, zero or more    | one typed toggle or action capability with inspect/apply                           |
| Attachment strategy   | unique `providerId/kind/strategyKey`, zero or more | one attachment kind, limits, staging, upload, and cleanup                          |
| History reader        | unique `providerId/readerKey`, zero or more        | normalized history plus explicit completeness evidence                             |
| Composer policy       | unique `providerId/policyKey`, zero or more        | readiness and Provider-reported payload limits that may only tighten kernel limits |
| Diagnostics           | unique `providerId/diagnosticKey`, zero or more    | redacted health and state snapshots                                                |

Every transport and facet has an executable session-binding contract:

```ts
interface ProviderPrivateBackendRef<Backend> {
  readonly key: symbol
  readonly providerId: ProviderId
  readonly version: number
}

interface ProviderTransportContribution<PrivateBackend> {
  readonly id: ContributionId
  readonly providerId: ProviderId
  readonly contractVersion: number
  readonly privateBackendRef: ProviderPrivateBackendRef<PrivateBackend>
  createFactory(
    context: ProviderTransportActivationContext
  ): ProviderSessionFactory<PrivateBackend>
}

interface ProviderTransportActivationContext {
  readonly services: ServiceAccessor
  readonly configuration: ExtensionConfigurationView
  readonly state: ExtensionStateView
  readonly secrets: ExtensionSecretAccessor
  readonly scope: ResourceScopeRegistration
}

interface ProviderSessionFactory<PrivateBackend> {
  create(
    context: ProviderSessionFactoryContext
  ): Promise<ProviderSessionBinding<PrivateBackend>>
}

interface ProviderSessionFactoryContext {
  readonly sessionId: ProviderSessionId
  readonly page: ProviderPagePort
  readonly services: ServiceAccessor
  readonly scope: ResourceScopeRegistration
  readonly signal: AbortSignal
  readonly deadline: number
}

interface ProviderSessionBinding<PrivateBackend> {
  readonly transport: ProviderTransport
  readonly privateBackend: {
    readonly ref: ProviderPrivateBackendRef<PrivateBackend>
    readonly value: PrivateBackend
  }
  readonly extensionPoints: readonly ProviderExtensionPointBinding<unknown>[]
}

interface ProviderFacetContribution<Facet, PrivateBackend = never> {
  readonly id: ContributionId
  readonly targetProviderId: ProviderId
  readonly facetKind: ProviderFacetKind
  readonly facetKey: string
  readonly contractVersion: number
  readonly privateBackendRef?: ProviderPrivateBackendRef<PrivateBackend>
  readonly requiredExtensionPoints: readonly ProviderExtensionPointRef<unknown>[]
  create(context: ProviderFacetFactoryContext<PrivateBackend>): Promise<Facet>
}

type ProviderFacetFactoryContext<PrivateBackend> =
  | {
      readonly ownership: 'same-package'
      readonly session: ProviderSessionHandle
      readonly privateBackendRef: ProviderPrivateBackendRef<PrivateBackend>
      readonly privateBackend: PrivateBackend
      readonly services: ServiceAccessor
      readonly scope: ResourceScopeRegistration
      readonly signal: AbortSignal
      readonly deadline: number
    }
  | {
      readonly ownership: 'cross-package'
      readonly session: ProviderSessionHandle
      readonly extensionPoints: ProviderExtensionPointAccessor
      readonly services: ServiceAccessor
      readonly scope: ResourceScopeRegistration
      readonly signal: AbortSignal
      readonly deadline: number
    }
```

ProviderPagePort is a host-owned, capability-checked automation facade scoped
to one PageLease. It exposes the minimum navigation, locator, protocol-capture,
and event operations approved for the Provider package, never the Playwright
Page, BrowserContext, cookies, profile, or unrestricted CDP session.

There is no last-wins facet selection. Model and capability IDs are explicit
user or Agent choices. If several attachment strategies or history readers are
valid, the Provider descriptor or validated user configuration selects one by
key. All composer policies apply and the strictest validated limit wins.
Replacing a first-party facet requires disabling its contribution before graph
resolution.

The minimum transport is deliberately narrower than the current all-purpose
adapter, but it is not only a `send()` function:

```ts
interface ProviderTransport {
  inspect(options: OperationOptions): Promise<ProviderStateSnapshot>
  open(
    target: NewConversationTarget | ResumeTarget,
    options: OperationOptions
  ): Promise<void>
  exchange(
    request: ProviderTextRequest,
    sink: ProviderResponseSink,
    options: OperationOptions
  ): Promise<ProviderResponse>
  identity(): ConversationIdentity
  stop(options: OperationOptions): Promise<void>
  close(): Promise<void>
}
```

`ProviderStateSnapshot` uses a host-owned finite state set such as `opening`,
`auth_required`, `ready`, `busy`, `restricted`, `closed`, and `failed`.
Streaming output is operation-scoped; a Provider cannot install a global
mutable reporter. Facet instances bind to an opaque ProviderSessionHandle and
cannot recover a raw adapter or Page from it.

ProviderSessionCoordinator is the sole composition owner. It acquires a
PageLease from PageService, derives a capability-checked ProviderPagePort for
the resolved ProviderSessionFactory, binds the resolved facets, and returns
standardized `ConversationPort`, `ProviderControlService`,
`AttachmentService`, and `HistoryService` facades to Runtime consumers.
Activation is transactional in ProviderSessionScope.

Facets owned by the same package as the Provider may share a package-private
session backend only by declaring the exact ProviderPrivateBackendRef exported
by that transport. Planner verifies the same owner, target Provider, ref key,
and version before constructing the `same-package` context. A different package
cannot declare that private ref; it receives the opaque session handle, its
declared host ServiceRefs, and only the narrow `ProviderExtensionPointRef`s
explicitly exported by the target Provider.
If the target does not export the required extension point or the contract
version is incompatible, graph resolution fails. Independent registration
therefore does not imply that arbitrary third-party code can manipulate another
Provider's page.

ProviderSessionCoordinator owns the temporary session scope and PageLease
throughout construction. A factory registers transport/backend resources in
that scope but never closes the lease. Returning ProviderSessionBinding
transfers those resources to the coordinator, which activates each facet in a
temporary child scope and commits only after all required facets succeed. Any
failure rolls back facets, transport/backend, and finally the lease exactly
once. Runtime consumers receive only the standardized facades.

BrowserHost owns Browser and BrowserContext. PageService owns every raw Page
and gives a ProviderSession one opaque PageLease. Providers, Spawn, Tools, and
Surfaces cannot call `newPage()` or close a Page directly. Thread shutdown
closes the ProviderSession and releases the lease before Browser shutdown.

Attachment handlers receive only broker-approved files after path, MIME, size,
count, and capability checks. Provider transforms and facet operations are
followed by kernel final validation. Provider-private DOM selectors, protocol
capture, request ownership, response-channel arbitration, auth evidence, and
recovery heuristics stay inside the owning package rather than becoming public
Hooks.

Login waiting, restore, model and capability setup, attachment staging,
submission, response arbitration, retry, history completeness, and Thread
commit remain explicit coordinators. Hooks observe or transform stable inputs
around those state machines; they do not select arbitrary next states.

### Surfaces and presentation

In the target architecture, TUI, exec, and MCP become first-party Surface
extensions:

```ts
interface SurfaceContribution {
  readonly id: SurfaceId
  readonly kind: 'interactive' | 'batch' | 'listener'
  readonly sessionIntent: 'interactive' | 'batch' | 'automation'
  activate(context: SurfaceContext): Promise<SurfaceInstance>
}
```

SurfaceContext exposes narrow Thread, Message, Job, Skill, Command, and event
services, an immutable Host snapshot, a Surface-owned
ResourceScopeRegistration, scoped configuration, state and secrets, and
`requestStop()`. It does not expose
PortalHost, Browser, Page, Store, internal managers, admission controls, MCP
tokens, or the shutdown coordinator.

The TUI package contributes the `portal.tui` Surface plus Commands, TUI actions,
default keybindings, and structured presenters. It is not one giant Handler,
and public extensions do not initially contribute arbitrary React or Ink
components. Tool and Provider packages return structured presentation data;
the TUI chooses how to render it.

Exec contributes the `portal.exec` batch Surface and its root CLI command. MCP
contributes the `portal.mcp` listener Surface and protocol Tools independently
of the TUI. MCP authentication, Origin policy, body and request limits,
cancellation, and listener shutdown remain kernel-owned; MCP contributions are
invoked only after those checks.

## Hook Atlas

The Atlas is the review boundary for extensibility. New HookRefs require an
update here before implementation. `experimental` HookRefs may change within
the development line. A stable public HookRef changes only compatibly; changed
semantics require a new ID or version.

Registration contribution points run synchronously while the graph is mutable.
They are all frozen at `resolved`; they are not re-emitted for every Runtime or
operation. The `.collect` suffix identifies a ContributionRef group; it does
not mean that HookRunner invokes a `collect` Hook mode.

| Contribution point                  | Scope  | Owner                   | Availability |
| ----------------------------------- | ------ | ----------------------- | ------------ |
| `commands.collect`                  | portal | CommandPlanner          | implemented  |
| `cli.commands.collect`              | portal | CLI bootstrap           | later        |
| `prompt.sections.collect`           | portal | PromptRegistry          | later        |
| `agent.profiles.collect`            | portal | AgentProfileRegistry    | later        |
| `tools.collect`                     | portal | ToolRegistry            | later        |
| `skills.collect`                    | portal | SkillRegistry           | later        |
| `skill.sources.collect`             | portal | SkillSourceRegistry     | private      |
| `providers.collect`                 | portal | ProviderRegistry        | later        |
| `provider.transports.collect`       | portal | ProviderRegistry        | later        |
| `provider.urlResolvers.collect`     | portal | ProviderRegistry        | later        |
| `provider.models.collect`           | portal | ProviderFacetRegistry   | later        |
| `provider.capabilities.collect`     | portal | ProviderFacetRegistry   | later        |
| `provider.attachments.collect`      | portal | ProviderFacetRegistry   | later        |
| `provider.historyReaders.collect`   | portal | ProviderFacetRegistry   | later        |
| `provider.composerPolicies.collect` | portal | ProviderFacetRegistry   | later        |
| `provider.diagnostics.collect`      | portal | ProviderFacetRegistry   | later        |
| `surfaces.collect`                  | portal | SurfaceRegistry         | later        |
| `tui.actions.collect`               | portal | TuiActionRegistry       | later        |
| `keybindings.defaults.collect`      | portal | KeybindingRegistry      | later        |
| `presentation.renderers.collect`    | portal | PresentationRegistry    | later        |
| `mcp.tools.collect`                 | portal | McpContributionRegistry | later        |
| `mcp.resources.collect`             | portal | McpContributionRegistry | reserved     |
| `mcp.prompts.collect`               | portal | McpContributionRegistry | reserved     |
| `configuration.schemas.collect`     | portal | ExtensionConfigRegistry | later        |

Runtime Hook points surround explicit owners. These rows define the five
HookPolicyRefs that HookSpec may reference:

| Policy         | Dispatch | Per-handler budget                       | Failure and rollback                                                              |
| -------------- | -------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| `activation`   | serial   | 5 seconds, capped by invocation deadline | abort creation/start and roll back the current resource scope                     |
| `notification` | parallel | 2 seconds, capped by invocation deadline | isolate and trace the Handler; track late settlement; do not change the operation |
| `transform`    | serial   | 2 seconds, capped by invocation deadline | abort the operation and roll back its operation scope                             |
| `guard`        | serial   | 2 seconds, capped by invocation deadline | treat error as deny, abort the operation, and roll back its operation scope       |
| `shutdown`     | serial   | 1 second or remaining shutdown budget    | aggregate the error and continue all remaining cleanup                            |

The canonical policy assignment is explicit:

- every waterfall Hook uses `transform`;
- every guard Hook uses `guard`;
- `portal.beforeStart`, `portal.ready`, `session.starting`, `session.ready`,
  `surface.starting`, `surface.ready`, `browser.launched`, `context.created`,
  `page.created`, `thread.ready`, `provider.ready`,
  `conversation.initialized`, and `runtime.ready` use `activation`;
- `portal.beforeStop`, `session.beforeClose`, `surface.beforeStop`,
  `browser.beforeClose`, `context.beforeClose`, `page.beforeClose`,
  `thread.beforeClose`, `provider.session.beforeClose`, and
  `runtime.beforeClose` use `shutdown`;
- every other observe Hook in the Atlas uses `notification`.

The exported HookSpec references that exact HookPolicyRef; resolution rejects a
different policy. There are not separate inline timeout or error-policy
overrides. A Hook invocation may provide a smaller absolute deadline but cannot
weaken the policy. Timeout aborts a derived signal; the Runner retains a
settlement observer for work that ignores cancellation.

`portal.stopped`, `session.closed`, `surface.stopped`, `browser.closed`,
`context.closed`, `page.closed`, `thread.closed`,
`provider.session.closed`, and `runtime.closed` are the terminal HookSpecs.
Every other Atlas row uses active scope access.

Activation observers run after the underlying resource is acquired but before
the owner publishes it as usable. Their payload is immutable and their results
are ignored, but a failure prevents publication and rolls back the scope.

| Hook ID                           | Mode      | Scope      | Owner                      | Stability    |
| --------------------------------- | --------- | ---------- | -------------------------- | ------------ |
| `portal.beforeStart`              | observe   | portal     | PortalHost                 | experimental |
| `portal.ready`                    | observe   | portal     | PortalHost                 | experimental |
| `portal.beforeStop`               | observe   | portal     | PortalHost                 | experimental |
| `portal.stopped`                  | observe   | portal     | PortalHost                 | experimental |
| `session.starting`                | observe   | session    | SessionCoordinator         | experimental |
| `session.ready`                   | observe   | session    | SessionCoordinator         | experimental |
| `session.beforeClose`             | observe   | session    | SessionCoordinator         | experimental |
| `session.closed`                  | observe   | session    | SessionCoordinator         | experimental |
| `surface.starting`                | observe   | surface    | SurfaceCoordinator         | experimental |
| `surface.ready`                   | observe   | surface    | SurfaceCoordinator         | experimental |
| `surface.beforeStop`              | observe   | surface    | SurfaceCoordinator         | experimental |
| `surface.stopped`                 | observe   | surface    | SurfaceCoordinator         | experimental |
| `browser.beforeLaunch`            | waterfall | browser    | BrowserHost                | experimental |
| `browser.launched`                | observe   | browser    | BrowserHost                | experimental |
| `browser.beforeClose`             | observe   | browser    | BrowserHost                | experimental |
| `browser.closed`                  | observe   | browser    | BrowserHost                | experimental |
| `context.beforeCreate`            | waterfall | context    | BrowserHost                | experimental |
| `context.created`                 | observe   | context    | BrowserHost                | experimental |
| `context.beforeClose`             | observe   | context    | BrowserHost                | experimental |
| `context.closed`                  | observe   | context    | BrowserHost                | experimental |
| `page.beforeCreate`               | waterfall | page       | PageService                | experimental |
| `page.created`                    | observe   | page       | PageService                | experimental |
| `page.beforeClose`                | observe   | page       | PageService                | experimental |
| `page.closed`                     | observe   | page       | PageService                | experimental |
| `thread.provisioning`             | observe   | thread     | ThreadLifecycleService     | experimental |
| `thread.ready`                    | observe   | thread     | ThreadLifecycleService     | experimental |
| `thread.provisionFailed`          | observe   | thread     | ThreadLifecycleService     | experimental |
| `thread.beforeClose`              | observe   | thread     | ThreadLifecycleService     | experimental |
| `thread.closed`                   | observe   | thread     | ThreadLifecycleService     | experimental |
| `provider.session.beforeOpen`     | waterfall | provider   | ProviderSessionCoordinator | experimental |
| `provider.session.stateChanged`   | observe   | provider   | ProviderSessionCoordinator | experimental |
| `provider.authRequired`           | observe   | provider   | AuthCoordinator            | experimental |
| `provider.authenticated`          | observe   | provider   | AuthCoordinator            | experimental |
| `provider.ready`                  | observe   | provider   | ProviderSessionCoordinator | experimental |
| `provider.session.beforeClose`    | observe   | provider   | ProviderSessionCoordinator | experimental |
| `provider.session.closed`         | observe   | provider   | ProviderSessionCoordinator | experimental |
| `provider.model.beforeSelect`     | guard     | provider   | ProviderControlService     | experimental |
| `provider.model.selected`         | observe   | provider   | ProviderControlService     | experimental |
| `provider.capability.beforeApply` | guard     | provider   | ProviderControlService     | experimental |
| `provider.capability.applied`     | observe   | provider   | ProviderControlService     | experimental |
| `attachment.requestTransform`     | waterfall | attachment | AttachmentCoordinator      | experimental |
| `attachment.guard`                | guard     | attachment | AttachmentCoordinator      | experimental |
| `attachment.staged`               | observe   | attachment | AttachmentCoordinator      | experimental |
| `attachment.failed`               | observe   | attachment | AttachmentCoordinator      | experimental |
| `conversation.beforeRestore`      | waterfall | runtime    | ConversationInitializer    | experimental |
| `conversation.historyLoaded`      | observe   | runtime    | ConversationInitializer    | experimental |
| `conversation.initialized`        | observe   | runtime    | ConversationInitializer    | experimental |
| `runtime.ready`                   | observe   | runtime    | RuntimeCore                | experimental |
| `runtime.beforeClose`             | observe   | runtime    | RuntimeCore                | experimental |
| `runtime.closed`                  | observe   | runtime    | RuntimeCore                | experimental |
| `message.beforeSubmit`            | waterfall | turn       | RuntimeCore                | experimental |
| `message.submitted`               | observe   | turn       | RuntimeCore                | experimental |
| `message.responseCaptured`        | observe   | turn       | RuntimeCore                | experimental |
| `message.failed`                  | observe   | turn       | RuntimeCore                | experimental |
| `turn.started`                    | observe   | turn       | ThreadManager              | experimental |
| `turn.completed`                  | observe   | turn       | ThreadManager              | experimental |
| `turn.failed`                     | observe   | turn       | ThreadManager              | experimental |
| `command.inputTransform`          | waterfall | command    | CommandExecutor            | experimental |
| `command.guard`                   | guard     | command    | CommandExecutor            | experimental |
| `command.resultTransform`         | waterfall | command    | CommandExecutor            | experimental |
| `command.executed`                | observe   | command    | CommandExecutor            | experimental |
| `command.failed`                  | observe   | command    | CommandExecutor            | experimental |
| `tool.inputTransform`             | waterfall | tool       | ToolExecutor               | experimental |
| `tool.guard`                      | guard     | tool       | ToolExecutor               | experimental |
| `tool.resultTransform`            | waterfall | tool       | ToolExecutor               | experimental |
| `tool.executed`                   | observe   | tool       | ToolExecutor               | experimental |
| `tool.failed`                     | observe   | tool       | ToolExecutor               | experimental |
| `spawn.started`                   | observe   | runtime    | SpawnService               | experimental |
| `spawn.completed`                 | observe   | runtime    | SpawnService               | experimental |
| `spawn.failed`                    | observe   | runtime    | SpawnService               | experimental |
| `mcp.requestAccepted`             | observe   | surface    | McpRequestCoordinator      | experimental |
| `mcp.requestCompleted`            | observe   | surface    | McpRequestCoordinator      | experimental |
| `mcp.requestFailed`               | observe   | surface    | McpRequestCoordinator      | experimental |

The Atlas intentionally describes domain transitions rather than generic
`beforeStateChange` or `all` events. Provider login detection, readiness,
submission, retry, and response capture remain Provider-private operations
coordinated by their explicit state machines. Hook handlers observe or
transform stable inputs; they do not choose arbitrary next states.

The fixed execution shape for Command, Tool, attachment, and message operations
is:

```text
extension input transforms
-> extension guards
-> kernel input schema/capability/resource SafetyFinalizer
-> explicit core operation
-> constrained result transforms
-> kernel result schema/size/redaction/protocol SafetyFinalizer
-> observers
```

Rollback disposes Portal-owned operation resources; it never claims that a
remote message, process action, or other external side effect was undone. A
result-transform or result-finalizer failure blocks delivery and is reported
with the already-performed core outcome.

No public Hook runs before MCP authentication, after the applicable final
SafetyFinalizer, or around Browser/Page ownership and shutdown.
Raw response chunks are not a general public observer because of privacy and
performance; approved stream consumers use an operation-scoped, redacted sink.

## Extension trust and storage

External extension loading is explicit. Portal does not scan a project and run
code merely because a file exists. A manifest declares a namespaced ID, version,
Portal and Hook API ranges, runtime kind, contributions, dependencies,
capabilities, trust requirement, and configuration schema. Runtime-specific
fields form a discriminated union:

```text
ManifestBase
  schemaVersion
  id = publisher.name
  version
  engines.portal
  engines.hookApi
  dependencies
  contributes
  capabilities
  configurationSchema
  trust

DeclarativeManifest
  runtime.kind = declarative
  assets
  forbids entrypoint and executable bindings

RpcManifest
  runtime.kind = rpc
  runtime.command
  runtime.protocolVersion
  bindings

TrustedNodeManifest
  runtime.kind = trusted-node
  runtime.entrypoint
  bindings
```

Each executable binding descriptor has a fully qualified binding ID, one kind,
the target contribution or Hook-handler ID, and a contract version:

```text
binding.kind =
  service-factory |
  hook-handler |
  command-handler |
  tool-executor |
  provider-session-factory |
  provider-facet-factory |
  surface-activator |
  presenter
```

Executable contribution values refer to those binding IDs rather than carrying
functions in the manifest. Registry validates that every binding kind is legal
for its target and that every target has exactly the required binding.

Manifest discovery, schema validation, contribution resolution, and help or
completion generation do not activate plugin code. Activation conditions are
derived from declared contributions and resolved Surfaces rather than arbitrary
string events or manifest-provided startup rules. Declarative packages have no
runtime activation. RPC and Trusted Node packages activate only when a resolved
contribution or Hook binding is first needed. Activation runs in a temporary
ResourceScope and commits only after all registrations and resources succeed.
Disablement takes effect in the next immutable generation; runtime unload is
not supported.

Statically bundled first-party modules and tests use ExtensionModule.register
during the synchronous registration phase. External manifests decode directly
into equivalent contribution, Handler, and executable-binding descriptors. At
executable activation, an ExtensionBindingApi may bind factories and functions
only to binding IDs already declared and frozen by that manifest; it cannot add
a Contribution, Hook handler, ServiceRef, dependency, or ordering edge. Portal
verifies binding kind, target, contract version, and runtime input/output
schemas; RPC also verifies the protocol envelope on every call. Missing,
duplicate, undeclared, or signature-incompatible bindings fail activation and
roll back its scope.

In-process Node extensions are `Trusted / No Sandbox`. They have the operating
system permissions of Portal, like local VS Code extensions. A Worker or child
process is not described as a security sandbox. A subprocess transport can
improve crash and resource isolation and can expose a narrow RPC API, but it
does not remove the same-user operating system trust boundary.

Extension-owned data is separated:

- sparse user configuration is validated against the Extension schema;
- managed enablement, installation, and migration state is private state;
- secrets are obtained through the host secret service and are not printed or
  stored in ordinary configuration;
- defaults are immutable package data; declarative defaults live in the
  manifest or referenced assets, while executable runtimes may bundle defaults
  without performing I/O during registration;
- an Extension cannot rewrite Portal's root configuration directly.

Project-local executable extensions remain disabled until Portal has an
explicit workspace trust design. Online installation, package lifecycle
scripts, automatic dependency installation, and a marketplace are outside this
architecture line.

External delivery proceeds in this order:

1. declarative packages containing Skills, Prompt sections, configuration,
   metadata, and other data-only contributions;
2. subprocess RPC packages with a narrow, versioned protocol and host-owned
   capability brokers;
3. explicitly trusted in-process Node packages marked `Trusted / No Sandbox`.

Provider, Tool, arbitrary TUI code, and raw network-facing Surface extensions
are not public until their ServiceRefs, finalizers, and trust policies have been
proven by first-party migrations.

## Implementation sequence

This sequence is internal to `next/hook-first`. Every step is reviewed, tested,
and committed independently so the branch remains recoverable, but none is a
partial product release and the branch does not replace `main` before the
delivery contract is complete.

1. Remove the former conversation Hook product and establish ResourceScope and
   one PortalHost composition. This foundation is complete.
2. Implement the Portal-owned ExtensionRegistry, ContributionRegistry,
   ContributionRef/Spec, HookRegistry, HookPlanner, HookRunner, ServiceRef
   container, trace, and TestHost. Registration is synchronous and
   transactional; HookRunner initially supports only `observe`, `waterfall`,
   and `guard`. Connect `portal.beforeStart`, `portal.ready`,
   `portal.beforeStop`, and `portal.stopped` to PortalHost in this same slice so
   the production Runner is not dead infrastructure. Add no public generic
   around Hook.
3. Migrate Command contributions as the first complete vertical slice. One
   resolved plan must drive parsing, execution, help, hints, and completion.
   This slice is complete for in-session first-party Commands. It deliberately
   excludes bootstrap CLI Commands, manifests, external activation, and the
   public SDK.
4. Migrate Prompt sections, Agent profiles, and Skills, including startup and
   on-demand Skill activation, prompt snapshots, budgets, and resource handles.
5. Establish BrowserHost and PageService as the only BrowserContext/Page owners.
   Replace every raw Page path with scoped leases before adding Page Hooks.
6. Implement ProviderRegistry, ProviderSessionCoordinator, transport, and facet
   registries. Migrate one simple Provider, one toggle-capability Provider, and
   one action/complex-stream Provider as contract probes, then migrate every
   remaining first-party Provider and delete the legacy Adapter abstraction and
   static Provider closed sets.
7. Migrate Tool contributions after Provider control, attachment, history,
   Spawn, workspace file, and job facades exist. Remove static defaults and
   broad Tool contexts; connect both input and result finalizers.
8. Connect Browser, Page, auth, conversation, attachment, message, Command,
   Tool, turn, and spawn Hook points to their explicit state machines. No Hook
   becomes the owner of login waiting, dispatch, response arbitration, retry,
   commit, cancellation, or shutdown.
9. Implement SurfaceRegistry and narrow Surface services. Migrate TUI and exec,
   then detach MCP from TUI and migrate it as an auxiliary listener Surface.
   Migrate TUI actions, keybindings, presenters, and MCP protocol contributions.
10. Implement manifest discovery, Extension configuration/state/secret brokers,
    trust, activation, enablement, diagnostics, safe mode, and package testing.
    Deliver declarative external packages first, then RPC, then the explicitly
    trusted Node escape hatch.
11. Run all first-party packages through the same TestHost and registry for at
    least one complete internal stabilization cycle. Only then mark selected
    HookRefs, ServiceRefs, and contribution schemas stable and publish the SDK.

## Test strategy

The kernel has backend-neutral contract tests for every mode and policy:

- transactional registration, duplicate detection, and graph freezing;
- rejection of asynchronous or thenable registration and post-freeze writes;
- ContributionSpec schema, owner, identity, conflict key, cardinality, missing
  ServiceRef, and manifest decoding failures;
- deterministic dependency and before/after ordering;
- waterfall patch validation, guard deny-overrides, and observer policy;
- Observe void output, first-deny Guard short-circuit, and skipped-handler trace;
- HookPolicyRef mismatch, invocation scope mismatch, and mode-specific resolved
  plan typing;
- ServiceAccessor authorization intersection and inability of terminal Hooks to
  resolve disposed target services, defer cleanup, or acquire resources;
- cancellation, per-handler deadline, late parallel settlement, and redaction;
- activation rollback, reverse disposal, idempotence, deadline, and aggregate
  cleanup errors;
- input finalizer execution after every external transform and guard, plus
  result finalizer execution after every result transform;
- trace ownership and stable generation snapshots;
- Command contribution and executable-binding ownership, strict route parsing,
  alias and route conflict rejection, immutable prepared invocations, narrow
  ServiceRef authorization, cancellation, absolute deadlines, late settlement,
  and command-scope cleanup;
- one resolved Command analysis driving TUI help, hints, completion, syntax,
  admission, and execution, with architecture tests excluding legacy command
  registries and broad implementation imports.
- exact Portal shutdown event order from admission close through extension
  activation-scope disposal.

Domain tests prove that each HookPoint is attached exactly once to its owner;
they do not repeat the full kernel matrix. Extension TestHost runs discovery,
registration, resolution, activation, invocation, failure, and disposal without
starting Chromium. Browser and Page ownership use real Chromium lifecycle
smoke tests. TUI, exec, and MCP contract tests prove they share one PortalHost
without instantiating unavailable Surfaces.

## Delivery contract

The development line is complete only when:

1. the former Hook configuration, command, runtime, documentation, and tests no
   longer exist;
2. TUI, exec, and MCP use one PortalHost and ResourceScope implementation;
3. TUI, exec, and MCP are resolved first-party Surface extensions, and MCP no
   longer depends on TerminalController or TUI composition;
4. every first-party Command, Prompt section, Agent profile, Skill, Tool,
   Provider descriptor/transport/facet, Presenter, Keybinding, MCP capability,
   configuration schema, and Surface is resolved through its contribution
   registry with an owner and fully qualified ID;
5. disabling a contribution atomically removes it from discovery, execution,
   prompts, help, completion, presentation, MCP exposure, and diagnostics;
6. no static `DEFAULT_COMMANDS`, `DEFAULT_TOOLS`, Provider union/switch, Surface
   profile switch, or equivalent hidden first-party registration path remains;
7. Browser, Context, and Page creation have one owner and no Provider, Spawn,
   Tool, or Surface bypass path;
8. Runtime, Commands, Tools, and Surfaces depend on narrow ServiceRefs and no
   longer expose raw Provider adapters, Browser objects, stores, managers,
   process environment, or a mutable application context;
9. Provider transport, models, capabilities, attachments, history, composer
   policy, URL resolution, and diagnostics are independently resolvable facets;
10. Skills are declarative contributions, with executable Commands and Tools
    declared separately and permissioned independently;
11. the Atlas HookPoints are connected to explicit domain state machines with
    final validation and rollback;
12. explicit external Extension discovery, trust, configuration, state, secret,
    diagnostics, and testing are complete;
13. declarative external packages can be installed, enabled, configured,
    disabled, diagnosed, and removed without executing undeclared code;
14. the supported RPC transport enforces its versioned capability protocol,
    cancellation, resource limits, crash isolation, and process-tree cleanup;
15. Trusted Node packages require an explicit `No Sandbox` trust decision and
    use the same contribution, lifecycle, diagnostics, and disablement graph;
16. package installation pins version and digest, avoids Portal's primary
    `node_modules`, and never runs package lifecycle scripts;
17. type, lint, format, unit, coverage, package, audit, browser lifecycle, and
    cross-platform CI checks pass.

Intermediate commits remain reviewable and green, but no intermediate public
API is released and the branch does not replace `main` until this contract is
satisfied.

## Rejected designs

- Tapable or Hookable as Portal's public ABI;
- a global `emit(string, mutableContext)` EventEmitter;
- numeric priorities or registration order as semantics;
- implicit same-name replacement;
- generic loop or unrestricted around Hooks;
- a giant Provider contribution that returns one all-capability Adapter;
- treating each private helper or state-machine step as a public Hook;
- giving a Skill implicit process, filesystem, network, Command, or Tool
  execution merely because the package contains scripts;
- renaming `app.ts` to a TUI plugin while it still constructs Host internals;
- treating a hard-coded HostProfile as a Surface registry;
- allowing first-party code to bypass registries while only external code uses
  the contribution contracts;
- handlers that can bypass authentication, final validation, limits, or
  shutdown;
- exposing raw Page, process environment, stores, or internal managers to
  ordinary extensions;
- hot reload, runtime unload, project auto-execution, automatic online package
  installation, or a marketplace in this architecture line.
