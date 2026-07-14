# HTTP API

Portal remains a TUI application. The HTTP API runs inside the same process and
shares its browser, provider pages, threads, Skills, and MCP configuration.

The server is disabled by default. Start it from the TUI with:

```text
/serve start
/serve status
/serve token
/serve stop
```

The default listener is `127.0.0.1:8787`. Configure it in `data/config.yaml`:

```yaml
api:
  host: 127.0.0.1
  port: 8787
  token: null
```

When `token` is a string, every `/v1/*` request must include
`Authorization: Bearer <token>`. `/health` is always unauthenticated. A
non-loopback host requires a non-null token. Use an SSH tunnel for remote
access instead of exposing the browser session directly.

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

## Skills and MCP

`POST /v1/threads/:threadId/skill` with `{ "name": "skill-name" }` starts the
same activation-only form as typing `$skill-name` in the TUI. The combined
`$skill-name task` form is intentionally not synthesized by this API.

Skills are managed with `GET/POST /v1/skills`, `PUT /v1/skills/:name` with
`{ "enabled": true|false }`, and `DELETE /v1/skills/:name`.

MCP servers are managed with `GET/POST /v1/mcp/servers`,
`PUT /v1/mcp/servers/:name` (enable/disable or replace `config`), and
`DELETE /v1/mcp/servers/:name`. Runtime resource and prompt catalogs can be
queried with:

The server list redacts HTTP headers and stdio environment values. It reports
only `hasHeaders`/`hasEnv`; credentials are never returned by the API.

```text
GET /v1/threads/:threadId/mcp/resources?server=name
GET /v1/threads/:threadId/mcp/prompts?server=name
```

Provider-specific web capabilities are exposed through
`GET/PUT/DELETE /v1/threads/:threadId/capabilities/:name`.

## SSE events

Each event includes an SSE sequence id and JSON data containing `threadId`.
The event names are:

`message.started`, `assistant.delta`, `assistant.message`, `status`,
`tool.started`, `tool.output`, `tool.completed`, `message.completed`,
`message.failed`, `message.cancelled`, `thread.action`, and `hook.execution`.

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
assistant message for that model response.

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
