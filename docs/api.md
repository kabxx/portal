# HTTP API

Portal remains a TUI application. The HTTP API runs inside the same process and
shares its browser, provider pages, threads, Skills, and MCP configuration.

The server is disabled by default. Start it from the TUI with:

```text
/serve api start
/serve api status
/serve api token
/serve api stop
```

`run_command` jobs are managed only by the TUI. `/job` lists active jobs and
`/job stop <job-id>` stops one; there is intentionally no HTTP job-management
endpoint in this version. Jobs are process-local and are stopped during
controlled portal shutdown.

The default listener is `127.0.0.1:8787`. Configure it in `data/config.yaml`:

```yaml
listeners:
  api:
    host: 127.0.0.1
    port: 8787
    token: null
```

When `token` is neither `null` nor the exact empty string `""`, every `/v1/*`
request must include `Authorization: Bearer <token>`. Portal preserves Token
strings exactly and does not trim whitespace. `/health` is always
unauthenticated. Host and authentication are independent; an unauthenticated
non-loopback listener is allowed. Use an SSH tunnel or TLS reverse proxy for
remote access. Listener and Token changes require restarting portal;
`/serve api stop` followed by `/serve api start` reuses the configuration
loaded by the current process. See [Configuration](configuration.md).

The [Portal MCP Server](mcp-server.md) is a separate native MCP service. It does
not add MCP routes to the HTTP API or call the API internally.

## Threads

The API addresses a thread directly. It does not introduce a separate
`session`, `run`, or `turn` resource, and it does not expose MCP attachment
operations.

| Method   | Path                             | Purpose                                               |
| -------- | -------------------------------- | ----------------------------------------------------- |
| `GET`    | `/health`                        | Liveness check                                        |
| `GET`    | `/v1/status`                     | Portal and API status                                 |
| `GET`    | `/v1/providers`                  | Supported provider ids                                |
| `GET`    | `/v1/threads`                    | List open threads                                     |
| `POST`   | `/v1/threads`                    | Open a thread; body: `provider`, optional `model`     |
| `POST`   | `/v1/threads/resume`             | Resume; body: `conversationUrl`                       |
| `GET`    | `/v1/threads/:threadId`          | Get thread metadata                                   |
| `DELETE` | `/v1/threads/:threadId`          | Close a thread                                        |
| `POST`   | `/v1/threads/:threadId/messages` | Submit `{ "input": "..." }`; returns `202`            |
| `POST`   | `/v1/threads/:threadId/cancel`   | Cancel the current thread operation; idempotent       |
| `POST`   | `/v1/threads/:threadId/reload`   | Reload the provider page; returns `202`               |
| `GET`    | `/v1/threads/:threadId/events`   | Subscribe to SSE events; multiple clients are allowed |

Only one operation may run on a given thread at a time. A conflicting message
or reload returns `409 THREAD_BUSY`; it is not queued. Different threads can
run through the existing thread coordinator. Reload restores the current
provider page without creating a turn or changing the local title/history.
Subscribe to the SSE endpoint before sending the reload request when the
`thread.action` `started` event must not be missed.

Closing a thread can return `409 THREAD_CLOSE_TIMEOUT` when its active operation
does not settle in time. If the logical thread was removed but one or more
runtime or Hook cleanup steps failed, it returns
`500 THREAD_CLOSED_WITH_CLEANUP_ERRORS`; the thread is already closed in that
case.

## Skills

`POST /v1/threads/:threadId/skill` with `{ "name": "skill-name" }` starts the
same activation-only form as typing `$skill-name` in the TUI. The combined
`$skill-name task` form is intentionally not synthesized by this API.

| Method   | Path                          | Body or purpose                                                                                                             |
| -------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/v1/threads/:threadId/skill` | `{ "name": "skill-name" }`; starts one activation-only turn and returns `202`                                               |
| `GET`    | `/v1/skills`                  | List registered Skills and validation issues                                                                                |
| `POST`   | `/v1/skills`                  | `{ "source": "...", "registryUrl": "..." }`; optional registry; returns `201` with `{ "skills": [...], "warnings": [...] }` |
| `PUT`    | `/v1/skills/:name`            | `{ "enabled": true }` or `{ "enabled": false }`                                                                             |
| `DELETE` | `/v1/skills/:name`            | Remove the registration and managed download; returns `{ "removed": true, "name": "...", "warnings": [...] }`               |

For a Hub install, `source` is the Skill name and `registryUrl` is the HTTP(S)
registry root. For local directories and direct URLs, omit `registryUrl`. See
[Skills](skills.md).

## MCP

| Method   | Path                                              | Body or purpose                                                           |
| -------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET`    | `/v1/mcp/servers`                                 | List configured servers with secrets redacted                             |
| `POST`   | `/v1/mcp/servers`                                 | `{ "name": "server", ...config }`; adds a server; returns `201`           |
| `PUT`    | `/v1/mcp/servers/:name`                           | `{ "enabled": true }`, `{ "enabled": false }`, or `{ "config": { ... } }` |
| `DELETE` | `/v1/mcp/servers/:name`                           | Remove a configured server                                                |
| `GET`    | `/v1/threads/:threadId/mcp/resources?server=name` | List Resources in the active runtime; `server` is optional                |
| `GET`    | `/v1/threads/:threadId/mcp/prompts?server=name`   | List Prompts in the active runtime; `server` is optional                  |

The POST config is the same server object accepted under `mcpServers` after
removing `name`; PUT replacement wraps that object in `config`. Runtime
Resource and Prompt endpoints are read-only and do not attach content to a
thread. See [MCP](mcp.md).

The server list redacts HTTP headers and stdio environment values. It reports
only `hasHeaders`/`hasEnv`; credentials are never returned by the API.

## Provider capabilities

| Method   | Path                                       | Body or purpose                                                                                                 |
| -------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/v1/threads/:threadId/capabilities`       | List controls exposed by the active provider page                                                               |
| `PUT`    | `/v1/threads/:threadId/capabilities/:name` | `{ "state": "on" }`/`{ "state": "off" }` for toggles; `{ "state": "selected" }`/`{ "state": "on" }` for actions |
| `DELETE` | `/v1/threads/:threadId/capabilities/:name` | Set a toggle to `off`, or clear the selected action                                                             |

Toggle states and dynamic action names follow the same provider-specific rules
as `/thread capability`. Unsupported states and unavailable controls return
`400`. See [Providers](providers.md).

## SSE events

Each event includes an SSE sequence id and JSON data containing `threadId`.
The event names are:

`message.started`, `assistant.delta`, `assistant.reset`, `assistant.message`, `status`,
`tool.started`, `tool.output`, `tool.completed`, `message.completed`,
`message.failed`, `message.cancelled`, `thread.closed`, `thread.action`, and
`hook.execution`.

`thread.closed` is the terminal event for a thread whose Provider page was
closed outside portal. Its data contains `reason: "provider_page_closed"`.
When an active message settles during coordinated cancellation,
`message.cancelled` is emitted first. If cancellation reaches its bounded
force-close fallback, `thread.closed` can be the only terminal event. After
publishing `thread.closed`, portal ends every SSE response subscribed to that
thread.

`hook.execution` is emitted when a configured Hook handler starts and finishes.
Its data contains `hookRunId`, `phase`, `event`, `handler`, `handlerType`,
`durationMs` when available, and the relevant `threadId`, `turnId`, and
`toolCallId`. Handler stdout and stderr are never exposed through SSE.

`thread.action` is emitted for asynchronous thread actions. Its data includes
`operationId`, `action`, and `phase` (`started`, `completed`, `failed`, or
`cancelled`). Reload uses `action: "reload"`; failed events also include a
`message` field.

`assistant.delta` contains text appended since the previous stream callback.
The provider adapters internally report full snapshots, so a client should
append `text` from this event and treat `assistant.message` as the completed
assistant message for that model response. `assistant.reset` has no additional
fields and means a failed Provider attempt emitted partial text before portal
started a retry. Clients must discard the accumulated deltas for that attempt;
the terminal UI leaves the old partial response visible during the retry delay.

`tool.started`, `tool.output`, and `tool.completed` include `toolCallId` so a
client can correlate progress and completion for one invocation. `tool.output`
also includes `turnId`; delayed progress from an earlier invocation must not be
applied to a newer tool call with the same name.

Example:

```bash
curl -N -H "Authorization: Bearer $PORTAL_TOKEN" \
  http://127.0.0.1:8787/v1/threads/t-1/events

curl -X POST -H "Authorization: Bearer $PORTAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":"检查当前页面状态"}' \
  http://127.0.0.1:8787/v1/threads/t-1/messages
```

Errors use the form `{ "error": { "code": "...", "message": "..." } }`.
