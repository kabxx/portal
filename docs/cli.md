# CLI

[README](../README.md) | [Configuration](configuration.md) | [Providers](providers.md) | [Architecture](architecture.md)

portal opens on the command help screen. Run `/help` at any time to list the available top-level commands. Top-level commands and first-level subcommands support unique-prefix completion with `Tab`. Typing `/` opens a contextual command hint bubble below the input. Each hint list shows at most five rows, `Up` / `Down` browse with wraparound, and `Tab` completes the selected item. `Enter` completes the selected slash-command hint and submits it in one step; ordinary text submits unchanged.

The interactive TUI stays on the primary terminal screen, so native mouse-wheel scrolling and zoom shortcuts remain available. Completed bubbles are written to terminal scrollback while the active bubble and input remain live. After a width or height resize settles, portal clears its old layout and replays the complete active timeline at the new size; portal does not impose an additional history-row limit, although the terminal's own scrollback capacity still applies.

## Starting portal

Install and run the latest npm release globally:

```bash
npm install --global @kabxx/portal@latest
portal
```

For a one-off run, use `npx @kabxx/portal@latest`. To run from a local clone:

```bash
npm ci
npm run dev
```

The directory where `portal` starts is the workspace used by local tools and
project instructions. It is separate from portal's persistent data directory.
An npm-installed CLI uses these defaults:

| Platform | Default data directory                                                 |
| -------- | ---------------------------------------------------------------------- |
| Windows  | `%LOCALAPPDATA%\portal`                                                |
| macOS    | `~/Library/Application Support/portal`                                 |
| Linux    | `$XDG_DATA_HOME/portal`, or `~/.local/share/portal` when it is not set |

`--data-dir <path>` selects another location for one run. `PORTAL_DATA_DIR`
provides a persistent environment override, and the command-line option takes
precedence. Relative values resolve from the working directory; an absolute
environment value is safer when portal is started in different workspaces.
`npm run dev` explicitly uses the clone's `data/` directory.

The only supported browser engine is `chromium`. portal checks common Edge, Chrome, Chromium, Brave, Vivaldi, Opera, Opera GX, and Arc locations where those browsers are available. Override the detected executable or remote debugging port when needed:

```bash
portal --browser-engine chromium --browser-executable-path "<browser executable path>" --browser-remote-debugging-port 9222
```

`browser.executablePath` and `browser.profilePath` accept absolute or relative paths. Relative configured paths resolve from portal's working directory. Run `portal --help` (or `npm run dev -- --help` from source) for every startup option, or see [Configuration](configuration.md#browser) for persistent settings.

Upgrade with `npm install --global @kabxx/portal@<version>` and uninstall with
`npm uninstall --global @kabxx/portal`. Upgrading or uninstalling the package
does not delete the persistent data directory.

## Thread workflow

Create and manage conversations in the current portal process:

```text
/thread agent gemini
/thread agent chatgpt chatgpt
/thread chat chatgpt
/thread chat gemini 3.6-flash extended
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

`/thread agent` sends the full portal agent setup prompt. `/thread chat` sends only
the shared setup handshake and accepts a response containing `READY` as a
case-insensitive whole word. Both commands still construct the local runtime,
connect configured MCP servers, snapshot Skills, register tools and Hooks, and
persist the provider conversation. Chat mode does not advertise those local
capabilities to the model, but a valid model-generated tool call can still be
executed; it is not a sandbox.

After `/thread agent`, `/thread chat`, or `/thread resume` succeeds, the new thread timeline starts with `Thread t-N is ready.` Resume then appends the visible user/assistant history from the provider's current conversation branch. Tool nodes, hidden setup messages, reasoning, and unsupported attachment content are not rendered as ordinary history messages.

`threads.db` under the portal data directory stores provider metadata, conversation URLs, titles, and timestamps, not transcripts. Remote history and terminal timelines remain in memory. After portal restarts, use `/thread resume` to load the provider conversation again. Switching among active threads restores their cached timelines without another provider request.

### Thread commands

| Command                                             | Behavior                                                   |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `/thread agent <provider> [model-key] [option-key]` | Create a provider conversation with the full agent setup   |
| `/thread chat <provider> [model-key] [option-key]`  | Create with only the minimal setup handshake               |
| `/thread list`                                      | List active local threads and local turn counts            |
| `/thread history [limit]`                           | List recent conversation URL records from SQLite           |
| `/thread resume <url\|#history-id>`                 | Reopen a provider conversation and display remote history  |
| `/thread switch <thread-id>`                        | Restore another active thread's in-memory timeline         |
| `/thread status`                                    | Show the active thread                                     |
| `/thread reload`                                    | Reload the active provider page without creating a turn    |
| `/thread close [thread-id]`                         | Close the selected thread, or the active thread by default |
| `/thread detach`                                    | Return to the home timeline without closing the thread     |
| `/thread capability [name] [on\|off\|status]`       | Inspect or change provider-specific web controls           |

Remote messages loaded by resume are display-only and do not increase the local turn count shown by `/thread list`. Accepted URLs, named model keys, and capability behavior are documented in [Providers](providers.md).

## Command index

| Command             | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `/help`             | Show top-level command help                          |
| `/providers`        | List supported provider ids                          |
| `/thread ...`       | Create, resume, switch, inspect, detach, and close   |
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
| `Enter`                                                 | Complete a selected slash-command hint and submit while idle |
| `Shift+Enter` (Windows/Linux) or `Option+Enter` (macOS) | Insert a newline when supported by the terminal              |
| `Ctrl+J`                                                | Insert a newline; reliable fallback on every platform        |
| Paste                                                   | Preserve multiline layout and normalize Windows line endings |
| `Up` / `Down`                                           | Browse command hints, input boundaries, or input history     |
| `Tab`                                                   | Complete the selected hint, command, or provider             |
| `Ctrl+W`                                                | Delete the previous word                                     |
| `Ctrl+U` or `Esc`                                       | Clear the current input                                      |
| `Ctrl+C`                                                | Cancel busy work; while idle with input, clear that input    |
| `Ctrl+D`                                                | Exit while idle and the input is empty                       |

Input submission is disabled while portal is busy. Edit the complete `keybindings` table in `<data-dir>/config.yaml` to change shortcuts; valid saves apply automatically. See [Configuration](configuration.md#keybindings).

## Background jobs

`run_command` displays a small live stdout/stderr tail in a temporary terminal bubble, then replaces it with a compact completion summary. The complete bounded structured result is still returned to the web model.

Cancelling the current turn with `Ctrl+C` detaches that turn's waiter but leaves the command running as a portal job. Use `/job` to inspect active jobs and `/job stop <job-id>` to stop one. Controlled shutdown stops all jobs. Jobs are not persisted across portal restarts, and forcibly killing portal can bypass cleanup guarantees.

## Browser and shutdown behavior

The dedicated browser and portal share one lifecycle. Closing or crashing the browser process, or losing its CDP connection, triggers portal's controlled shutdown and stops active threads, jobs, API, and MCP services.

Closing one provider tab does not exit portal. It cancels any active operation and closes only the thread bound to that page. If that thread was active, the TUI returns home.
