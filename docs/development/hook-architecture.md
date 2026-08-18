# Hook-first architecture

[Back to README](../../README.md)

Status: accepted for the `next/hook-first` development line. This document
describes the implemented extension and domain-host boundary. It is a
breaking-change line; compatibility shims are not part of the contract.

## Charter

Product capabilities are contributions. Lifecycle, ordering, resource
ownership, cancellation, validation, authorization, and canonical state
commit remain Kernel responsibilities.

The graph is a composition mechanism, not a second application runtime. A
contribution declares its owner, identity, required services, required
capabilities, and executable binding. The Kernel resolves one immutable
generation and activates only the selected bindings.

The project has one plugin loading path: direct Node ESM loading. Installation
records carry source, digest, enablement, contribution selection, dependencies,
and capability grants. There is no alternate runtime mode or loader ABI in
this contract. A package that executes code is already an explicitly granted
in-process package; the graph still limits what its contributions can resolve.

## Package and contribution boundaries

A package is the install, identity, version, dependency, trust, enablement,
and lifecycle unit. A package may contribute several independent capabilities.
Each declared contribution can be enabled or disabled by its point and ID.
Disabling a package removes all of its contributions. Disabling a dependency
removes dependent packages from the effective graph and reports a typed
`disabled-dependency` diagnostic.

A contribution may also declare exact contribution dependencies by package,
point, ID, and contract version. Bootstrap computes their transitive effective
disablement without writing derived state back to the installed snapshot. This
lets one optional capability in a multi-contribution package disappear together
with only the higher-level contributions that require it; re-enabling the base
contribution restores that closure in the next generation.

The persisted installed snapshot is the source of truth for the next
generation. Kernel bootstrap synchronizes bundled records, resolves the
effective graph, and only then loads selected modules. Disabled or invalid
packages are not instantiated. A disabled package may still be diagnosed by
the recovery CLI.

Registration is synchronous and transactional. A package module may only
register contributions declared by its manifest. Undeclared, duplicate, or
missing contributions fail bootstrap. Executable bindings must target a
declared contribution, use the expected kind, and obey the ownership rule of
that contribution point.

The `PluginManager` owns persistence operations. It updates the store
atomically, hashes the complete package directory, rejects symlinks, keeps
capability grants narrower than manifest declarations, and refuses to remove
an installed package while another installed package declares it as a
dependency. Recovery operations such as store repair remain outside the
normal in-session command service.

## Kernel responsibilities

The Kernel owns the small set of cross-domain invariants that must be the same
for every implementation:

- plugin store snapshots, graph resolution, capability grants, and generation
  identity;
- `ResourceScope`, `AbortSignal`, deadlines, cancellation, reverse cleanup,
  late settlement observation, and aggregate cleanup errors;
- Provider selection and binding resolution through `ProviderHost`;
- Conversation turn state, Tool-loop admission, canonical commit, and final
  result delivery through `ConversationHost`;
- Tool selection, ToolHost execution, required capability checks, output
  limits, and finalizers;
- typed command invocation through `CommandHost`;
- typed Surface activation, feature authorization, projections, and close;
- immutable thread, turn, operation, and host projections.

The Kernel does not own provider-specific login or retry policy, browser
selectors, JobManager, child processes, shell details, attachment file paths,
TUI parsing, or MCP protocol objects.

## Provider boundary

Provider driving is a Kernel domain capability. `ProviderHost` owns the common
protocol:

1. resolve a graph Provider contribution and same-owner binding;
2. authorize the binding's narrow services and capabilities;
3. create one scoped outbound exchange for each leg;
4. consume Provider events and terminal completion in one ordered contract;
5. propagate cancellation and timeout, observe late handles, and close scopes;
6. expose the normalized completion to `ConversationHost`.

The Provider package owns its communication implementation: API or Page
transport, login and waiting, session and response association, model parameter
conversion, Provider-specific recovery, and attachment upload. It receives
only declared narrow services such as the browser session facade, Tool runtime,
or authorized AttachmentReader. It never exposes a raw `BrowserContext`, Page,
local attachment path, or `ProviderAdapter` to the rest of the Kernel.

The internal contract uses `ProviderContribution`, `ProviderBinding`,
`ProviderOutboundLeg`, `ProviderEvent`, and `ProviderCompletion`. Provider IDs
are strings from the resolved graph; there is no closed Provider union or
static Provider catalog.

The web Provider chooses the shared text `Portal Action Protocol` and converts
its `<action name="...">...</action>` messages into internal Tool requests.
Action results are returned in the next user message. API Providers do not see
that prompt or parser; they adapt their own native tool-call format to the
same internal Tool request/result contract.

## Conversation, Prompt, Skill, and Agent

`ConversationHost` owns the user-intent-to-turn state machine:

```text
user intent -> ProviderHost.exchange -> events/completion
            -> ToolHost loop -> canonical turn commit
```

It does not implement Provider login, page recovery, generic retry, or model
protocol conversion. `PromptHost` resolves `prompts.collect` and same-owner
renderer bindings. `AgentHost` resolves `agents.collect`, verifies that its
referenced Prompt is active, and owns the scoped Agent session. Prompt sections,
Skill content, READY acceptance, interactive initialization, and inline-first-
task policy are first-party plugin behavior. `RuntimeCore` consumes only the
resolved Agent session and no longer imports a setup Prompt builder. A web
Provider may add a Provider-private runtime for its text Tool codec and retry
loop, but that implementation is not part of the Kernel RuntimeCore contract.

Prompt, Agent, and Skill contributions can be disabled independently from
their commands or tools. Disabling a Prompt package disables dependent Agent
packages; disabling only a Prompt contribution removes referencing Agents from
the effective Agent catalog and transitively removes the exec and spawn
contributions that require the default Agent. A Skill package does not gain a
broad Runtime or Host object merely because its content is included in a
prompt.

## Tool and attachment boundary

Portal terminology remains `Tool`, `ToolHost`, `ToolRequest`, and `ToolResult`.
Tools enter the graph through `tools.collect` and execute through a same-owner
binding. There is no `DEFAULT_TOOLS`, Kernel-owned RuntimeCore Tool loop, or
wide Provider/Runtime/Browser service passed to a Tool. A Provider-private
text protocol may use the resolved ToolHost through its narrow runtime service;
it does not create a second Kernel execution path.

`run_command` owns its JobManager, process tree, output capture, timeout, stop,
list, command contribution, MCP management feature, and shutdown. The Kernel
provides scope and cancellation timing only. Disabling the package removes
the Tool, `/job`, and MCP Job features in the same generation.

`attach_image` owns file storage and cleanup. The domain contract retains an
opaque `AttachmentRef`; Providers receive an authorized reader and never a
filesystem path. `spawn` uses the typed child-conversation service and cannot
create an untracked Runtime or bypass graph grants.

## Commands and Surfaces

`CommandHost` resolves typed command contributions, routes, options, handlers,
required services, and capabilities. A Command receives a narrow port, not a
Manager, RuntimeCore, Provider adapter, Browser object, or mutable application
context. Its route projection removes disabled Agent modes from parsing, help,
completion, and the Surface command catalog. `/plugins` is a plugin-owned
command and delegates to the typed PluginManagementService. The recovery
`portal plugins` CLI remains available when the normal graph cannot start.

The common Surface contract contains only typed user actions, immutable domain
projections, operation status/result, event subscription, and close. TUI,
batch exec, and MCP are first-party Surface packages resolved through
`SurfaceHost`:

- TUI owns tokenizer, hints, completion, presentation, and terminal input.
- exec owns one-input execution and returns the final result without exposing
  an internal Command ID.
- MCP owns the listener, protocol objects, message operations, and foreground
  cancellation.

MCP Job management is an optional feature contributed by `run_command`; it is
not a `SurfacePort` method. No Surface imports ThreadManager,
ThreadLifecycleService, ProviderAdapter, RuntimeCore, BrowserContext, or
JobManager.

`PortalHost` is the composition root. It starts Kernel resources, resolves the
graph, creates domain hosts, binds late platform services, activates the entry
Surface, and closes active Surfaces before the remaining Kernel resources. It
does not construct individual Providers, Tools, Skills, Jobs, or MCP handlers.

## Lifecycle and failure semantics

Every activation and operation has one owner and one scope. Cancellation wins
the delivery decision even when an extension handler settles later. Late
settlement is observed and its cleanup is registered with the owning scope.
Cancellation, `stop`, `close`, and scope disposal failures are surfaced to
the operation caller or aggregated during shutdown. A successful result never
silently hides a cleanup failure.

An operation is committed exactly once. Provider completion cannot overtake a
later Tool request in the same event contract, and a canceled Tool cannot
start a subsequent Provider leg. Shutdown waits for pending Surface activation
and allows a failed Surface close to be retried.

## Architecture tests and delivery contract

Architecture tests reject these regressions:

- static Provider IDs/catalogs, `DEFAULT_TOOLS`, or product-specific Host
  registration paths;
- Surface imports of concrete Managers, adapters, Browser objects, Runtime,
  or Job services;
- PortalHost construction of a bundled Provider, Tool, Skill, Job, or MCP
  handler;
- arbitrary ServiceRef resolution instead of contribution-declared grants;
- undeclared or disabled contributions reaching a resolved graph;
- unobserved cancellation, close, or late-settlement rejections.

The implementation is complete only when type, lint, format, unit, coverage,
package, cross-platform, and browser lifecycle checks pass. Package smoke must
exercise the built artifact and persisted plugin enablement. A new Provider,
Tool, Skill, Command, or Surface must be addable or removable by package
records and declarations without editing PortalHost or the relevant Domain
Host.
