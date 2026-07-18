# CLI

[README](../README.md) | [Configuration](configuration.md) | [Providers](providers.md) | [Architecture](architecture.md)

portal opens on the command help screen. Run `/help` at any time to list the available top-level commands. Top-level commands and first-level subcommands support unique-prefix completion with `Tab`.

## Starting portal

Start portal from a local clone:

```bash
npm run dev
```

The only supported browser engine is `chromium`. portal checks common Edge, Chrome, Chromium, Brave, Vivaldi, Opera, Opera GX, and Arc locations where those browsers are available. Override the detected executable or remote debugging port when needed:

```text
npm run dev -- --browser-engine chromium --browser-executable-path "<browser executable path>" --browser-remote-debugging-port 9222
```

`browser.executablePath` and `browser.profilePath` accept absolute or relative paths. Relative configured paths resolve from portal's working directory. Run `npm run dev -- --help` for every startup option, or see [Configuration](configuration.md#browser) for persistent settings.

## Thread workflow

Open and manage conversations in the current portal process:

```text
/thread open gemini
/thread open chatgpt 1
/thread list
/thread switch t-1
/thread status
/thread reload
/thread detach
/thread close
/thread close t-1
```

Resume from a provider URL or local history id:

```text
/thread history
/thread resume #1
/thread resume https://chatgpt.com/c/...
```

On a successful open or resume, the new thread timeline starts with `Thread t-N is ready.` Resume then appends the visible user/assistant history from the provider's current conversation branch. Tool nodes, hidden setup messages, reasoning, and unsupported attachment content are not rendered as ordinary history messages.

`data/threads.db` stores provider metadata, conversation URLs, titles, and timestamps, not transcripts. Remote history and terminal timelines remain in memory. After portal restarts, use `/thread resume` to load the provider conversation again. Switching among already open threads restores their cached timelines without another provider request.

### Thread commands

| Command                                       | Behavior                                                   |
| --------------------------------------------- | ---------------------------------------------------------- |
| `/thread open <provider> [model]`             | Open a provider conversation and run the setup handshake   |
| `/thread list`                                | List open local threads and local turn counts              |
| `/thread history [limit]`                     | List recent conversation URL records from SQLite           |
| `/thread resume <url\|#history-id>`           | Reopen a provider conversation and display remote history  |
| `/thread switch <thread-id>`                  | Restore another open thread's in-memory timeline           |
| `/thread status`                              | Show the active thread                                     |
| `/thread reload`                              | Reload the active provider page without creating a turn    |
| `/thread close [thread-id]`                   | Close the selected thread, or the active thread by default |
| `/thread detach`                              | Return to the home timeline without closing the thread     |
| `/thread capability [name] [on\|off\|status]` | Inspect or change provider-specific web controls           |

Remote messages loaded by resume are display-only and do not increase the local turn count shown by `/thread list`. Accepted URLs, model syntax, and capability behavior are documented in [Providers](providers.md).

## Command index

| Command             | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `/help`             | Show top-level command help                          |
| `/providers`        | List supported provider ids                          |
| `/thread ...`       | Open, resume, switch, inspect, detach, and close     |
| `/skill ...`        | Add, list, enable, disable, and remove Skills        |
| `/mcp ...`          | Manage MCP servers and attach Resources or Prompts   |
| `/serve api ...`    | Start and manage the local HTTP API                  |
| `/serve mcp ...`    | Start and manage the independent Portal MCP Server   |
| `/job`              | List running `run_command` jobs                      |
| `/job stop ...`     | Stop one running `run_command` job                   |
| `/hook ...`         | Inspect, reload, enable, or disable lifecycle Hooks  |
| `/keybinding reset` | Restore and save platform-default terminal shortcuts |
| `/exit`             | Shut down portal                                     |

The live `/help` output is the source of truth for commands available in the current build. Detailed subcommands and behavior are documented under [Skills](skills.md), [MCP](mcp.md), [HTTP API](api.md), [Portal MCP Server](mcp-server.md), and [Hooks](hooks.md).

## Input controls

| Key                                                     | Behavior                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `Enter`                                                 | Submit the current input while idle                          |
| `Shift+Enter` (Windows/Linux) or `Option+Enter` (macOS) | Insert a newline when supported by the terminal              |
| `Ctrl+J`                                                | Insert a newline; reliable fallback on every platform        |
| Paste                                                   | Preserve multiline layout and normalize Windows line endings |
| `Up` / `Down`                                           | Move vertically to input boundaries, or browse input history |
| `Tab`                                                   | Complete a unique command, subcommand, provider, or `$skill` |
| `Ctrl+W`                                                | Delete the previous word                                     |
| `Ctrl+U` or `Esc`                                       | Clear the current input                                      |
| `Ctrl+C`                                                | Cancel busy work; while idle with input, clear that input    |
| `Ctrl+D`                                                | Exit while idle and the input is empty                       |

Input submission is disabled while portal is busy. Edit the complete `keybindings` table in `data/config.yaml` to change shortcuts; valid saves apply automatically. See [Configuration](configuration.md#keybindings).

## Background jobs

`run_command` displays a small live stdout/stderr tail in a temporary terminal bubble, then replaces it with a compact completion summary. The complete bounded structured result is still returned to the web model.

Cancelling the current turn with `Ctrl+C` detaches that turn's waiter but leaves the command running as a portal job. Use `/job` to inspect active jobs and `/job stop <job-id>` to stop one. Controlled shutdown stops all jobs. Jobs are not persisted across portal restarts, and forcibly killing portal can bypass cleanup guarantees.

## Browser and shutdown behavior

The dedicated browser and portal share one lifecycle. Closing or crashing the browser process, or losing its CDP connection, triggers portal's controlled shutdown and stops active threads, jobs, API, and MCP services.

Closing one provider tab does not exit portal. It cancels any active operation and closes only the thread bound to that page. If that thread was active, the TUI returns home.
