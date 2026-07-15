# Hooks

[Back to README](../README.md)

Hooks run configured handlers at stable thread, turn, tool, and spawn lifecycle points. They are implemented below the terminal and HTTP API surfaces, so the same Hook policy applies regardless of how a turn starts.

Hooks are disabled by default. Editing `data/config.yaml` and enabling Hooks means accepting that configured command, prompt, and agent handlers can run with the current user's permissions and provider accounts.

## Configuration

```yaml
hooks:
  enabled: true
  maxDepth: 1
  handlers:
    - name: protect-commands
      enabled: true
      type: command
      events:
        - tool.before
      match:
        tool: run_command
      command:
        - node
        - hooks/protect-commands.mjs
      timeoutMs: 5000
      onError: deny
```

`hooks.enabled` is the single global switch. Each handler also has an optional `enabled` switch. A turn captures one immutable Hook snapshot when it starts; config changes affect later turns, while child `spawn` calls inherit the parent turn's snapshot.

`maxDepth` limits Hook-triggered model handlers. The default is `1`: an agent Hook can trigger another matching Hook, but the next nested level is skipped. A handler never triggers itself recursively.

## Handler types

### Command

A command handler launches the configured argv directly with `shell: false`. It receives one Hook event envelope as JSON on stdin and must write one JSON object to stdout. Relative command paths resolve from portal's current working directory.

Command handlers have bounded runtime and output. Cancellation terminates the process tree; Windows uses a Job Object and POSIX systems use process groups. stderr is used only for local error details and is not sent through the API event stream.

### Prompt

A prompt handler creates an isolated child provider runtime for one model response. It has no Tools, Skills, or MCP access. `provider` is optional and otherwise inherits the event provider.

```yaml
- name: classify-command
  type: prompt
  events: [tool.before]
  prompt: Decide whether this command is allowed.
  provider: gemini
  timeoutMs: 30000
```

### Agent

An agent handler creates an isolated multi-turn child runtime. Every Tool must be explicitly listed. `spawn` is forbidden inside agent Hooks; Skills and MCP are available only when their host tools are explicitly allowed.

```yaml
- name: inspect-patch
  type: agent
  events: [tool.before]
  match:
    tool: apply_patch
  prompt: Inspect the proposed patch and reject unsafe changes.
  tools:
    - run_command
  maxTurns: 5
  timeoutMs: 60000
```

Available host tool names are `attach_image`, `run_command`, `apply_patch`, `load_skill`, `mcp_search_tool`, and `mcp_call_tool`. Availability still depends on the runtime's configured Skills and MCP connections.

## Events

```text
thread.ready       thread.closed
turn.started       turn.completed       turn.failed       turn.cancelled
tool.before        tool.after
spawn.started      spawn.completed      spawn.failed      spawn.cancelled
```

Every event includes `eventId`, `event`, `occurredAt`, `cwd`, `source`, and `spawnDepth`, plus available provider, thread, turn, tool-call, spawn, and parent ids. Event-specific data is in `payload`.

Only `tool.before` can change execution. All other events are observational.

## Tool decisions

A `tool.before` handler must return one of:

```json
{ "action": "allow" }
```

```json
{ "action": "deny", "reason": "Command is outside the workspace." }
```

```json
{ "action": "rewrite", "params": { "command": "git status" } }
```

Handlers run sequentially in config order. A later handler sees the parameters rewritten by earlier handlers. Rewrites can change parameters only, never the Tool name. Rewritten input is preflighted again; invalid rewrites are blocked instead of falling back to the original input.

A deny produces a structured `HOOK_BLOCKED` Tool Result and feeds it back to the model. Tool records carry a stable `toolCallId`, `originalInput`, `effectiveInput`, and `rewrittenBy` list.

`onError` is `deny` or `continue`. It defaults to `deny` for handlers subscribed to `tool.before`, and `continue` otherwise. A timeout, process failure, invalid JSON response, or unavailable model handler follows this policy.

## Runtime commands

```text
/hook status
/hook reload
/hook enable
/hook disable
```

`reload` validates the complete config before atomically replacing the global snapshot. If validation fails, the prior snapshot remains active. `enable` and `disable` persist the global switch to `data/config.yaml`; active turns continue with their captured snapshot.

The HTTP API does not modify Hook configuration. Thread event streams expose bounded `hook.execution` events with handler, phase, event, duration, and correlation ids, but not handler stdout or stderr.
