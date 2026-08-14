# Security

[Back to README](../README.md)

portal intentionally connects an untrusted web model to powerful operations on the local machine. Treat it as a local code-execution agent, not as a sandboxed chat client.

## Security model

Agent threads, spawned runtimes, and `portal exec` send the web model a textual catalog of available tools. Chat threads send only a minimal `READY` handshake, but their local runtime still registers tools, Skills, and Hooks. In every mode, when a model response contains a valid tool request, portal executes that request and sends the result back to the same web conversation. Chat mode is therefore not a sandbox or a permission boundary. Setup prompts, enabled project instructions, ordinary user input, Skill metadata and files read by the model, tool results, and selected local images can all cross the provider boundary.

There is currently no human approval gate between a valid model-generated request and local execution. The effective permissions are the permissions of the user account running portal.

Provider output, repository-owned project instructions, Skill instructions, and resumed conversation history are untrusted input. Any of them can contain prompt injection intended to trigger local tools or disclose data.

The Tool protocol extractor is intentionally text-based rather than
Markdown-aware. A complete `<tool>...</tool>` block at the textual end of a
model response is treated as a Tool request even when the surrounding response
was intended as an unclosed code example. The local, high-trust operating model
therefore relies on the Provider model following the Tool protocol; Markdown
formatting is not an execution boundary.

## Powerful operations

| Tool           | Security impact                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `run_command`  | Runs arbitrary commands through the platform's available shell; an omitted timeout means no tool-level timeout |
| `apply_patch`  | Creates or modifies UTF-8 files with V4A patches; paths are not confined to the repository                     |
| `attach_image` | Sends a selected local image and its contents to the active provider website                                   |
| `spawn`        | Starts another provider conversation with local tools and a Skill snapshot                                     |

Enabled Skill names, descriptions, and absolute `SKILL.md` paths are included
in the agent setup prompt. Skill bodies and resources are not injected, but a
model can inspect them with `run_command`; review enabled Skills as untrusted
instructions.

## Isolation and cancellation limits

- portal does not confine tools to the repository or current working directory.
- `apply_patch` limits operations to regular UTF-8 files and refuses move/delete operations, but those checks are not a filesystem sandbox.
- `run_command` output is bounded, but command side effects are not. A call without `timeoutMs` has no tool-level timeout.
- Spawn recursion is bounded by `advanced.runtime.spawnDepthLimit`, which defaults to five child levels. The limit does not bound sequential sibling tasks, concurrent root threads, or other Tool calls.
- Cancelling a turn with Ctrl+C does not stop its `run_command` process. Inspect active jobs with `/job` and stop a specific job with `/job stop <job-id>`; controlled portal shutdown stops all managed jobs.
- `/job` displays a sanitized command summary and working directory. Avoid putting credentials directly in command arguments.
- Job tracking is process-local and is not persisted. A forcibly terminated portal process, or a command that deliberately escapes its process group or Windows Job Object, may leave descendants running.
- Ctrl+C propagates cancellation where supported, but cancellation cannot prove that an external process or provider request had no side effects.

## Recommended use

- Run portal only inside a repository or workspace you are prepared to modify.
- Keep work under version control and inspect `git status` and diffs regularly.
- Use backups for files that cannot be reproduced.
- Do not keep unrelated credentials, private keys, tokens, or sensitive documents in the working directory.
- Run portal as a normal user, never as Administrator or root unless the task absolutely requires it.
- Use a dedicated browser profile and provider account where practical.
- Do not expose the browser's remote debugging port to an untrusted network.
- Stop the current operation with Ctrl+C if model behavior becomes unexpected.
- Review the startup directory's `AGENTS.md` before enabling project instructions.
- Review a skill's `SKILL.md` and resources before registering, downloading, or enabling it.
- Prefer environment placeholders over literal secrets in the Portal MCP Server listener configuration.
- Keep the Portal MCP Server listener on loopback unless remote access is intentional; use a tunnel or TLS proxy when crossing an untrusted network.

## Browser and account data

The dedicated browser profile lives at `browser.profilePath` from `<data-dir>/config.yaml`. Browser path fields accept absolute or relative values: generated defaults are absolute, while configured relative values resolve from portal's working directory. The profile can contain login cookies, local storage, and other account state. An npm-installed CLI stores it outside the workspace by default; source development uses the repository's ignored `data/` directory. Both locations still contain sensitive local data.

`<data-dir>/threads.db` stores provider conversation URLs and metadata. Those URLs may expose private conversation identifiers when combined with an authenticated browser session. It does not store transcripts or a persistent local Tool audit trail. The provider website remains the source of conversation content; local turns and rendered timelines live only for the current process and can grow with a long-running session.

On POSIX systems, Portal restricts its managed config and lock directories, the
configured browser profile root, and the thread database directory to mode
`0700`. Managed config, lock, database, and existing SQLite sidecar files use
mode `0600`. Portal repairs broader modes on those paths when it opens them, but
does not recursively change browser-owned profile contents. On Windows, access
continues to follow inherited filesystem ACLs.

Resume reads provider history into the terminal's in-memory timeline. The repository's ignored top-level `temp/` directory may also contain response captures, screenshots, or probe output created during provider development.

Package upgrades and uninstall do not remove the portal data directory. Delete it only after deciding that its browser login state, configuration, Skills, and thread metadata are no longer needed.

Do not publish or attach a portal data directory, browser profiles, raw captures, screenshots, or private conversation URLs to bug reports. Removing a capture from the current tree does not remove it from existing Git history, clones, forks, or caches. If sensitive content enters Git history, invalidate the related sessions or credentials first, then coordinate a history rewrite and replacement of affected clones before redistributing the repository.

## Project instructions

Project instructions are disabled by default. When enabled, portal reads only
the exact startup working directory's `AGENTS.md`, once, and includes its
verbatim text in new full setup prompts. It does not inspect parent or nested
directories, overrides, Claude files, user-level files, imports, or path rules.

This file is repository-controlled input, not trusted policy. It can ask
the model to read files, run commands, modify paths outside the repository, or
send additional content to external systems. The regular-file, symlink, UTF-8,
and size checks limit what portal reads, but they do not make the instructions
safe. Keep secrets out of the file and leave the feature disabled for
repositories you have not reviewed. See
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

## Portal MCP Server

The Portal MCP Server exposes selected thread and job operations to an external
MCP client. Its `host`, `port`, and `token` settings live under
`listeners.mcp`. `null` and the exact empty string disable authentication only
when `host` is exactly `127.0.0.1`; every other host requires an enabled Token
or the listener refuses to start. Every other Token string is preserved
exactly, including whitespace-only values.
Token strings may contain `${env:VARIABLE_NAME}` placeholders. They remain
unexpanded in the configuration file and are resolved for each `/mcp start`;
a missing variable fails before the listener binds.

Portal MCP Server access can send instructions
to a logged-in provider conversation, whose model can invoke local Portal
tools, and can also list or stop active command jobs. Job summaries expose the
command and working directory, which may themselves contain sensitive values.
The listener therefore exposes high-privilege local and browser-account
capabilities even when authenticated.

Selecting `mode: "chat"` when creating a thread does not reduce the listener
permissions or disable model-generated tool execution.

Bearer authentication does not encrypt HTTP traffic. On an untrusted network,
an observer may capture Tokens, prompts, assistant output, and conversation
URLs. Use loopback with an SSH tunnel, a TLS reverse proxy, or a trusted isolated
network. The MCP Server rejects requests carrying an `Origin` header, but this
DNS-rebinding control is not authentication.

The listener is intended for a small number of operator-controlled clients,
not as a public multi-tenant service. It does not provide deployment-scale
connection quotas, tenant isolation, or a general admission layer. Configure
finite request timeouts and external proxy limits when using a listener for
long-running or remote integrations.

## Provider policies

portal automates real provider websites. Provider terms, automation policies, rate limits, and UI behavior can change independently of this project. Users are responsible for ensuring that their use complies with the relevant provider's terms and local law.

## Reporting a vulnerability

Avoid posting credentials, browser profiles, private conversation URLs, or working exploit details in a public issue. If the repository offers a private security-reporting channel, use it. Otherwise, open a minimal issue asking the maintainers for a private contact method without including sensitive details.
