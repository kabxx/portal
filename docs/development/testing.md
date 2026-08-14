# Testing

[Back to README](../../README.md)

portal uses `node:test` for unit tests and deterministic local integration tests. The default suite does not open provider websites or use provider accounts.

## Commands

```bash
npm run lint
npm run test:type
npm run test:unit
npm run test:coverage
npm run build
npm run test:package
npm run fmt:check
```

`lint` uses type information and applies the same zero-warning rule set to `src/`, `test/`, and shared types. `test:coverage` uses Node's built-in test coverage and fails below the global regression floors of 85% lines, 75% branches, or 75% functions. These thresholds protect the loaded-source baseline; they are not proof that every source file or external browser path ran.

The real browser launcher smoke test stays outside `npm test`. The Windows CI
job installs Playwright's matching Chromium build and runs it directly. To run
the same smoke test locally, point it at an installed Chromium-based browser:

```powershell
$env:PORTAL_BROWSER_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run test:browser
```

The smoke tests use temporary profiles and cover both an exact fixed CDP port and Chromium's dynamic port selection. They verify startup, connection, repeated close calls, and process cleanup without opening a provider website or using an account.

`test:package` builds and audits the real npm tarball, installs it with
`npm install --global --prefix` and an unavailable Git executable, executes the
installed `portal --version` and `portal --help` entry point, and verifies that
metadata commands do not create `data/` in the workspace. It confirms the
tarball has no bundled or nested npm dependencies, checks that the separately
installed Koffi package still contains `cnoke.cjs`, loads every native runtime
dependency, executes an in-memory SQLite query, and renders text through the
compiled Ink and Markdansi facades. CI builds and audits one tarball on Linux,
then Windows, Linux, and macOS globally install and smoke-test that exact
artifact.

Ink and Markdansi are exact, scoped runtime dependencies from the npm registry.
The package smoke test installs them with Git unavailable, verifies their
versions against `package.json`, and exercises both compiled facades. Start
release builds from `npm ci`; dependency upgrades must update the exact versions
and lockfile integrity together.

## Known gaps

| Area                            | Automated coverage                                                                                                                            | Remaining risk                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app.ts` lifecycle              | Minimal composition smoke with temporary config/storage, fake browser/provider boundaries, active thread operation, command job, and shutdown | Real TTY input, provider login waits, and the production browser remain manual because they cross private terminal, account, and browser wiring. |
| Browser launchers               | Launch arguments, platform defaults, Windows job helpers, and a real Chromium/CDP lifecycle smoke on Windows CI                               | Executable discovery, startup failures, and cleanup behavior on Linux, macOS, and other browser installations still require platform checks.     |
| Provider adapters and history   | Fake-page submit, completion, cancellation, parser, and history fixtures                                                                      | Upstream DOM and protocol changes are only detectable against real provider pages.                                                               |
| Runtime and thread cancellation | Runtime abort paths and operation coordinator behavior                                                                                        | Browser-side stop behavior still depends on each provider page.                                                                                  |
| Portal MCP Server               | Real SDK client integration, authentication, message operations, cancellation, and lifecycle serialization                                    | Remote clients, reverse proxies, and network failures can differ from local fixtures.                                                            |
| Terminal UI                     | Controller state and pure rendering helpers                                                                                                   | Full interactive Ink rendering is not exercised in a real terminal in CI.                                                                        |

## External smoke checks

The launcher smoke test in Windows CI covers only browser startup, CDP
connection, and cleanup with a temporary profile. It uses Playwright's matching
Chromium executable without changing Portal's normal browser arguments. The
test does not open a Provider website or exercise the full TUI lifecycle.
The deterministic app composition smoke separately runs the top-level startup
and shutdown wiring with temporary local state and injected browser, provider,
runtime, and Ink boundaries. It creates and cancels a thread operation, then
verifies that a real command job and local resources close during shutdown; it
is not a real terminal or provider test.
Real provider checks stay outside `npm test` and ordinary public CI because they
require private login state, network access, provider-specific accounts, and
careful handling of captured output. A private runner can perform those checks,
but they are not a deterministic replacement for unit tests. Run the manual
browser checklist in [Contributing](../../CONTRIBUTING.md) after changing provider
selectors, runtime lifecycle, uploads, capabilities, or cancellation.
