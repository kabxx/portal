# Security

[Back to README](../README.md)

portal intentionally connects an untrusted web model to powerful operations on the local machine. Treat it as a local code-execution agent, not as a sandboxed chat client.

## Security model

The web model receives a textual catalog of available tools. When its response contains a valid tool request, portal executes that request and sends the result back to the same web conversation. Setup prompts, ordinary user input, MCP attachments, tool results, and selected local images all cross the provider boundary.

There is currently no human approval gate between a valid model-generated request and local execution. The effective permissions are the permissions of the user account running portal.

Provider output, loaded Skill instructions, MCP content, and resumed conversation history are untrusted input. Any of them can contain prompt injection intended to trigger local tools or disclose data.

## Powerful operations

| Tool            | Security impact                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `run_command`   | Runs arbitrary commands through PowerShell, `cmd`, Bash, or `sh`; an omitted timeout means no tool-level timeout |
| `apply_patch`   | Creates or modifies UTF-8 files with V4A patches; paths are not confined to the repository                       |
| `attach_image`  | Sends a selected local image and its contents to the active provider website                                     |
| `spawn`         | Starts another provider conversation with local tools, a Skill snapshot, and fresh MCP connections               |
| `load_skill`    | Adds third-party instructions and local resource paths to the provider conversation                              |
| `mcp_call_tool` | Invokes operations exposed by a configured MCP server with that server's effective permissions                   |

`mcp_search_tool` only returns a cached Tool definition, but the definition itself is untrusted text. User-selected MCP Resources and Prompts are submitted as complete user turns and can also influence later tool use.

## Isolation and cancellation limits

- portal does not confine tools to the repository or current working directory.
- `apply_patch` limits operations to regular UTF-8 files and refuses move/delete operations, but those checks are not a filesystem sandbox.
- `run_command` output is bounded, but command side effects are not. A call without `timeoutMs` has no tool-level timeout.
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
- Review a skill's `SKILL.md` and resources before registering, downloading, or enabling it.
- Review an MCP server and its configuration before adding or enabling it.
- Prefer environment placeholders over literal secrets in the `mcp` section of `data/config.yaml`.

## Browser and account data

The dedicated browser profile lives at `browser.profilePath` from `data/config.yaml`. Browser path fields accept absolute or relative values: generated defaults are absolute, while configured relative values resolve from portal's working directory. The profile can contain login cookies, local storage, and other account state. The default directory is ignored by Git, but it is still sensitive local data.

`data/threads.db` stores provider conversation URLs and metadata. Those URLs may expose private conversation identifiers when combined with an authenticated browser session. It does not store transcripts.

Resume reads provider history into the terminal's in-memory timeline. The repository's ignored top-level `temp/` directory may also contain response captures, screenshots, or probe output created during provider development.

Do not publish or attach `data/`, browser profiles, raw captures, screenshots, or private conversation URLs to bug reports.

## Skill installation

Skills may be registered from local directories or downloaded from direct web URLs, GitHub paths, and archives. Validation applies size limits, rejects path traversal and symbolic links, and checks manifest structure, but these checks do not establish trust.

The current skills system does not provide:

- package signatures;
- publisher verification;
- a curated trust registry;
- dependency isolation;
- an instruction sandbox.

Treat remote skill installation like downloading code. Inspect the source and prefer pinned, trusted locations.

## MCP servers and secrets

Stdio MCP servers run as local child processes with the portal user's permissions. Streamable HTTP servers receive configured URLs and headers. Either kind can read data supplied to it and can expose tools with arbitrary side effects.

Environment placeholders reduce the need to store literal secrets in `config.yaml`, and portal redacts resolved values from known MCP error paths. Redaction is defense in depth, not a guarantee: a server can return secrets as ordinary Tool content, and a command or provider page can expose them through another path.

Review the server implementation, pin the executable or endpoint where practical, grant only the credentials it needs, and treat Resources, Prompts, schemas, and Tool results as untrusted content.

## Provider policies

portal automates real provider websites. Provider terms, automation policies, rate limits, and UI behavior can change independently of this project. Users are responsible for ensuring that their use complies with the relevant provider's terms and local law.

## Reporting a vulnerability

Avoid posting credentials, browser profiles, private conversation URLs, or working exploit details in a public issue. If the repository offers a private security-reporting channel, use it. Otherwise, open a minimal issue asking the maintainers for a private contact method without including sensitive details.
