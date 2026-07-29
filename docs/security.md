# Security

[Back to README](../README.md)

portal intentionally connects an untrusted web model to powerful operations on the local machine. Treat it as a local code-execution agent, not as a sandboxed chat client.

## Security model

Agent threads and spawned runtimes send the web model a textual catalog of available tools. Chat threads send only a minimal `READY` handshake, but their local runtime still registers tools, Skills, MCP connections, and Hooks. In every mode, when a model response contains a valid tool request, portal executes that request and sends the result back to the same web conversation. Chat mode is therefore not a sandbox or a permission boundary. Setup prompts, enabled project instructions, ordinary user input, MCP attachments, loaded Skill instructions, tool results, and selected local images can all cross the provider boundary.

There is currently no human approval gate between a valid model-generated request and local execution. The effective permissions are the permissions of the user account running portal.

Provider output, repository-owned project instructions, loaded Skill instructions, MCP content, and resumed conversation history are untrusted input. Any of them can contain prompt injection intended to trigger local tools or disclose data.

The Tool protocol extractor is intentionally text-based rather than
Markdown-aware. A complete `<tool>...</tool>` block at the textual end of a
model response is treated as a Tool request even when the surrounding response
was intended as an unclosed code example. The local, high-trust operating model
therefore relies on the Provider model following the Tool protocol; Markdown
formatting is not an execution boundary.

## Powerful operations

| Tool            | Security impact                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `run_command`   | Runs arbitrary commands through the platform's available shell; an omitted timeout means no tool-level timeout |
| `apply_patch`   | Creates or modifies UTF-8 files with V4A patches; paths are not confined to the repository                     |
| `attach_image`  | Sends a selected local image and its contents to the active provider website                                   |
| `spawn`         | Starts another provider conversation with local tools, a Skill snapshot, and fresh MCP connections             |
| `load_skill`    | Adds third-party instructions and local resource paths to the provider conversation                            |
| `mcp_call_tool` | Invokes operations exposed by a configured MCP server with that server's effective permissions                 |

`mcp_search_tool` only returns a cached Tool definition, but the definition itself is untrusted text. User-selected MCP Resources and Prompts are submitted as complete user turns and can also influence later tool use.

## Isolation and cancellation limits

- portal does not confine tools to the repository or current working directory.
- `apply_patch` limits operations to regular UTF-8 files and refuses move/delete operations, but those checks are not a filesystem sandbox.
- `run_command` output is bounded, but command side effects are not. A call without `timeoutMs` has no tool-level timeout.
- Spawn recursion is bounded by `advanced.runtime.spawnDepthLimit`, which defaults to five child levels. The limit does not bound sequential sibling tasks, concurrent root threads, or other Tool calls.
- Cancelling a turn with Ctrl+C does not stop its `run_command` process. Inspect active jobs with `/job` and stop a specific job with `/job stop <job-id>`; controlled portal shutdown stops all managed jobs.
- `/job` displays a sanitized command summary and working directory. Avoid putting credentials directly in command arguments.
- Job tracking is process-local and is not persisted. A forcibly terminated portal process, or a command that deliberately escapes its process group or Windows Job Object, may leave descendants running.
- Ctrl+C propagates cancellation where supported, but cancellation cannot prove that an external process, provider request, or MCP operation had no side effects.
- An MCP timeout or connection loss after dispatch is reported as an unknown outcome and must not be retried automatically.

## Recommended use

- Run portal only inside a repository or workspace you are prepared to modify.
- Keep work under version control and inspect `git status` and diffs regularly.
- Use backups for files that cannot be reproduced.
- Do not keep unrelated credentials, private keys, tokens, or sensitive documents in the working directory.
- Run portal as a normal user, never as Administrator or root unless the task absolutely requires it.
- Use a dedicated browser profile and provider account where practical.
- Do not expose the browser's remote debugging port to an untrusted network.
- Stop the current operation with Ctrl+C if model behavior becomes unexpected.
- Review `AGENTS.md`, `CLAUDE.md`, and imported/rule files before enabling local project instructions.
- Review a skill's `SKILL.md` and resources before registering, downloading, or enabling it.
- Review an MCP server and its configuration before adding or enabling it.
- Prefer environment placeholders over literal secrets in outbound MCP and inbound listener Token configuration.
- Keep API and Portal MCP Server listeners on loopback unless remote access is intentional; use a tunnel or TLS proxy when crossing an untrusted network.

## Browser and account data

The dedicated browser profile lives at `browser.profilePath` from `data/config.yaml`. Browser path fields accept absolute or relative values: generated defaults are absolute, while configured relative values resolve from portal's working directory. The profile can contain login cookies, local storage, and other account state. The default directory is ignored by Git, but it is still sensitive local data.

`data/threads.db` stores provider conversation URLs and metadata. Those URLs may expose private conversation identifiers when combined with an authenticated browser session. It does not store transcripts or a persistent local Tool audit trail. The provider website remains the source of conversation content; local turns and rendered timelines live only for the current process and can grow with a long-running session.

On POSIX systems, Portal restricts its managed config and lock directories, the
configured browser profile root, and the thread database directory to mode
`0700`. Managed config, lock, database, and existing SQLite sidecar files use
mode `0600`. Portal repairs broader modes on those paths when it opens them, but
does not recursively change browser-owned profile contents. On Windows, access
continues to follow inherited filesystem ACLs.

Resume reads provider history into the terminal's in-memory timeline. The repository's ignored top-level `temp/` directory may also contain response captures, screenshots, or probe output created during provider development.

Do not publish or attach `data/`, browser profiles, raw captures, screenshots, or private conversation URLs to bug reports. Removing a capture from the current tree does not remove it from existing Git history, clones, forks, or caches. If sensitive content enters Git history, invalidate the related sessions or credentials first, then coordinate a history rewrite and replacement of affected clones before redistributing the repository.

## Project instructions

Codex and Claude Code instruction sources are disabled by default. When enabled,
portal reads configured global and project-local files and includes applicable
text in Provider conversations. Nested directory instructions and Claude path
rules can also be activated before supported file-targeting tool calls.

These files are repository-controlled input, not trusted policy. They can ask
the model to read files, run commands, modify paths outside the repository, or
send additional content to external systems. Loader path, symlink, import,
size, and file-count checks limit what portal reads, but they do not make the
instructions safe. Keep secrets out of instruction files and leave local
sources disabled for repositories you have not reviewed. See
[Project Instructions](instructions.md).

## Skill installation

Skills may be registered from local directories or downloaded from direct web URLs, GitHub paths, archives, and Hub-compatible registries. Validation applies size limits, rejects path traversal and symbolic links, and checks manifest structure, but these checks do not establish trust.

The current skills system does not provide:

- package signatures;
- publisher verification;
- a curated trust registry;
- dependency isolation;
- an instruction sandbox.

Treat remote skill installation like downloading code. Inspect the source and prefer pinned, trusted locations. The current local-first trust model is explicit user review of trusted sources; Portal does not attempt to establish third-party package provenance or isolate untrusted Skill instructions.

## MCP servers and secrets

Stdio MCP servers run as local child processes with the portal user's permissions. Streamable HTTP servers receive configured URLs and headers. Either kind can read data supplied to it and can expose tools with arbitrary side effects.

Environment placeholders reduce the need to store literal secrets in `config.yaml`, and portal redacts resolved values from known outbound MCP error paths. Inbound listener Token placeholders are resolved only when a listener starts, and `/serve` reports authentication state without printing either configured or resolved values. Redaction is defense in depth, not a guarantee: a server can return secrets as ordinary Tool content, and a command or provider page can expose them through another path.

Review the server implementation, pin the executable or endpoint where practical, grant only the credentials it needs, and treat Resources, Prompts, schemas, and Tool results as untrusted content.

## Inbound API and MCP listeners

The HTTP API and Portal MCP Server each have independent `host`, `port`, and
`token` settings. `null` and the exact empty string disable authentication only
when `host` is exactly `127.0.0.1`; every other host requires an enabled Token
or the listener refuses to start. Every other Token string is preserved
exactly, including whitespace-only values.
Token strings may contain `${env:VARIABLE_NAME}` placeholders. They remain
unexpanded in the configuration file and are resolved for each listener start;
a missing variable fails before the listener binds.

API access includes thread, Skill, capability, outbound MCP configuration, and
active command-job operations. Portal MCP Server access can send instructions
to a logged-in provider conversation, whose model can invoke local Portal
tools, and can also list or stop active command jobs. Job summaries expose the
command and working directory, which may themselves contain sensitive values.
Either listener therefore exposes high-privilege local and browser-account
capabilities even when authenticated.

Selecting `mode: "chat"` when creating a thread does not reduce those listener
permissions or disable model-generated tool execution.

Bearer authentication does not encrypt HTTP traffic. On an untrusted network,
an observer may capture Tokens, prompts, assistant output, and conversation
URLs. Use loopback with an SSH tunnel, a TLS reverse proxy, or a trusted isolated
network. The MCP Server rejects requests carrying an `Origin` header, but this
DNS-rebinding control is not authentication.

The listeners are intended for a small number of operator-controlled clients,
not as public multi-tenant services. They do not provide deployment-scale
connection quotas, tenant isolation, or a general admission layer. Configure
finite request timeouts and external proxy limits when using a listener for
long-running or remote integrations.

## Provider policies

portal automates real provider websites. Provider terms, automation policies, rate limits, and UI behavior can change independently of this project. Users are responsible for ensuring that their use complies with the relevant provider's terms and local law.

## Reporting a vulnerability

Avoid posting credentials, browser profiles, private conversation URLs, or working exploit details in a public issue. If the repository offers a private security-reporting channel, use it. Otherwise, open a minimal issue asking the maintainers for a private contact method without including sensitive details.
