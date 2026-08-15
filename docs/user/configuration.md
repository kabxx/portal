# Configuration

[Back to README](../../README.md)

Portal uses one optional sparse configuration file at `<data-dir>/config.yaml`.
Missing sections use built-in defaults. If the file does not exist, Portal uses
those defaults without creating the file; it is created only after an explicit
configuration change. Run `portal config` to print the absolute path without
starting the browser or TUI.

Portal does not generate field-by-field comments or expand a sparse file into a
complete template. Commands that update configuration preserve unrelated fields
and user-written comments. Unknown fields and invalid values are rejected.

Configuration writes are serialized with `<data-dir>/.locks/config.lock` and
committed through an atomic replacement. Startup-owned values require a Portal
restart. Keybinding saves have the narrower reload behavior described below.

## Example

Every field is optional. A typical customized file can remain small:

```yaml
browser:
  executablePath: C:\Program Files\Google\Chrome\Application\chrome.exe

projectInstructions: true

mcp:
  port: 8790

keybindings:
  input.newline: [ctrl+j]
```

## Portal data directory

The startup directory is the workspace used by local tools and optional project
instructions. Persistent Portal state is stored separately:

| Platform | Default data directory                                                 |
| -------- | ---------------------------------------------------------------------- |
| Windows  | `%LOCALAPPDATA%\portal`                                                |
| macOS    | `~/Library/Application Support/portal`                                 |
| Linux    | `$XDG_DATA_HOME/portal`, or `~/.local/share/portal` when it is not set |

The data directory is selected in this order:

1. `--data-dir <path>`;
2. a non-empty `PORTAL_DATA_DIR`;
3. the platform default.

Relative overrides resolve from the startup directory. `npm run dev` uses the
clone's ignored `data/` directory. Use different data directories when separate
browser profiles or isolated Portal instances are required.

`portal config` always prints the resolved `<data-dir>/config.yaml` path, even
when the file has not been created. It does not read or modify the file.

## Browser

```yaml
browser:
  executablePath: C:\path\to\browser.exe
```

| Field            | Type     | Default                                        | Reload  |
| ---------------- | -------- | ---------------------------------------------- | ------- |
| `executablePath` | `string` | Auto-detect a supported Chromium-based browser | Restart |

Portal uses Chromium, keeps its profile at
`<data-dir>/profiles/chromium`, and asks Chromium for an available debugging
port. Those implementation values are not configurable. A relative executable
path resolves from the startup directory.

Browser startup and shutdown limits are product defaults rather than user
configuration. If a supported environment needs different behavior, report the
failure so Portal can fix the default instead of relying on local tuning.

## Project instructions

```yaml
projectInstructions: true
```

| Field                 | Type      | Default | Reload  |
| --------------------- | --------- | ------- | ------- |
| `projectInstructions` | `boolean` | `false` | Restart |

When enabled, Portal reads only `<startup-directory>/AGENTS.md`, once. See
[Project Instructions](project-instructions.md) for file limits and security.

## Portal MCP Server

```yaml
mcp:
  host: 127.0.0.1
  port: 8788
```

| Field  | Type      | Default     | Range          | Reload         |
| ------ | --------- | ----------- | -------------- | -------------- |
| `host` | `string`  | `127.0.0.1` | Non-empty      | Restart Portal |
| `port` | `integer` | `8788`      | `1` to `65535` | Restart Portal |

Authentication is configured only through `PORTAL_MCP_TOKEN`. An unset or empty
value disables authentication on exact loopback host `127.0.0.1`. Every other
host requires a non-empty token or the listener refuses to start. `/mcp token`
reports only whether authentication is configured and never prints the value.
Portal captures the address and environment token at startup, so changing any
of them requires restarting Portal, not only the listener. See
[Portal MCP Server](mcp-server.md).

## Keybindings

`keybindings` contains only actions that differ from the current platform
defaults. A configured action replaces that action's default binding; actions
not listed continue to use their defaults.

```yaml
keybindings:
  input.newline: [ctrl+j]
  input.clear: [ctrl+u, escape]
```

Supported actions are:

```text
app.interrupt
app.exit
input.submit
input.newline
input.complete
input.clear
input.deleteWordBackward
input.deleteBackward
input.deleteForward
input.lineStart
input.lineEnd
input.moveLeft
input.moveRight
input.moveUp
input.moveDown
```

Keys are case-insensitive. Supported modifiers are `ctrl`, `alt`, `shift`, and
`super`. Named keys are `enter`, `escape`, `tab`, `backspace`, `delete`, `home`,
`end`, `left`, `right`, `up`, `down`, and `space`. Chords, function keys,
unmodified printable characters, duplicates, and keys shared by multiple
actions are rejected. `[]` unbinds an action, except `input.submit`, which must
keep at least one binding.

Valid edits apply automatically. Invalid edits leave the last valid snapshot
active. `/keybinding reset` removes the overrides and restores platform
defaults.

## Skills state

Skills are managed by `/skill` and stored in the private versioned state file
`<data-dir>/state/skills.json`. They are intentionally not part of user
configuration. See [Skills](skills.md).

## Security

Keep secrets out of `config.yaml`. The MCP token belongs in
`PORTAL_MCP_TOKEN`; local browser paths should still be treated as sensitive.
On POSIX systems Portal restricts managed configuration,
state, and lock paths to the current user. Windows follows inherited filesystem
ACLs. See [Security](../../SECURITY.md).
