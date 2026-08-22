# Portal MCP Server

[Back to README](../../README.md)

Portal can expose selected thread operations as a native Streamable HTTP MCP
Server. The sparse `mcp` section configures its address, while
`PORTAL_MCP_TOKEN` configures authentication. The server shares Portal's
in-process browser, runtimes, and active threads.

Portal provides an inbound MCP server. Portal runtimes do not connect to
external MCP servers or expose MCP host tools to web models.

## Start and stop

The listener is stopped by default. When the MCP Surface plugin is enabled,
manage it from the TUI:

```text
/mcp start
/mcp status
/mcp token
/mcp stop
```

Stopping the MCP Server rejects new MCP requests, cancels MCP-owned message and
foreground operations, and closes active transports. It does not cancel work
started by the TUI.

## Configuration

```yaml
mcp:
  host: 127.0.0.1
  port: 8788
```

The endpoint is `http://<host>:<port>/mcp`. Authentication depends on the
process environment variable `PORTAL_MCP_TOKEN`. An unset or empty value
disables authentication only when `host` is exactly `127.0.0.1`; every other
host requires a non-empty token or the listener refuses to start. Portal
captures the address and token at startup, so changing the configuration or
environment requires restarting Portal. `/mcp token` reports only whether
authentication is configured and never prints the value.

Portal targets non-browser MCP clients. Requests containing any
`Origin` header, including `Origin: null`, are rejected. CORS is not enabled.

## Tools

The MCP tools are contributed by the enabled MCP Surface and its active
feature contributions. The MCP Surface can be disabled independently; when it
is disabled, the MCP listener, `/mcp` command, and all MCP tools are absent.
`portal_list_jobs` and `portal_stop_job` are contributed by the `run_command`
plugin and appear only when that plugin and its MCP management contribution are
enabled.

| Tool                    | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `portal_list_providers` | List supported provider ids                              |
| `portal_list_jobs`      | List active `run_command` jobs                           |
| `portal_stop_job`       | Stop an active command job and wait for its process tree |
| `portal_create_thread`  | Create an agent or chat provider conversation            |
| `portal_resume_thread`  | Resume a provider conversation URL                       |
| `portal_list_threads`   | List active threads in the current Portal process        |
| `portal_get_thread`     | Read one active thread                                   |
| `portal_close_thread`   | Cancel active work and close one thread                  |
| `portal_send_message`   | Start a message and return an operation id immediately   |
| `portal_wait_message`   | Long-poll a message operation for up to 30 seconds       |
| `portal_cancel_message` | Cancel the exact MCP-owned message operation             |

`portal_create_thread` accepts the currently enabled Agent modes. When both
first-party modes are enabled, the optional `mode` is `"agent"` or `"chat"`
and defaults to `"agent"`; with one mode enabled, the schema exposes only that
mode and uses it as the default. Chat creation sends only the shared setup prompt
instead of the full portal setup prompt. It waits for the provider response and
a reusable composer without requiring any particular response text. It still
creates a normal local runtime with configured tools, Skills, and local runtime
services, so chat mode is not a sandbox.

`portal_create_thread` accepts `provider` plus optional named `model` and
model-specific `option` keys from [Providers](providers.md). Numeric menu
positions and combined numeric forms are rejected.

`portal_send_message` returns a process-local `operationId` with `running`
status. Call `portal_wait_message` until it returns `completed`, `failed`, or
`cancelled`. Terminal operations expire after a bounded retention period and
are not persisted across Portal restarts or MCP Server stop/start cycles.

Only one operation may run on a thread. A conflicting operation returns an
error instead of being queued. Different threads can run concurrently. Closing
a thread is explicitly destructive and can cancel work started through another
Portal interface.

Cancelling an MCP message cancels the owning Tool scope; an active
`run_command` invocation stops its process tree. Use `portal_list_jobs` to
discover other active jobs and `portal_stop_job` to stop one. Job summaries include
the command and working directory, which may contain sensitive data, but do not
include buffered stdout or stderr. Unknown or already finished job ids return a
Tool error. When `run_command` is enabled, the TUI `/job` commands and
controlled Portal shutdown use the same plugin-owned process-local jobs.

## Security

The MCP Token grants access to logged-in browser conversations and to models
that can invoke Portal's local tools. Treat it as a high-privilege credential.
Bearer authentication over plain HTTP does not protect Tokens or conversation
content from network interception. For non-loopback access, use an SSH tunnel,
a TLS reverse proxy, or a trusted isolated network. Portal requires a Token on
every configured host other than the exact value `127.0.0.1`. See
[Security](../../SECURITY.md).
