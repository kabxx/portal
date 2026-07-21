# Configuration

[Back to README](../README.md)

portal creates `data/config.yaml` on first start. The generated file contains
comments for every managed section. The configuration parser rejects unknown
fields and invalid values. A valid partial file using the current schema may be
rewritten to add missing managed defaults and comments while preserving its
existing values; malformed or unsupported configuration is rejected without
being overwritten.

Configuration writers are serialized across portal processes with the native
file lock at `data/.locks/config.lock`. The lock file is persistent; its
presence does not mean the lock is currently held. The operating system
releases the lock when the owning file descriptor closes, including after a
process is terminated. Configuration contents are still replaced through a
temporary file and atomic rename.

The configuration document has these top-level sections:

| Section             | Purpose                                                    | Typical effect                                                               |
| ------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `browser`           | Chromium executable, profile, and CDP port                 | Read at portal startup; command-line options can override it for that run    |
| `agentInstructions` | Optional Codex and Claude Code instruction sources         | Startup snapshot used when runtimes are created; disabled by default         |
| `listeners`         | API and Portal MCP Server listeners and authentication     | Read when either inbound listener is created                                 |
| `mcpServers`        | Outbound MCP client server definitions                     | Re-read for MCP commands and new runtimes                                    |
| `skills`            | Registered Skill directories and enabled states            | Re-read for Skill commands and new runtimes                                  |
| `hooks`             | Lifecycle handlers and global Hook switch                  | `/hook reload`, `/hook enable`, and `/hook disable` update the active policy |
| `keybindings`       | Terminal input shortcuts                                   | Valid file edits apply automatically; invalid edits keep the last valid set  |
| `advanced`          | Timeouts, retry limits, output limits, and resource limits | Converted into runtime settings during portal startup                        |

Changes to startup-owned sections (`browser`, `agentInstructions`, `listeners`,
and `advanced`) require restarting portal. Listener sections do not enable
their services by themselves; use `/serve api start` or `/serve mcp start`.
MCP client connections, Skills, and Hooks have the narrower
reload and new-runtime behavior described in their dedicated documents.
Keybindings are watched independently and do not require a restart.

## Browser

```yaml
browser:
  engine: chromium
  executablePath: '<platform-specific browser executable path>'
  profilePath: data/profiles/chromium
  remoteDebuggingPort: 9222
```

`engine` must be `chromium`. `executablePath` and `profilePath` may be
absolute or relative; relative values resolve from portal's working directory.
When the file is created, portal checks common Edge, Chrome, Chromium, Brave,
Vivaldi, Opera, Opera GX, and Arc locations for the current operating system,
including macOS application bundles and Linux PATH entries. The remote debugging
port must be an integer from `0` to `65535`. A nonzero value is used exactly;
if that port is occupied, browser startup fails rather than choosing another
port. `0` asks Chromium to choose an available port for that run and does not
rewrite the configuration file. The CLI options
`--browser-engine`, `--browser-executable-path`, and
`--browser-remote-debugging-port` take precedence over the corresponding file
values for one run.

## Project instructions

```yaml
agentInstructions:
  claude:
    global: false
    local: false
  codex:
    global: false
    local: false
```

Both providers are disabled by default. Set `local: true` to read project
instruction files, or `global: true` to read the corresponding files under the
user home directory. Changing these switches requires restarting portal;
editing files under an already enabled source does not, because new runtime
snapshots read their contents from disk. See [Project instructions](instructions.md)
for discovery, activation, limits, and the security boundary.

## HTTP API

```yaml
listeners:
  api:
    host: 127.0.0.1
    port: 8787
    token: null
```

The default listener is loopback-only. `null` and the exact empty string `""`
disable authentication. Every other string is an exact Bearer Token, including
whitespace-only values; Portal does not trim it. Host and authentication are
independent. API routes and authentication behavior are documented in
[HTTP API](api.md).

## Portal MCP Server

```yaml
listeners:
  mcp:
    host: 127.0.0.1
    port: 8788
    token: null
```

This listener is independent from the HTTP API and from the outbound MCP client
configuration under `mcpServers`. Token values use the same exact semantics as
the API.
See [Portal MCP Server](mcp-server.md).

## MCP, Skills, and Hooks

These sections have their own configuration formats and lifecycle rules:

- [MCP configuration](mcp.md)
- [Skills registry](skills.md)
- [Hooks configuration](hooks.md)

Keep secrets out of the file. Use MCP environment placeholders such as
`${env:MCP_TOKEN}` and review external Skills and MCP servers before enabling
them. See [Security](security.md).

## Keybindings

The generated `keybindings` section is the complete effective shortcut table
and appears immediately before `advanced`:

```yaml
keybindings:
  app.interrupt: [ctrl+c]
  app.exit: [ctrl+d]
  input.submit: [enter]
  input.newline: [shift+enter, ctrl+j] # macOS uses alt+enter, ctrl+j
  input.complete: [tab]
  input.clear: [ctrl+u, escape]
  input.deleteWordBackward: [ctrl+w]
  input.deleteBackward: [backspace]
  input.deleteForward: [delete]
  input.lineStart: [home, ctrl+a]
  input.lineEnd: [end, ctrl+e]
  input.moveLeft: [left]
  input.moveRight: [right]
  input.moveUp: [up]
  input.moveDown: [down]
```

Windows and Linux default to `shift+enter` plus `ctrl+j` for a newline. macOS
defaults to `alt+enter` (the terminal representation of Option+Enter) plus
`ctrl+j`. Modified Enter support depends on the terminal and its keyboard
protocol; `ctrl+j` is the reliable fallback on every platform.

Keys are case-insensitive. Supported modifiers are `ctrl`, `alt`, `shift`, and
`super`; portal stores them in canonical order. Named keys are `enter`,
`escape`, `tab`, `backspace`, `delete`, `home`, `end`, `left`, `right`, `up`,
`down`, and `space`. A modified single character is also valid; `space`, as a
printable character, also requires a modifier. Chords,
function keys, unmodified printable characters, duplicate keys, and keys shared
by multiple actions are rejected.

Editing and saving a valid section applies it automatically. Invalid edits show
an error in the TUI and leave the last valid snapshot active. `[]` explicitly
unbinds an action, except `input.submit`, which must keep at least one binding.
Missing known actions use current-platform defaults and are written into the
complete table during the next startup migration. Unknown actions are errors.

Run `/keybinding reset` to replace only this section with the complete
current-platform defaults. The command writes the file and applies the result
immediately; it is also available while a thread is busy.

## Advanced settings

Advanced values are positive integers except `stopGraceSeconds`, which accepts
a positive number, and `requestTimeoutSeconds`, which accepts zero. They are
low-frequency tuning knobs and are applied when portal starts.

### `advanced.browser`

| Field                   | Default | Meaning                                    |
| ----------------------- | ------: | ------------------------------------------ |
| `startupTimeoutSeconds` |      60 | Browser startup and CDP connection timeout |
| `closeTimeoutSeconds`   |       3 | Grace period for browser close             |

### `advanced.provider`

| Field                             | Default | Meaning                                                       |
| --------------------------------- | ------: | ------------------------------------------------------------- |
| `requestStartWarningAfterSeconds` |      30 | Delay before warning that a submitted request has not started |
| `blockedWarningEverySeconds`      |      30 | Interval between blocked-request warnings                     |
| `responseStartTimeoutSeconds`     |      30 | Time allowed for first response activity                      |
| `responseStallTimeoutSeconds`     |      30 | Time allowed between response activities                      |
| `restoreTimeoutSeconds`           |      60 | Provider page restore timeout                                 |
| `historyLoadTimeoutSeconds`       |      60 | Total resume-history timeout                                  |
| `historyPageTimeoutSeconds`       |      10 | Timeout for one history page                                  |

### `advanced.runtime`

| Field                             | Default | Meaning                                  |
| --------------------------------- | ------: | ---------------------------------------- |
| `initializationAttemptLimit`      |       3 | Runtime initialization attempts          |
| `requestAttemptLimit`             |       3 | Ordinary bounded retry attempts          |
| `cancelWaitTimeoutSeconds`        |       3 | Wait for cancelled thread work to settle |
| `shutdownCloseTimeoutSeconds`     |       3 | Wait for each resource during shutdown   |
| `childRuntimeCloseTimeoutSeconds` |       2 | Wait for a Hook child runtime to close   |

### `advanced.command`

| Field                 | Default | Meaning                                        |
| --------------------- | ------: | ---------------------------------------------- |
| `resultOutputLimitMB` |       4 | Combined stdout/stderr retained per command    |
| `stopGraceSeconds`    |    0.25 | POSIX graceful process-tree termination period |
| `stopTimeoutSeconds`  |       3 | Wait for a stopped command job to settle       |

### `advanced.skillInstall`

| Field                    | Default | Meaning                                |
| ------------------------ | ------: | -------------------------------------- |
| `downloadTimeoutSeconds` |      60 | Timeout for one Skill download         |
| `downloadLimitMB`        |     100 | Maximum downloaded Skill size          |
| `extractedSizeLimitMB`   |     500 | Maximum extracted Skill size           |
| `fileCountLimit`         |    5000 | Maximum files in one installed Skill   |
| `resourceFileCountLimit` |    2000 | Maximum resources exposed by one Skill |
| `manifestSizeLimitKB`    |     512 | Maximum `SKILL.md` size                |
| `redirectLimit`          |       5 | Maximum redirects during download      |

### `advanced.api`

| Field                   | Default | Meaning                               |
| ----------------------- | ------: | ------------------------------------- |
| `requestBodyLimitKB`    |     256 | Maximum HTTP request body             |
| `requestTimeoutSeconds` |       0 | HTTP request timeout; `0` disables it |
| `sseHeartbeatSeconds`   |      15 | SSE heartbeat interval                |

### `advanced.instructions`

| Field               | Default | Meaning                                 |
| ------------------- | ------: | --------------------------------------- |
| `codexSizeLimitKB`  |      32 | Codex instruction bytes loaded          |
| `claudeSizeLimitKB` |      96 | Claude Code instruction bytes loaded    |
| `fileCountLimit`    |     128 | Instruction files loaded in one context |
| `importDepthLimit`  |       4 | Maximum nested import depth             |

### `advanced.hooks`

| Field                  | Default | Meaning                               |
| ---------------------- | ------: | ------------------------------------- |
| `commandOutputLimitMB` |       1 | Output retained from one command Hook |

Invalid advanced values are rejected rather than silently accepted. For the
security implications of command, Skill, MCP, and Hook limits, see
[Security](security.md).
