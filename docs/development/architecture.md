# Architecture

[Back to README](../../README.md)

portal coordinates a local Node.js runtime, a real Chromium browser, and one or
more provider conversations. The same thread and runtime services support the
interactive TUI, one-shot `portal exec`, spawned child tasks, and the
inbound Portal MCP Server.

## Component map

| Area          | Main files                                                  | Responsibility                                                                                        |
| ------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Entry points  | `src/index.ts`, `src/cli-entry.ts`, `src/app.ts`            | Select a Surface and invoke bootstrap or recovery commands                                            |
| Host          | `src/host/`, `src/shared/resource-scope.ts`                 | Compose Kernel domain hosts and own startup, rollback, and ordered shutdown                           |
| Extensions    | `src/extensions/`, `src/bootstrap/`                         | Persist enablement and resolve packages, services, contributions, bindings, and Hooks                 |
| Configuration | `src/config/`                                               | Resolve sparse overrides and atomically update `config.yaml`                                          |
| Browser       | `src/platform/`                                             | Launch Chromium, connect over CDP, and own process lifetime                                           |
| Providers     | `src/providers/provider-host.ts`, `src/providers/`          | Resolve Provider bindings in Kernel; implement web communication, login, retry, and codecs in plugins |
| Prompts       | `src/prompts/`                                              | Resolve Prompt renderers in Kernel; own setup document content in plugins                             |
| Agents        | `src/agents/`                                               | Resolve Agent sessions and initialization policy in Kernel; implement policies in plugins             |
| Runtime       | `src/runtime/`                                              | Execute the first-party web Provider session using resolved Agent input                               |
| Threads       | `src/threads/`                                              | Run Conversation/Tool legs, admit operations, and persist conversation metadata                       |
| Tools         | `src/tools/`, `src/processes/`                              | Resolve Tool bindings; plugin packages own execution, process jobs, and management features           |
| Skills        | `src/skills/`                                               | Install and validate Skill directories and snapshot enabled metadata                                  |
| Instructions  | `src/instructions/`                                         | Optionally snapshot the startup directory's `AGENTS.md`                                               |
| Surfaces      | `src/surfaces/`, `src/app/`, `src/exec/`, `src/mcp-server/` | Activate TUI, one-shot exec, and MCP through typed Surface bindings                                   |

The inbound MCP server is Portal's external automation interface.

## Process composition

`PortalHost` under `src/host/` is the shared composition root. `prepare()`
resolves configuration, synchronizes installed first-party records, resolves
one immutable plugin generation, creates Kernel domain hosts, and opens the
Thread store without launching a browser. Disabled packages are not loaded.
Contribution dependencies are resolved transitively, so disabling a Prompt or
Agent contribution also removes only the higher-level contributions that
require it; derived disablement is not persisted.
`start()` invokes lifecycle Hooks and launches Chromium. `close()` first closes
active Surfaces, then Thread admission, Provider/Tool operations, browser
resources, and SQLite in bounded order. Plugin-owned cleanup runs through
scopes and Hooks; `PortalHost` does not construct specific Providers, Tools,
Skills, command jobs, or MCP handlers.

`app.ts` activates graph-resolved TUI and MCP Surfaces. The TUI package owns
the terminal controller, Ink, keybindings, and its Command session.
All in-session built-ins are first-party `commands.collect` contributions. One
resolved plan drives their parsing, help, hints, completion, syntax,
thread-busy admission, and execution. Handlers resolve narrow command services
instead of receiving the terminal controller, stores, managers, or a mutable
application context. `portal exec` activates the batch Surface under
`src/exec/`; its module graph does not load React, Ink, or terminal UI modules.
It creates one inactive agent Thread, sends an inline setup plus task, writes
progress to stderr and the final answer to stdout, records the conversation
URL, then closes the Host. The provider-side conversation remains available for
later resume.

## Setup prompt

`PromptHost` resolves `prompts.collect` contributions and same-owner renderer
bindings. `AgentHost` resolves one effective `agents.collect` contribution for
the requested `agent` or `chat` mode and opens its referenced Prompt in the
same scoped generation. A Provider supplies only its model-facing Tool
presentation when opening the Agent session. Browser Providers use Portal
Action Protocol; API Providers translate native tool calls without receiving
this text protocol. A full browser-provider prompt has this order:

1. `# Portal Prompt`;
2. `## Portal Action Protocol`;
3. `## Actions`;
4. optional `## Skills`;
5. optional `## Project Instructions`;
6. `## Runtime`;
7. `## Initialization`.

Every tool entry contains only its name, description, and parameters. The setup
contains no tool-call examples or provider-specific constraints. Hidden or
disallowed tools are omitted by the registry.

Portal Action Protocol permits at most one terminal
`<action name="NAME">PAYLOAD</action>` block per assistant message. JSON
actions receive an object payload, freeform actions receive raw text, and the
next user message carries the Action Result. Portal internals remain named
Tool, ToolRequest, and ToolResult.

The first-party Prompt plugins own the exact sections and Skill snapshot. The
first-party Agent plugins own READY acceptance, interactive initialization,
and first-input inline policy. TUI agent creation and spawned runtimes submit
the full setup. Chat creation sends only the chat Prompt handshake. `portal
exec` renders the full Prompt with `## Task` in the first provider message.
Resume opens no Agent session because the existing provider conversation
already owns its context.

## Thread lifecycle

`ThreadLifecycleService` owns create, resume, send, cancel, and close admission
for every Surface. Provisioning resolves a Provider contribution and opens a
Kernel `ProviderBinding`. The Provider plugin owns login, Page/session setup,
recovery, and model conversion. `ConversationHost` owns canonical Thread turns
and executes each model response as a Tool loop:

1. submit the current user or Tool Result text;
2. capture the provider response;
3. receive an internal ToolRequest translated by the Provider plugin;
4. validate Tool parameters and host-owned capability and safety rules;
5. execute the tool and send its structured result in the next user message;
6. stop when the provider produces an ordinary assistant response.

Only one operation may own a thread at a time. Different threads may run
concurrently. Closing a provider tab closes only its bound thread; losing the
browser connection shuts down the process.

## Tools and jobs

The first-party Tool packages are `attach_image`, `run_command`, `apply_patch`,
and `spawn`. `ToolHost` resolves executable graph bindings, capabilities,
services, scopes, and finalization. The browser Provider's text codec renders
the compact Action catalog and converts valid text calls into internal
ToolRequests.

`run_command` owns its process-local jobs and management service. Cancelling its
Tool scope stops the process tree. Its `/job` command and MCP Job feature are
contributions from the same package, so all disappear when the package is
disabled. Controlled shutdown stops all managed jobs. Output is bounded before
it is retained or delivered to a Provider.

`spawn` invokes the Kernel child-conversation service. It does not construct a
Provider adapter or child Runtime directly.

## Skills

The `portal.skills` package owns Skill storage and project-instruction loading.
The `portal.prompt.agent` plugin requests one immutable snapshot containing
each enabled Skill's name, sanitized description, and absolute `SKILL.md` path
when its Prompt session opens. Full setup prompts list only that metadata;
manifest bodies and resource files are not injected. There is no `load_skill`
tool or per-turn manual Skill activation. Registry changes affect new Prompt
sessions, not existing snapshots. The separate
`portal.command.skills` package contributes `/skill`; disabling that command or
package does not remove Prompt Skill data from Providers.

## Project instructions

Project Instructions are disabled by default. When enabled, the process reads
only `<startup-cwd>/AGENTS.md`, once, into an immutable snapshot shared by TUI,
exec, spawned, and MCP-created runtimes. It does not inspect ancestors,
nested paths, overrides, Claude files, user-level files, imports, or tool target
paths. Resume does not resend the snapshot to an existing provider conversation.

## Hook-first development

The long-lived Hook-first development line is specified in
[Hook Architecture](hook-architecture.md). It replaces the former
conversation-only automation feature with a host-owned, typed, scoped extension
architecture. The explicit lifecycle and safety rules in that document apply to
the development branch; this overview is updated as each ownership boundary is
implemented.

## Portal MCP Server

`src/mcp-server/` is an inbound Surface package. `/mcp start` creates a
Streamable HTTP server that invokes typed Surface actions. `run_command`
optionally contributes Job management as a Surface feature. `/mcp status`,
`/mcp token`, and `/mcp stop` inspect or control the listener.
Stopping the server cancels MCP-owned operations and closes transports without
cancelling unrelated TUI work.

## Persistence and configuration

`threads.db` stores provider, URL, title, and timestamps, not transcripts.
Provider history remains authoritative and is loaded for display during resume.
Browser login state lives under `<data-dir>/profiles/chromium`. Installed plugin
enablement and grants live under `<data-dir>/plugins/installed.json`. Skill
registry state lives separately under `<data-dir>/state/skills.json`.

Portal accepts only the documented sparse configuration. Skill registry state
is stored separately from user configuration.

## Cancellation and retry

Cancellation propagates through thread operations, adapters, tool calls,
browser startup, and shutdown. Provider errors carry retryability and recovery
metadata. A timeout after submission is treated as an unknown outcome and is
not replayed automatically because the provider may already have accepted it.
Every resource close is bounded so one stalled page or child process cannot
block the complete shutdown sequence indefinitely.
