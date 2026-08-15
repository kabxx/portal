# Architecture

[Back to README](../../README.md)

portal coordinates a local Node.js runtime, a real Chromium browser, and one or
more provider conversations. The same thread and runtime services support the
interactive TUI, one-shot `portal exec`, spawned child tasks, and the
inbound Portal MCP Server.

## Component map

| Area          | Main files                                                    | Responsibility                                                                                     |
| ------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Entry points  | `src/index.ts`, `src/cli-entry.ts`, `src/app.ts`, `src/exec/` | Dispatch the TUI or headless command and compose its surface                                       |
| Host          | `src/host/`, `src/shared/resource-scope.ts`                   | Compose shared process services and own startup, rollback, and ordered shutdown                    |
| Extensions    | `src/extensions/`, `src/cli-commands/core/`                   | Resolve typed contributions, services, lifecycle Hooks, and Commands into one immutable generation |
| Configuration | `src/config/`                                                 | Resolve sparse overrides and atomically update `config.yaml`                                       |
| Browser       | `src/platform/`                                               | Launch Chromium, connect over CDP, and own process lifetime                                        |
| Providers     | `src/providers/`                                              | Implement page readiness, submission, response capture, models, capabilities, and history          |
| Runtime       | `src/runtime/`                                                | Render setup prompts, initialize conversations, run the tool loop, retry, and cancel               |
| Threads       | `src/threads/`                                                | Admit create/resume/send/close operations and persist conversation metadata                        |
| Tools         | `src/tools/`, `src/processes/`                                | Advertise and validate tools, execute them, stream progress, and track command jobs                |
| Skills        | `src/skills/`                                                 | Install and validate Skill directories and snapshot enabled metadata                               |
| Instructions  | `src/instructions/`                                           | Optionally snapshot the startup directory's `AGENTS.md`                                            |
| TUI           | `src/terminal-ui/`, `src/cli-commands/`                       | Render timelines, edit input, and dispatch slash commands                                          |
| MCP Server    | `src/mcp-server/`, `src/app/app-mcp-handlers.ts`              | Expose selected thread and job operations over Streamable HTTP MCP                                 |

The inbound MCP server is Portal's external automation interface.

## Process composition

`PortalHost` under `src/host/` is the shared composition root for the TUI and
`portal exec`. `prepare()` resolves configuration, initializes the Skill and
project-instruction snapshots, and opens the Thread store without launching a
browser. It also synchronously registers and freezes the internal extension
generation. `start()` invokes the Portal activation Hooks, launches Chromium,
and constructs the shared Thread lifecycle and Runtime factory. `close()` first
closes Thread admission, invokes the shutdown Hook, waits for provisioning to
settle, then cancels operations and closes jobs, Threads, browser resources,
and SQLite in a bounded order. Terminal `portal.stopped` runs after core
resources close and before extension activation resources and the Portal root
are released. `ResourceScope` owns startup rollback and late-arriving
resources; it does not replace this domain shutdown sequence.

The TUI in `app.ts` adds only surface resources: the terminal controller, Ink,
keybindings, a Host-owned Command session, and the optional inbound MCP Server.
All in-session built-ins are first-party `commands.collect` contributions. One
resolved plan drives their parsing, help, hints, completion, syntax,
thread-busy admission, and execution. Handlers resolve narrow command services
instead of receiving the terminal controller, stores, managers, or a mutable
application context. The TUI's single shutdown coordinator stops its surface
resources around `PortalHost.close()`.
`portal exec` uses the same Host through a UI-independent facade under
`src/exec/`; its module graph does not load React, Ink, or terminal UI modules.
It creates one inactive agent Thread, sends an inline setup plus task, writes
progress to stderr and the final answer to stdout, records the conversation
URL, then closes the Host. The provider-side conversation remains available for
later resume.

## Setup prompt

`src/runtime/setup-prompt.ts` is the single renderer for setup documents. The
full TUI/spawned-agent prompt has this fixed order:

1. `# Portal Agent`;
2. `## Tool Protocol`;
3. `## Tools`;
4. optional `## Skills`;
5. optional `## Project Instructions`;
6. `## Runtime`;
7. `## Initialization`.

Every tool entry contains only its name, description, and parameters. The setup
contains no tool-call examples or provider-specific constraints. Hidden or
disallowed tools are omitted by the registry.

The Tool Protocol permits at most one terminal tool block per assistant
message. JSON tools receive an object payload, freeform tools receive raw text,
and the next user message carries the Tool Result.

TUI agent creation and spawned runtimes submit the full setup and require a
case-insensitive whole-word `READY` response. Chat creation sends only the
shared initialization handshake. `portal exec` replaces Initialization with
`## Task`, so setup and the first task are submitted in one provider message.
Resume sends no setup because the existing provider conversation already owns
its context.

## Thread lifecycle

`ThreadLifecycleService` owns create, resume, send, cancel, and close admission
for every surface. A provision operation reserves the conversation identity,
creates an adapter and runtime, waits for login when necessary, records the
conversation URL, and commits the thread only after initialization succeeds.
Failures clean up partially created adapters, pages, registry claims, and
pending UI state.

The runtime executes a model response as a tool loop:

1. submit the current user or Tool Result text;
2. capture the provider response;
3. treat a single complete `<tool name="NAME">PAYLOAD</tool>` at the textual end
   as a tool request;
4. validate Tool parameters and host-owned capability and safety rules;
5. execute the tool and send its structured result in the next user message;
6. stop when the provider produces an ordinary assistant response.

Only one operation may own a thread at a time. Different threads may run
concurrently. Closing a provider tab closes only its bound thread; losing the
browser connection shuts down the process.

## Tools and jobs

The default agent tool set is `attach_image`, `run_command`, `apply_patch`, and
`spawn`. `ToolRegistry` renders the compact catalog, parses calls, validates
input, and rejects calls to hidden or unavailable tools.

`run_command` jobs are process-local. A cancelled turn detaches its waiter but
does not automatically terminate the command. The TUI and MCP Server share the
same job manager; controlled shutdown stops all managed jobs. Output is bounded
before it is retained or delivered to a provider.

`spawn` creates a temporary child conversation in the existing browser context,
uses the same Skill and project-instruction snapshots, enforces the fixed depth
limit, runs one task, returns its provider URL and output, and closes the child
runtime.

## Skills

The Skill library snapshots each enabled Skill's name, sanitized description,
and absolute `SKILL.md` path when a runtime is created. Full setup prompts list
only that metadata; manifest bodies and resource files are not injected. There
is no `load_skill` tool or per-turn manual Skill activation. Registry changes
affect new runtimes, not existing snapshots.

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

`src/mcp-server/` is an inbound integration surface. `/mcp start` creates a
Streamable HTTP server backed directly by the shared thread lifecycle and job
manager. `/mcp status`, `/mcp token`, and `/mcp stop` inspect or control it.
Stopping the server cancels MCP-owned operations and closes transports without
cancelling unrelated TUI work.

## Persistence and configuration

`threads.db` stores provider, URL, title, and timestamps, not transcripts.
Provider history remains authoritative and is loaded for display during resume.
Browser login state lives under `<data-dir>/profiles/chromium`. Skill registry
state lives separately under `<data-dir>/state/skills.json`.

Portal accepts only the documented sparse configuration. Skill registry state
is stored separately from user configuration.

## Cancellation and retry

Cancellation propagates through thread operations, adapters, tool calls,
browser startup, and shutdown. Provider errors carry retryability and recovery
metadata. A timeout after submission is treated as an unknown outcome and is
not replayed automatically because the provider may already have accepted it.
Every resource close is bounded so one stalled page or child process cannot
block the complete shutdown sequence indefinitely.
