# Testing

portal uses `node:test` for unit tests and deterministic local integration tests. The default suite does not open provider websites or use provider accounts.

## Commands

```bash
npm run test:type
npm run test:unit
npm run test:coverage
npm run fmt:check
```

`test:coverage` uses Node's built-in test coverage and reports source modules loaded by the suite. Coverage percentages are a diagnostic baseline, not proof that every source file or external browser path ran.

## 2026-07-15 audit

The source inventory contains 85 TypeScript or TSX files. `provider-id.ts` is type-only, and the process entry point `index.ts` is intentionally not imported by the test process. The coverage report contains the remaining executable modules loaded through the application and test entry points.

The audited Node 24.13.0 run contained 562 tests: 558 passed, 4 were skipped by platform or local-fixture conditions, and none failed. The loaded source baseline was 86.14% lines, 78.60% branches, and 80.05% functions. CI runs the same coverage command on Node 22, so compare trends within the same Node and operating-system environment rather than treating small cross-environment changes as regressions.

The audit removed migration-only checks that only proved deleted command names, configuration fields, and prompt wording were absent. It retained negative tests for current contracts such as invalid input, cancellation, cleanup, incomplete provider responses, path and size limits, and secret redaction. The generic configuration test still verifies that unsupported fields do not cause an existing file to be rewritten.

Focused tests were added for:

- Hook and HTTP API server commands;
- MCP management, validation, active-session requirements, and attachments;
- repeat attempt boundaries;
- Skill HTTP redirects, retries, timeouts, limits, and partial-file cleanup;
- Skill Hub validation and response boundaries;
- spawn input and progress-rendering isolation.

## Known gaps

| Area                            | Automated coverage                                                                        | Remaining risk                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `app.ts` lifecycle              | Focused helpers and pending-thread flows                                                  | Full CLI startup, login waits, and shutdown orchestration remain difficult to isolate without testing private wiring. |
| Browser launchers               | Launch arguments, platform defaults, and Windows job helpers                              | Real executable discovery, CDP startup timeout, and OS process cleanup require platform smoke checks.                 |
| Provider adapters and history   | Fake-page submit, completion, cancellation, parser, and history fixtures                  | Upstream DOM and protocol changes are only detectable against real provider pages.                                    |
| Runtime and thread cancellation | Runtime abort paths and operation coordinator behavior                                    | Browser-side stop behavior still depends on each provider page.                                                       |
| MCP                             | Local stdio/HTTP integration, unknown outcomes, resources, prompts, and session ownership | Remote MCP implementations and network failures can differ from local fixtures.                                       |
| Terminal UI                     | Controller state and pure rendering helpers                                               | Full interactive Ink rendering is not exercised in a real terminal in CI.                                             |

## External smoke checks

Real provider checks stay outside `npm test` because they require a browser profile, login state, network access, and provider-specific accounts. Run the manual browser checklist in [Contributing](contributing.md) after changing provider selectors, browser startup, runtime lifecycle, uploads, capabilities, or cancellation.
