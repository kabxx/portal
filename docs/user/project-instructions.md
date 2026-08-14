# Project Instructions

[Back to README](../../README.md)

Project Instructions are disabled by default. Enable them with one setting:

```yaml
projectInstructions: true
```

When enabled, portal reads exactly `AGENTS.md` from the working directory in
which the application starts. It does not search parent or child directories,
inspect a Git root, load `AGENTS.override.md` or `CLAUDE.md`, read user-level
Codex or Claude files, expand imports, or activate additional instructions when
a tool targets another directory.

The file is read once during application startup. Agent threads, spawned
runtimes, Hooks, and listener-created runtimes share that immutable snapshot.
Changing the file has no effect until portal is restarted. Resumed provider
conversations do not receive another setup turn.

If the setting is disabled, portal does not inspect `AGENTS.md`. If it is
enabled and the file is missing or empty, the Project Instructions section is
omitted from setup.

## File Requirements

`AGENTS.md` must be a regular, non-symbolic-link file containing valid UTF-8.
A UTF-8 byte-order mark is accepted and removed. The file may contain at most
32 KiB; portal rejects invalid or oversized files instead of truncating them.

When present, the setup prompt contains the file text verbatim under:

```text
## Project Instructions

<AGENTS.md content>
```

## Security Boundary

Project instruction text is sent to the web Provider and can influence a model
that has access to local tools. Review `AGENTS.md` before enabling this feature
in an untrusted repository, and do not place credentials or unrelated private
data in it. See [Security](../../SECURITY.md) for the complete tool trust model.
