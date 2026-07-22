# Project Instructions

[Back to README](../README.md)

Project instructions are optional repository and user-owned Markdown files that
are loaded into portal runtimes. They can shape model behavior, but they do not
change system, tool, provider, safety, or current-user boundaries.

The feature is disabled by default. Enable only sources you have reviewed:

```yaml
agentInstructions:
  claude:
    global: false
    local: true
  codex:
    global: false
    local: true
```

The configuration section is described in [Configuration](configuration.md).

## Workspace and sources

portal starts from its current working directory and walks upward until it
finds a `.git` directory or file. That directory is the workspace root. If no
Git marker is found, the current working directory is used.

Codex sources are loaded from each workspace directory in order. In one
directory, `AGENTS.override.md` takes precedence over `AGENTS.md` and suppresses
the ordinary file when both exist. When `global: true`, portal also reads
the first available `AGENTS.override.md` or `AGENTS.md` under `~/.codex`.

Claude Code sources are loaded from each workspace directory in this order:

1. `CLAUDE.md`;
2. `.claude/CLAUDE.md`;
3. `.claude/rules/*.md` files;
4. `CLAUDE.local.md`.

When `global: true`, the corresponding home directory is `~/.claude`, including
its `CLAUDE.md` and `rules/` directory. Broader directories are loaded before
more specific directories. The resulting instruction prompt records the
source paths and scope so the model can distinguish global and local text.

## Imports and path rules

Claude files may import other regular files using the supported Claude import
syntax. Imports are resolved inside the workspace root or the configured global
root, after lexical, realpath, and symlink checks. Absolute and relative imports
are accepted only while they remain inside the current source root; `..`
escapes, external symlinks, missing files, cyclic imports, and non-regular files
are rejected or reported as warnings.

Files under `.claude/rules/` may declare `paths:` patterns. A matching rule is
not added to the active prompt until a tool call targets a matching directory.
Currently, target-aware activation reads paths from `run_command` (`cwd`),
`attach_image` (`path`), and `apply_patch` file headers. Other tools do not
activate directory-specific rules.

## Runtime lifecycle

| Runtime                 | Instruction behavior                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent thread            | Loads the configured snapshot and includes always-on instructions in the full setup prompt                                                    |
| Chat thread             | Loads the snapshot locally but sends only the shared handshake; a later target-aware tool call can still activate matching instructions       |
| Spawned runtime         | Forks the parent snapshot and runs its own full setup handshake                                                                               |
| Hook prompt/agent child | Loads the configured sources for the isolated child runtime                                                                                   |
| Resumed thread          | Reads a fresh snapshot, but `setupMode: 'skip'` means it does not resend the initial instruction prompt to the existing provider conversation |

The resumed thread currently does not attach that snapshot to its
`RuntimeCore`; it therefore does not perform target-aware instruction activation
for its own later tool calls. A child `spawn` created from the resumed runtime
can still receive the forked snapshot through the normal child setup path.

Instruction files are read from disk when a runtime snapshot is created. A
later file edit does not rewrite an already submitted provider setup message.

## Limits

The default limits are:

- Codex instructions: 32 KiB;
- Claude Code instructions: 96 KiB;
- instruction files loaded in one context: 128;
- nested import depth: 4.

The limits can be changed under `advanced.instructions`, but the values apply
when portal starts. Truncation, rejected imports, and other loader problems are
reported as instruction warnings rather than silently treating the file as
fully loaded.

## Security boundary

Project instruction text is sent to the web Provider as part of the runtime
prompt. A repository-controlled `AGENTS.md`, `CLAUDE.md`, imported file, or
path rule can therefore influence a model that has access to `run_command`,
`apply_patch`, MCP, Skills, and spawned runtimes. There is no human approval
gate before a valid model-generated tool call executes.

Do not place credentials, private keys, or unrelated sensitive data in
instruction files. Review repository instructions before enabling `local`,
and use the narrower default (`global: false`, `local: false`) for untrusted
repositories. See [Security](security.md).
