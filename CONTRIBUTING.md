# Contributing

[Back to README](README.md)

## Development setup

Portal requires Node.js 24 or newer. On Windows, use the version pinned in
`.github/workflows/ci.yml` until the linked Node/libuv compatibility issue is
resolved.

```bash
git clone https://github.com/kabxx/portal.git
cd portal
npm ci
npm run dev
```

Source development uses the repository's ignored `data/` directory. Never
commit browser profiles, credentials, conversation URLs, screenshots, response
captures, or generated package artifacts.

## Change workflow

- Read `AGENTS.md` and the documentation relevant to the change.
- Inspect existing behavior and tests before editing.
- Keep changes within the requested ownership boundary.
- Add focused tests for behavior, failure handling, cleanup, and security
  boundaries.
- Update user-facing documentation when commands, configuration, storage, or
  trust boundaries change.
- Run the required verification before merging.

Treat every change as breaking by default. Add compatibility aliases or
adapters only when the task explicitly requires them.

## Verification

The standard local checks are:

```bash
npm run fmt:check
npm run test:type
npm run lint
npm run test:unit
npm run test:coverage
npm run build
npm run test:package
npm audit --omit=dev
```

Browser and provider changes require the relevant lifecycle or real-profile
smoke checks. See [Testing](docs/development/testing.md) for the complete test
strategy, CI boundaries, and manual checks.

## Repository map

```text
src/
├── app/             # composition and lifecycle services
├── browser/         # Chromium discovery and lifecycle
├── cli-commands/    # TUI slash commands
├── config/          # sparse configuration and atomic updates
├── exec/            # headless one-task execution
├── hooks/           # lifecycle Hook catalog and execution
├── mcp-server/      # inbound Portal MCP Server
├── providers/       # provider adapters and parsers
├── runtime/         # setup, tool loop, and runtime state
├── skills/          # Skill registry and installation
├── terminal-ui/     # Ink rendering and input
├── threads/         # thread lifecycle and persistence
└── tools/           # local tools and job management

test/                # unit, integration, fixtures, and smoke tests
docs/user/           # user and integration guides
docs/development/    # architecture and contributor references
```

## Specialized changes

| Area                | Required reference                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Provider adapters   | [Provider Development](docs/development/provider-development.md)                            |
| Browser/runtime     | [Architecture](docs/development/architecture.md) and [Testing](docs/development/testing.md) |
| Configuration       | [Configuration](docs/user/configuration.md)                                                 |
| Skills and Hooks    | [Skills](docs/user/skills.md), [Hooks](docs/user/hooks.md)                                  |
| MCP Server          | [Portal MCP Server](docs/user/mcp-server.md)                                                |
| Security boundaries | [Security](SECURITY.md)                                                                     |

Provider selectors should prefer stable roles, test ids, data attributes, and
owned network events. Local tools, Hooks, Skills, listeners, and browser changes
must document filesystem, process, network, account, and credential impact.

## Pull request checklist

- [ ] The change stays within its intended scope.
- [ ] Relevant automated tests pass.
- [ ] Required browser or provider smoke checks were completed or their limits
      were reported.
- [ ] Configuration writes preserve unrelated user data.
- [ ] Documentation reflects user-visible and security-relevant behavior.
- [ ] No credentials, profiles, private URLs, captures, or generated artifacts
      are included.

By contributing, you agree that your contribution may be distributed under the
repository's [MIT License](LICENSE).
