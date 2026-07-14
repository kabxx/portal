# MCP

[Back to README](../README.md)

portal is an MCP client for stdio and Streamable HTTP servers. The only connection strategy currently implemented is `per-thread`: each new, resumed, or spawned runtime creates and owns fresh independent MCP connections.

## Configuration

The user-editable file is `data/config.yaml`. MCP settings live under its top-level `mcp` section. Server names are object keys and must be unique.

```yaml
mcp:
  connectionStrategy: per-thread
  servers:
    remote:
      transport: streamable-http
      url: https://example.com/mcp
      headers:
        Authorization: Bearer ${env:MCP_TOKEN}
    local:
      transport: stdio
      command: node
      args:
        - server.js
```

The smallest valid HTTP entry contains `transport` and `url`. The smallest valid stdio entry contains `transport` and `command`.

| Field              | Applies to | Meaning                                       | Default   |
| ------------------ | ---------- | --------------------------------------------- | --------- |
| `enabled`          | both       | Connect this server in newly created runtimes | `true`    |
| `connectTimeoutMs` | both       | Client initialization timeout                 | `15000`   |
| `toolTimeoutMs`    | both       | Individual MCP request timeout                | `60000`   |
| `maxOutputChars`   | both       | Maximum rendered tool/attachment text         | `100000`  |
| `headers`          | HTTP       | Streamable HTTP request headers               | none      |
| `args`             | stdio      | Child command arguments                       | none      |
| `cwd`              | stdio      | Child working directory                       | inherited |
| `env`              | stdio      | Additional child environment values           | none      |

Unknown fields and unsupported connection strategies are configuration errors. Invalid servers are isolated so valid servers can still connect. Any configuration issue is rendered as Markdown during runtime creation. CLI mutations refuse to rewrite a file while invalid entries exist, preventing accidental loss of hand-edited data.

When `config.yaml` does not exist, portal creates the complete default configuration with `connectionStrategy: "per-thread"` and no MCP servers. Existing files, including malformed files, are never overwritten during initialization.

## Environment placeholders

String values can read process environment variables with `${env:VARIABLE_NAME}`. The placeholder remains in YAML and is expanded immediately before each connection.

```yaml
Authorization: Bearer ${env:MCP_TOKEN}
```

Use `$${env:VARIABLE_NAME}` for literal placeholder text. Expansion is single-pass; a value containing another placeholder is not expanded again. A missing variable fails only that server. Resolved values are redacted from MCP error messages and normal status output.

Relative stdio `cwd` values resolve against the directory containing `config.yaml`. Stdio processes always use `shell: false`. Environment placeholders can appear in HTTP URLs, HTTP header values, stdio commands, arguments, cwd, and child environment values.

## CLI commands

```text
/mcp add <name> <url> [--header "Name: value"]...
/mcp add <name> -- <command> [args...]
/mcp list
/mcp enable <name>
/mcp disable <name>
/mcp remove <name>
/mcp resource list [server]
/mcp resource attach <server> <uri>
/mcp prompt list [server]
/mcp prompt attach <server> <prompt> [json-arguments]
```

Examples:

```text
/mcp add remote https://example.com/mcp --header "Authorization: Bearer ${env:MCP_TOKEN}" --header "X-Workspace: demo"
/mcp add local -- node server.js
/mcp disable remote
/mcp resource list local
/mcp prompt attach local summarize "{\"format\":\"markdown\"}"
```

HTTP headers may be repeated. Header names are case-insensitively unique. `add` writes an enabled server; enable/disable/remove affect only future runtimes. Existing threads keep their current connections until closed.

## Runtime connection lifecycle

When a new, resumed, or spawned runtime is created:

1. portal reads the current configuration snapshot.
2. Enabled valid servers connect in parallel.
3. Each successful connection initializes and caches its Tool definitions.
4. Failed servers are omitted and produce a Markdown `MCP Server Unavailable` warning.
5. The runtime owns the resulting `ThreadMcpSession` and closes all connections with the runtime.

Resume does not restore an old transport or HTTP `MCP-Session-Id`. It reconnects the currently enabled configuration with fresh clients. A resumed conversation skips the setup handshake, so the model may still have an older MCP catalog in its provider-side context; current connections are available to host tools, but portal does not send a catalog update turn.

Tool `list_changed` notifications refresh the current connection cache. They do not rewrite the original setup snapshot or add a discovery turn. A server/tool name added after runtime creation is therefore reliably advertised only to a new runtime.

## Tool discovery and calls

Every runtime exposes two MCP host tools. When no Server is available, they return the current empty/unavailable directory instead of dispatching a request:

- `mcp_search_tool({ server, tool })` loads one exact cached Tool definition, including description, input schema, and optional output schema. It never calls the server Tool.
- `mcp_call_tool({ server, tool, arguments })` calls one exact cached Tool using schema-conforming arguments.

The setup prompt contains only successful Server and Tool names under `# MCP Servers`. It does not inject descriptions, schemas, server instructions, Resources, or Prompts. The model should search an unfamiliar Tool before calling it.

## Resources and Prompts

Resources and Prompts are user-driven attachments, not automatically advertised model capabilities:

```text
/mcp resource list [server]
/mcp resource attach <server> <uri>
/mcp prompt list [server]
/mcp prompt attach <server> <prompt> [json-arguments]
```

Each attach operation:

- reads through the active thread's MCP connection;
- creates one complete Markdown user turn;
- includes JSON metadata and a random delimiter boundary;
- is never concatenated with ordinary user input;
- is subject to the server's `maxOutputChars` limit.

A Resource attachment tells the model to acknowledge the selected reference only. A Prompt attachment is explicitly marked as the user's current request and should be executed. Prompt argument values must be strings in the CLI JSON object.

Current content support is deliberately narrow. Resource contents must be text; Prompt messages must contain text content. Unsupported blob, image, audio, or other content produces an ordinary MCP operation error. Tool results can contain text, embedded text resources, resource links, and structured JSON; unsupported content is labeled rather than crashing the runtime.

## Failure semantics

Configuration, environment, and connection failures happen before a Tool request is dispatched. They are reported as ordinary unavailable warnings, and other valid servers continue.

When a requested Server or Tool is not available in the current thread, the model receives an error Tool Result containing:

- the requested Server and Tool;
- the current connected Server/Tool directory;
- an explicit unavailable message.

portal does not discover newly configured servers inside an existing conversation.

Once a Tool call enters the MCP request path, a timeout, connection loss, or closed transport uses `outcome: "unknown"`: the server may already have completed the operation, so the result also sets `retry: false`. Protocol and business errors returned as MCP exceptions are redacted and use `outcome: "error"`. Completed responses preserve the server's `isError`, `content`, and optional `structuredContent` fields in JSON; `isError: true` also produces `outcome: "error"`.

All rendered MCP Tool and attachment content is bounded. Error messages redact resolved environment values and URLs that could contain credentials.

## Security notes

An MCP server is an external process or network endpoint with its own permissions and side effects. Review its implementation and requested headers/environment before adding it. Do not commit bearer tokens or literal secrets to the `mcp` section of `data/config.yaml`; use environment placeholders and keep the file local.

MCP calls are not subject to a separate human approval gate. Read [Security](security.md) before connecting servers that can modify files, access accounts, or perform irreversible operations.
