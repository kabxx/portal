# Contributing

[Back to README](../README.md)

Contributions are welcome. portal is still evolving quickly, so small, focused changes with clear verification are easier to review and maintain.

## Development setup

Requirements:

- Node.js 24 or newer;
- npm;
- Git;
- a Chromium-based browser for real provider checks;
- provider accounts for the adapters you intend to verify.

Install dependencies and run the development CLI:

```bash
npm install
npm run dev
```

## Verification commands

```bash
npm test
npm run lint
npm run test:type
npm run test:unit
npm run test:coverage
npm run fmt:check
```

`lint` applies the same type-aware rules to production code and tests, and fails on warnings. `test:unit` includes deterministic local integration tests such as the MCP stdio and HTTP connection checks. `test:coverage` runs the same suite and reports line, branch, and function coverage for source modules loaded by the tests. It does not replace the manual browser checks below and must not be interpreted as coverage of provider websites or modules that the suite never imports.

Browser launcher changes also have an opt-in real CDP lifecycle check. It is not part of `npm test` or CI:

```powershell
$env:PORTAL_BROWSER_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run test:browser
```

This command uses a temporary profile to verify browser startup, connection, and process cleanup. It does not visit provider pages or require a provider account.

See [Testing](testing.md) for the current coverage inventory, audit decisions, and known gaps.

Use `npm run fmt` only when you intend to rewrite formatting. The pre-commit hook runs Prettier on staged files only and updates their staged contents automatically. Before submitting a change, review the final diff and make sure unrelated files were not modified.

Every pull request uses Windows as the primary Node.js 24 quality gate for formatting, lint, type checking, and the coverage run (which includes the full unit suite). Linux and macOS run the unit suite as compatibility checks because browser discovery and process support have platform-specific behavior.

Tests should protect current observable behavior, failure handling, cleanup, and security boundaries. Do not keep migration-only assertions whose sole purpose is proving that a removed command, field, or wording is still absent. Negative tests remain valuable when they define a current invalid-input or safety contract.

## Manual browser smoke check

The CI jobs do not open a provider website. Run `npm run test:browser` first when browser startup or cleanup changed, then use this checklist when a change affects the CLI lifecycle, a provider adapter, browser startup, or real tool execution:

1. Run `npm run dev` with a dedicated browser profile.
2. Confirm the browser connects, then run `/providers`.
3. Run `/thread open <provider>` and submit a short prompt.
4. Confirm the assistant response streams and the thread remains usable afterward.
5. Run `/thread status`, then `/thread detach` (or `/thread close <thread-id>`) and `/exit`.
6. When a provider adapter changed, repeat the relevant login, resume, upload, capability, or cancellation flow for that provider.

Do not include browser profiles, cookies, screenshots, conversation URLs, or provider response captures in a change.

## Repository layout

```text
src/
├── api/            # HTTP routes and SSE event delivery
├── cli-commands/   # slash command infrastructure and implementations
├── config/         # portal configuration parsing and atomic updates
├── hooks/          # lifecycle handlers, policy, and event dispatch
├── instructions/   # Codex and Claude Code project instruction loading
├── mcp/            # configuration, transports, per-thread sessions, rendering
├── platform/       # browser launch and OS process handling
├── processes/      # run_command job tracking and process-tree cleanup
├── providers/      # provider adapters and URL utilities
├── runtime/        # setup, tool loop, cancellation, and recovery
├── shared/         # small shared helpers
├── skills/         # skill registry, library, downloader, and validation
├── terminal-ui/    # Ink UI state and rendering
├── threads/        # in-memory thread state and SQLite history
└── tools/          # tool protocol, registry, and built-in tools

test/               # node:test unit tests and fakes
temp/               # provider samples, probes, and debug material
```

## Change guidelines

- Keep the change limited to the requested behavior or reported bug.
- Add or update tests for observable behavior.
- Preserve cancellation and cleanup behavior in long-running operations.
- Do not introduce a provider model API dependency; portal's boundary is the real web product.
- Do not include browser profiles, cookies, conversation URLs, or other local data.
- Update README or `docs/` when commands, behavior, storage, or security boundaries change.
- Keep English and Chinese README behavior, examples, and command tables synchronized.

## Provider adapter rules

Provider adapters are the highest-maintenance part of portal. When changing `src/providers/`:

- do not use translated or natural-language UI labels as selectors;
- prefer `data-testid`, `data-test-id`, stable attributes, roles, DOM structure, and protocol events;
- keep login detection, ready detection, response completion, and response parsing separate;
- keep remote-history capture and parsing separate from live submit capture;
- preserve streaming updates and cancellation behavior;
- treat model-menu positions and account-dependent capabilities as unstable;
- add parser fixtures or focused fake-page tests for every reproduced failure;
- verify the real provider page when possible, because unit tests cannot detect an upstream redesign.

If a temporary implementation must depend on visible text, call it out as a known fragile point in both code review and documentation.

## Tool changes

A tool is part of portal's local security boundary. New or changed tools should:

- use a narrow input schema;
- validate all required values;
- return errors as observations instead of crashing the runtime;
- propagate cancellation;
- keep terminal display summaries separate from full model-facing results when output is large;
- document filesystem, network, process, and credential impact in [Security](security.md).

## Skills changes

Skills changes should keep downloads and registry writes atomic, reject path escapes and symbolic links, apply bounded resource limits, and never overwrite a malformed user-edited registry.

Add tests for manifest parsing, source resolution, archive handling, state changes, runtime catalogs, and `load_skill` output. Update [Skills](skills.md) when the accepted format or lifecycle changes.

## MCP changes

MCP changes should preserve per-thread connection ownership, close transports with their runtime, isolate invalid or unavailable servers, redact resolved environment values from errors, and avoid automatically retrying calls whose outcome may be unknown.

Add focused tests for configuration parsing, environment expansion, CLI mutations, Tool cache refresh, connection isolation, Resources, Prompts, output limits, cancellation, and close behavior. Update [MCP](mcp.md) and [Security](security.md) when configuration fields, content support, or failure semantics change.

## Documentation changes

Document only behavior supported by the current code. Provider selectors and private history endpoints should be described as implementation details rather than stable upstream contracts. Check every relative Markdown link and keep examples free of real profile paths, credentials, and conversation ids.

Keep documentation ownership narrow:

- `configuration.md` owns configuration fields, defaults, and reload timing;
- `instructions.md`, `skills.md`, `mcp.md`, and `hooks.md` own their feature-specific formats and lifecycles;
- `api.md` owns HTTP routes and request shapes;
- README files provide synchronized entry points and short examples rather than duplicating complete references.

When one behavior crosses these boundaries, update the canonical reference and
link to it from the other pages. Configuration defaults must be checked against
`src/config/portal-config.ts`, and API routes against `src/api/api-server.ts`.

## Pull request checklist

- [ ] The change has one clear purpose.
- [ ] Relevant lint, type checks, and unit tests pass.
- [ ] New behavior has focused tests.
- [ ] Real browser behavior was checked when provider UI code changed, or the limitation is stated.
- [ ] Documentation reflects user-visible and security-relevant changes.
- [ ] No private profile data, response captures, or unrelated formatting changes are included.

By contributing, you agree that your contribution may be distributed under the repository's [MIT License](../LICENSE).
