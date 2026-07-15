# Configuration

[Back to README](../README.md)

portal creates `data/config.yaml` on first start. The generated file contains
comments for every managed section. The configuration parser rejects unknown
fields and invalid values. A valid older file may be rewritten to add missing
managed defaults and comments while preserving its existing values; malformed
configuration is rejected without being overwritten.

The configuration document has these top-level sections:

| Section             | Purpose                                                    | Typical effect                                                               |
| ------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `browser`           | Chromium executable, profile, and CDP port                 | Read at portal startup; command-line options can override it for that run    |
| `agentInstructions` | Optional Codex and Claude Code instruction sources         | Startup snapshot used when runtimes are created; disabled by default         |
| `api`               | Local HTTP listener and bearer authentication              | Read when the API server is created                                          |
| `mcp`               | MCP connection strategy and server definitions             | Re-read for MCP commands and new runtimes                                    |
| `skills`            | Registered Skill directories and enabled states            | Re-read for Skill commands and new runtimes                                  |
| `hooks`             | Lifecycle handlers and global Hook switch                  | `/hook reload`, `/hook enable`, and `/hook disable` update the active policy |
| `advanced`          | Timeouts, retry limits, output limits, and resource limits | Converted into runtime settings during portal startup                        |

Changes to startup-owned sections (`browser`, `agentInstructions`, `api`, and
`advanced`) require restarting portal. The `api` section does not enable the
server by itself; use `/serve start`. A `null` API token disables authentication
for the local listener, not the listener itself, and a non-loopback host still
requires a non-null token. MCP, Skills, and Hooks have the narrower reload and
new-runtime behavior described in their dedicated documents.

## Browser

```yaml
browser:
  name: edge
  executablePath: '<platform-specific browser executable path>'
  profilePath: data/profiles/edge
  remoteDebuggingPort: 9222
```

`name` is a non-empty browser label. `executablePath` and `profilePath` may be
absolute or relative; relative values resolve from portal's working directory.
When the file is created, portal checks common Edge, Chrome, and Chromium
locations for the current operating system, including macOS application bundles
and Linux PATH entries. The remote debugging port must be an integer from `1` to `65535`. The CLI
options `--browser-name`, `--browser-executable-path`, and
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
api:
  host: 127.0.0.1
  port: 8787
  token: null
```

The default listener is loopback-only. `token` is either `null` or a non-empty
string; empty or whitespace-only strings are normalized to `null`. API routes
and authentication behavior are documented in [HTTP API](api.md).

## MCP, Skills, and Hooks

These sections have their own configuration formats and lifecycle rules:

- [MCP configuration](mcp.md)
- [Skills registry](skills.md)
- [Hooks configuration](hooks.md)

Keep secrets out of the file. Use MCP environment placeholders such as
`${env:MCP_TOKEN}` and review external Skills and MCP servers before enabling
them. See [Security](security.md).

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
| `requestAttemptLimit`             |       3 | Retryable request attempts               |
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
