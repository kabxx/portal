# Portal MCP Server

[Back to README](../README.md)

Portal can expose selected thread operations as a native Streamable HTTP MCP
Server. This service is independent from the [HTTP API](api.md): it has its own
listener, configuration, authentication, protocol, and lifecycle, and it never
calls the API. Both services share the same in-process browser, runtimes, and
active threads.

The [`mcpServers` configuration](mcp.md) has the opposite direction: it makes
Portal an MCP client. The `listeners.mcp` section documented here configures
Portal's own MCP Server listener.

## Start and stop

The server is disabled by default. Manage it from the TUI:

```text
/serve mcp start
/serve mcp status
/serve mcp token
/serve mcp stop
```

API and MCP listeners can run at the same time. Stopping the MCP Server rejects
new MCP requests, cancels MCP-owned message and foreground operations, and
closes active transports. It does not cancel work started by the TUI or API.

## Configuration

```yaml
listeners:
  mcp:
    host: 127.0.0.1
    port: 8788
    token: null
```

The endpoint is `http://<host>:<port>/mcp`. Authentication depends only on the
exact `token` value:

- `null` and the exact empty string `""` disable authentication;
- every other string enables Bearer authentication, including whitespace-only
  strings and strings with leading or trailing whitespace;
- Portal preserves configured Token strings exactly and does not trim them.

HTTP implementations treat leading and trailing request-header whitespace as
protocol syntax. A Token containing such whitespace still enables
authentication and is never rewritten by Portal, but a client or HTTP stack may
be unable to transmit it losslessly as a Bearer credential.

Host and authentication are independent. Portal allows any host without a
Token. Binding an unauthenticated listener to `0.0.0.0` exposes it to every
network client that can reach the port.

The first version targets non-browser MCP clients. Requests containing any
`Origin` header, including `Origin: null`, are rejected. CORS is not enabled.

## Tools

| Tool                    | Purpose                                                |
| ----------------------- | ------------------------------------------------------ |
| `portal_list_providers` | List supported provider ids                            |
| `portal_create_thread`  | Create an agent or chat provider conversation          |
| `portal_resume_thread`  | Resume a provider conversation URL                     |
| `portal_list_threads`   | List active threads in the current Portal process      |
| `portal_get_thread`     | Read one active thread                                 |
| `portal_close_thread`   | Cancel active work and close one thread                |
| `portal_send_message`   | Start a message and return an operation id immediately |
| `portal_wait_message`   | Long-poll a message operation for up to 30 seconds     |
| `portal_cancel_message` | Cancel the exact MCP-owned message operation           |

`portal_create_thread` accepts an optional `mode` of `"agent"` or `"chat"` and
defaults to `"agent"`. Chat creation sends only the shared `READY` handshake,
using a case-insensitive whole-word match, instead of the full portal setup
prompt. It still creates a normal local runtime with configured tools, Skills,
MCP connections, and Hooks, so chat mode is not a sandbox.

`portal_create_thread` accepts `provider` plus optional named `model` and
model-specific `option` keys from [Providers](providers.md). Numeric menu
positions and the previous combined numeric forms are rejected.

`portal_send_message` returns a process-local `operationId` with `running`
status. Call `portal_wait_message` until it returns `completed`, `failed`, or
`cancelled`. Terminal operations expire after a bounded retention period and
are not persisted across Portal restarts or MCP Server stop/start cycles.

Only one operation may run on a thread. A conflicting operation returns an
error instead of being queued. Different threads can run concurrently. Closing
a thread is explicitly destructive and can cancel work started through another
Portal interface.

## Security

The MCP Token grants access to logged-in browser conversations and to models
that can invoke Portal's local tools. Treat it as a high-privilege credential.
Bearer authentication over plain HTTP does not protect Tokens or conversation
content from network interception. For non-loopback access, use an SSH tunnel,
a TLS reverse proxy, or a trusted isolated network. See [Security](security.md).
