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

- A **HookRef** is an opaque, typed reference exported by Portal. Extensions do
  not create global Hook names by writing arbitrary strings.
- A **HookSpec** defines one Hook's input, output, mode, execution policy,
  scope, deadline, failure policy, capabilities, redaction, and stability.
- A **Handler** implements one HookSpec and belongs to one Extension.
- A **Contribution** is immutable registration-time data such as a Command,
  Tool, Provider, Prompt section, or Surface.
- An **Extension** owns handlers, contributions, configuration, state,
  capabilities, diagnostics, and disposables.
- A **ResourceScope** owns resources created for a Portal, session, browser,
  page, thread, runtime, turn, command, or tool operation.
- A **SafetyFinalizer** is kernel code that runs after extension transforms and
  cannot be replaced, reordered, or skipped by an extension.

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

TUI, `portal exec`, and the MCP Server use the same PortalHost composition.
HostProfile controls which Surfaces are activated; it does not create a second
kernel or resource graph.

## Resource tree

```text
portal
└── session
    ├── browser
    │   └── context
    │       └── page
    └── thread
        └── runtime
            └── turn
                ├── command
                └── tool
```

A child scope inherits only immutable parent services. Child contributions do
not leak into parents or siblings. Every registration that creates a listener,
timer, page, process, transport, or other resource must return a Disposable and
bind it to its ResourceScope.

Scope disposal is idempotent, asynchronous, deadline-bound, and reverse-order.
One failing disposer does not prevent the remaining disposers from running.
Startup activation occurs in a temporary child scope: success commits the
scope, while failure rolls it back. Cleanup errors are aggregated without
discarding the original operation error.

## Hook modes

Each HookRef has exactly one result mode. A Handler cannot choose how its Hook
is dispatched.

| Mode        | Semantics                                                                |
| ----------- | ------------------------------------------------------------------------ |
| `observe`   | All handlers receive immutable input; results are ignored.               |
| `collect`   | Handlers return contributions; the host validates and freezes the set.   |
| `first`     | The first explicit `handled` result wins; truthy values are not signals. |
| `waterfall` | Handlers return patches applied serially with validation after each.     |
| `guard`     | Decisions are combined with deny-overrides semantics.                    |
| `around`    | A restricted handler may invoke `next()` exactly once or short-circuit.  |

Execution policy is separate from result mode. Read-only observers may run in
parallel. Collect, first, waterfall, guard, around, activation, and cleanup are
serial unless the HookSpec explicitly proves independence. Generic loop Hooks
are forbidden; retries belong to bounded domain state machines.

`around` is not part of the first kernel slice and is never allowed to wrap or
skip authentication, final validation, resource ownership, cancellation, or
shutdown. Command and Tool pipelines prefer explicit transform, guard,
finalize, execute, result-transform, and observe stages.

## Type and runtime contract

```ts
interface HookRef<Input, Output, Mode extends HookMode> {
  readonly key: symbol
  readonly id: HookId
  readonly version: number
  readonly mode: Mode
}

interface HookInvocationContext {
  readonly extensionId: ExtensionId
  readonly generation: string
  readonly scope: ResourceScopeView
  readonly signal: AbortSignal
  readonly deadline: number
  readonly traceId: string
}

type HookHandler<Input, Output> = (
  input: Readonly<Input>,
  context: HookInvocationContext
) => Promise<Output>
```

Hook input is one frozen object, never a positional argument list or shared
mutable context. Compatible Hook versions may add optional input properties.
Outputs use explicit `Patch`, `Decision`, `Handled`, or `Contribution` types.
TypeScript types are backed by runtime schemas at every external boundary.

Unknown HookRefs, duplicate Handler IDs, duplicate contribution IDs, missing
capabilities, invalid schemas, dependency cycles, and post-freeze registration
fail during resolution. Registration is transactional: a rejected Extension
leaves no partial handlers or contributions.

## Ordering

Resolved order is deterministic:

```text
kernel pre-phase
-> extension dependency topology
-> explicit before/after edges
-> stable extension and handler ID tie-break
-> kernel SafetyFinalizer
```

Numeric priorities, installation order, filesystem enumeration order, and
implicit last-wins replacement are forbidden. A missing before/after target or
an ordering cycle is a resolution error. Kernel finalizers are not addressable
ordering targets.

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

| Capability        | Contribution point        |
| ----------------- | ------------------------- |
| Slash commands    | `commands.collect`        |
| Root CLI commands | `cli.commands.collect`    |
| Prompt sections   | `prompt.sections.collect` |
| Tools             | `tools.collect`           |
| Providers         | `providers.collect`       |
| Skill sources     | `skillSources.collect`    |
| TUI, exec, MCP    | `surfaces.collect`        |

Resolved contributions drive execution, help, completion, diagnostics, and
tests. Duplicate names fail. Replacing a built-in requires explicitly disabling
that contribution before registering a replacement; silent shadowing is not
supported.

Prompt contributions use named slots and dependency edges, not arbitrary
numeric priority. Mandatory Tool protocol, initialization handshake, and final
prompt validation remain kernel invariants. Tool contributions own metadata,
input schema, capability requirements, and an executor factory; the kernel owns
parsing, final validation, cancellation, output limits, and result delivery.

## Hook Atlas

The Atlas is the review boundary for extensibility. New HookRefs require an
update here before implementation. `experimental` HookRefs may change within
the development line. A stable public HookRef changes only compatibly; changed
semantics require a new ID or version.

| Hook ID                         | Mode      | Scope   | Owner                   | Stability    |
| ------------------------------- | --------- | ------- | ----------------------- | ------------ |
| `portal.beforeStart`            | observe   | portal  | PortalHost              | experimental |
| `portal.ready`                  | observe   | portal  | PortalHost              | experimental |
| `portal.beforeStop`             | observe   | portal  | PortalHost              | experimental |
| `portal.stopped`                | observe   | portal  | PortalHost              | experimental |
| `commands.collect`              | collect   | portal  | CommandRegistry         | experimental |
| `command.beforeExecute`         | guard     | command | CommandExecutor         | experimental |
| `command.executed`              | observe   | command | CommandExecutor         | experimental |
| `command.failed`                | observe   | command | CommandExecutor         | experimental |
| `cli.commands.collect`          | collect   | portal  | CLI bootstrap           | experimental |
| `prompt.sections.collect`       | collect   | runtime | PromptCompiler          | experimental |
| `tools.collect`                 | collect   | runtime | ToolRegistry            | experimental |
| `providers.collect`             | collect   | portal  | ProviderRegistry        | experimental |
| `skillSources.collect`          | collect   | portal  | SkillSourceRegistry     | experimental |
| `surfaces.collect`              | collect   | portal  | SurfaceRegistry         | experimental |
| `browser.beforeLaunch`          | waterfall | browser | BrowserHost             | experimental |
| `browser.launched`              | observe   | browser | BrowserHost             | experimental |
| `browser.beforeClose`           | observe   | browser | BrowserHost             | experimental |
| `browser.closed`                | observe   | browser | BrowserHost             | experimental |
| `context.beforeCreate`          | waterfall | context | BrowserHost             | experimental |
| `context.created`               | observe   | context | BrowserHost             | experimental |
| `context.beforeClose`           | observe   | context | BrowserHost             | experimental |
| `context.closed`                | observe   | context | BrowserHost             | experimental |
| `page.beforeCreate`             | waterfall | page    | PageService             | experimental |
| `page.created`                  | observe   | page    | PageService             | experimental |
| `page.beforeClose`              | observe   | page    | PageService             | experimental |
| `page.closed`                   | observe   | page    | PageService             | experimental |
| `thread.provisioning`           | observe   | thread  | ThreadLifecycleService  | experimental |
| `provider.authRequired`         | observe   | thread  | AuthCoordinator         | experimental |
| `provider.authenticated`        | observe   | thread  | AuthCoordinator         | experimental |
| `provider.ready`                | observe   | thread  | ProviderDriver          | experimental |
| `conversation.beforeInitialize` | waterfall | runtime | ConversationInitializer | experimental |
| `conversation.initialized`      | observe   | runtime | ConversationInitializer | experimental |
| `thread.ready`                  | observe   | thread  | ThreadLifecycleService  | experimental |
| `thread.provisionFailed`        | observe   | thread  | ThreadLifecycleService  | experimental |
| `message.beforeSubmit`          | waterfall | turn    | RuntimeCore             | experimental |
| `message.submitted`             | observe   | turn    | RuntimeCore             | experimental |
| `message.responseCaptured`      | observe   | turn    | RuntimeCore             | experimental |
| `turn.started`                  | observe   | turn    | ThreadManager           | experimental |
| `turn.completed`                | observe   | turn    | ThreadManager           | experimental |
| `turn.failed`                   | observe   | turn    | ThreadManager           | experimental |
| `tool.inputTransform`           | waterfall | tool    | ToolExecutor            | experimental |
| `tool.guard`                    | guard     | tool    | ToolExecutor            | experimental |
| `tool.executed`                 | observe   | tool    | ToolExecutor            | experimental |
| `tool.failed`                   | observe   | tool    | ToolExecutor            | experimental |
| `spawn.started`                 | observe   | runtime | SpawnService            | experimental |
| `spawn.completed`               | observe   | runtime | SpawnService            | experimental |
| `spawn.failed`                  | observe   | runtime | SpawnService            | experimental |

The Atlas intentionally describes domain transitions rather than generic
`beforeStateChange` or `all` events. Provider login detection, readiness,
submission, retry, and response capture remain methods on a ProviderDriver and
their owning state machines. Hook handlers observe or transform their stable
inputs; they do not choose arbitrary next states.

## Extension trust and storage

External extension loading is explicit. Portal does not scan a project and run
code merely because a file exists. A manifest declares a namespaced ID, version,
Portal and Hook API ranges, entry point, contributions, dependencies,
capabilities, trust requirement, and configuration schema.

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
- defaults remain in Extension code;
- an Extension cannot rewrite Portal's root configuration directly.

Project-local executable extensions remain disabled until Portal has an
explicit workspace trust design. Online installation, package lifecycle
scripts, automatic dependency installation, and a marketplace are outside this
architecture line.

## Test strategy

The kernel has backend-neutral contract tests for every mode and policy:

- transactional registration, duplicate detection, and graph freezing;
- deterministic dependency and before/after ordering;
- collect conflicts, first-result handling, waterfall validation, and guard
  deny-overrides behavior;
- cancellation, per-handler deadline, late parallel settlement, and redaction;
- activation rollback, reverse disposal, idempotence, deadline, and aggregate
  cleanup errors;
- finalizer execution after every external transform and guard;
- trace ownership and stable generation snapshots.

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
3. every first-party Command, Prompt section, Tool, Provider, Skill source, and
   Surface is resolved through its contribution registry;
4. Browser, Context, and Page creation have one owner and no bypass path;
5. the Atlas HookPoints are connected to explicit domain state machines with
   final validation and rollback;
6. explicit external Extension discovery, trust, configuration, state, secret,
   diagnostics, and testing are complete;
7. type, lint, format, unit, coverage, package, audit, browser lifecycle, and
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
- handlers that can bypass authentication, final validation, limits, or
  shutdown;
- exposing raw Page, process environment, stores, or internal managers to
  ordinary extensions;
- hot reload, runtime unload, project auto-execution, automatic online package
  installation, or a marketplace in this architecture line.
