# Contributing to DeepADB

DeepADB is open source and contributions are welcome. This guide covers the
practical mechanics; for how the codebase fits together, read ARCHITECTURE.md
first.

## Prerequisites

- A supported LTS Node release: Node.js 22.16 or newer on the Node 22 line, or Node 24+, for development
  including the SQLite worker regressions. The published core runtime requirement remains Node >= 22;
  host SQLite inspection specifically requires Node >= 22.16. ESLint needs >= 22.13;
  c8 12 coverage alone requires Node 22.12 or newer on the Node 22 line.
- `npm`.
- For device-dependent tests: the Android SDK platform-tools (`adb`) on PATH,
  and a connected device or running emulator. The device-free suites need
  neither.

## Setup

```
npm ci          # install exact, locked dependencies (incl. dev deps)
npm run build   # compile src/ to build/ with tsc
```

## Running tests

```
npm test          # full suite (device-dependent parts need a device)
npm run test:ci   # device-free suites only (what CI runs)
npm run test:browser # real Chromium CORS checks; Chrome/Edge/Chromium required
npm run coverage  # full suite under c8; writes coverage/ (lcov + summary)
node --test tests/ci/emulator-reporting.test.mjs # CI reporting, no device access
```

The device-free suites (`test-boundaries`, `test-next-version`,
`test-result-handles`, `test-supply-chain`, `test-transports`,
`test-sanitize-fuzz`, `test-sdk-compat`, `test-browser-access`, `test-local-llm`,
`test-audit-hardening`, `test-code-scanning`) run without any hardware and are the fastest way to
validate a change. A single suite can be run directly, e.g.
`node tests/test-next-version.mjs`. Device-facing changes should also run the
relevant hardware suite; the focused diagnostics use
`node tests/test-next-version-device.mjs`.

Some device-free suites also run optional hardware assertions when an
authorized device is visible. Disconnect USB and wireless devices, or use an
isolated ADB configuration, when you need a strictly device-free local run.

For browser transport changes, also run `npm run test:browser`. It launches an
isolated headless browser with normal browser security enabled and exercises
real CORS preflights, authenticated SSE and Streamable HTTP initialization,
session headers/deletion, repeated full page reloads without retained session IDs,
restricted tool calls, and rejected Origins/headers.
Set `DA_TEST_BROWSER` to the browser executable if it is not found in a
standard installation path. It uses no Android device and does not touch your
normal browser profile.

`test-sdk-compat` always isolates its child servers from ADB and user plugins.
It covers existing protocol revisions, legacy plugin APIs (including Zod 3),
prompt completions, public handle schemas/callbacks and their updates, typed legacy/native plugins,
authentication and reconnects. Its catalog hashes were captured
from SDK v1 before migration; update that fixture only after reviewing an
intentional tool/resource/prompt contract change. Schema dialect and
experimental task metadata are excluded from the tool hash comparison. The one
reviewed SQLite description change has an explicit expected hash in the test;
the original v1 fixture and all input contracts are retained.
Retain the cancelled/disconnected callback tests: both legacy helpers and the
adapted native request, sampling, elicitation, notification and logging helpers
must not contact the original or replacement client after abort.

Core modules use the v2 `BuiltinToolContext` and `registerTool` APIs. Existing
plugins can keep `ToolContext` and the legacy registration methods. New typed
plugins can use `NativePluginToolContext` for v2 callbacks and handles; see
ARCHITECTURE.md for the adapter's compatibility boundary. Do not remove the
v1 SDK or legacy SSE packages without a separate deprecation plan and client/
plugin compatibility tests.

Keep `full` profile behavior compatible with existing clients and plugins.
New tools do not automatically enter `inspect`: review their device operations,
then update the explicit profile set and its tests if appropriate. Restricted
profiles must not load plugins or expose indirect execution via workflows,
resources, prompts or GraphQL. Run `test-local-llm` for profile or HTTP lifecycle
changes; it also verifies that reconnecting does not reload plugin state.
Keep the lifecycle regressions for concurrent calls longer than the idle timeout,
cancellation without a response, DELETE followed by a new session, and SSE
replacement during an incomplete upload. Browser-reload regressions must also
cover competing initializers, active calls with disconnected streams, bounded
uploads, invalid replacements, retained-ID resumption, native/POST-only clients,
server-initiated stream closure, and plugin state retention. An open notification stream must not
keep an otherwise idle session alive. All these cases use isolated dummy plugins
and require no device.
Also cover concurrent and within-batch duplicate IDs, atomic rejection without
partial dispatch, cleanup after SDK validation failures, malformed cancellation,
and late work after cancellation/ID reuse. The shared/network examples in
SECURITY.md are exercised as isolated inspect deployments; command filtering
must never be described as a global read-only or per-tool rate policy.

The audit-hardening suite exercises real LocalBridge command construction,
SQLite workers and snapshot cleanup, package-path/link guards, GraphQL Origin
and work budgets, IPv6 MCP initialization, and the aggregate runner's failure
paths. Linux runs file-symlink/race cases; Windows reports an explicit skip if
its account cannot create file symlinks. Use Git for Windows' Bash for local
POSIX guard checks. These tests use synthetic files and mock device I/O.

`test-code-scanning` adds bounded bearer parsing, safe GraphQL request/resolver
errors and adversarial split-APK argument checks. It uses the real GraphQL HTTP
handler with synthetic backend failures; no device is contacted. Keep known
GraphQL limit messages in `middleware/graphql-errors.ts`, and never pass raw
backend error messages or extensions into an HTTP response. Test both thrown
request errors and errors returned inside an execution result.

The aggregate runner requires one complete, internally consistent summary per
suite. A nonzero child exit, missing/duplicate/malformed summary, failed assertion,
or empty suite selection fails the run; printed zero-failure counts cannot
turn a crashed suite green.

## CI and repository safeguards

- The Test workflow builds, lints, and runs device-free regressions on Node 22,
  24 and 26, with a separate coverage job. Mocked emulator-reporting checks run
  separately from the server regression suites.
- A separate Chrome job runs `npm run test:browser` on Node 24 with normal
  browser security enabled. Missing Chrome or failed browser assertions fail
  the job; the test never disables the sandbox or CORS enforcement.
- Dependency auditing checks both production and development dependencies;
  high and critical advisories fail the audit job. Lower-severity findings
  remain visible in its output.
- CodeQL analyzes JavaScript/TypeScript and GitHub Actions on pull requests,
  main-branch pushes, and a weekly schedule. A successful workflow means analysis
  completed, not that no alerts remain; inspect the code-scanning alert list.
- The weekly emulator lane is informational, not a merge gate. Its job
  summary reports the actual pass/fail/skip counts and execution status;
  unsupported physical-device capabilities can still fail assertions.
  A successful informational job is not proof that every test passed.
- Dependabot groups compatible development patch/minor updates. Major
  updates are reviewed separately, and TypeScript 7 is deferred until the
  lint stack supports it.
- CodeQL action version updates are grouped so `init` and `analyze` move
  together. Keep every `github/codeql-action` step pinned to the same release
  commit; mixing versions causes analysis to fail.

The protected `main` branch requires an up-to-date pull request, passing
Node 22/24 test jobs and coverage, and resolved review conversations. These
rules also apply to administrators; force pushes and branch deletion are
disabled. No additional approving reviewer is required for the solo-maintainer
workflow. New audit and analysis jobs must be validated on GitHub before they
are considered for required-check enforcement.

Code-scanning triage must follow the reported source-to-sink path. For alert
[#4](https://github.com/fullread/DeepADB/security/code-scanning/4), the split-APK
tool always selects `install-multiple`, whose path operands are resolved and
`shellQuote`-wrapped. The reported flows instead cross into `shell`, `logcat`,
`install` flags or the unknown-command fallback, which that call cannot reach.
`test-code-scanning` preserves exact argv for spaces, quotes, command
substitutions, newlines and dash-leading names in root/non-root modes using
harmless fake `su`/`pm` functions. This supports triaging that specific alert as
a false positive; it is not a blanket exemption for LocalBridge command sinks.

## Build discipline

Land changes with zero errors and zero warnings. The project compiles under a
strict `tsconfig` (`strict`, `noUnusedLocals`, `noUnusedParameters`,
`noImplicitReturns`, `noFallthroughCasesInSwitch`); a clean `npm run build` is
a hard requirement before opening a PR. The harness runs the compiled output,
so rebuild after changing anything under `src/`.

## Coding conventions

- Every source file starts with the SPDX header and a module docstring.
- Never interpolate raw user input into a shell command. Pass it through
  `shellQuote()` (or reject it with `validateShellArg()`); this is the
  command-injection boundary and is not optional. See SECURITY.md.
- Every `z.number()` parameter has an explicit `.min()/.max()`. Every parameter
  has a `.describe()` with a concrete example where it helps.
- Use ESM import specifiers ending in `.js` (NodeNext resolution), e.g.
  `import { x } from "./middleware/sanitize.js"`.
- Line endings are LF, enforced by `.gitattributes`.

## Adding a tool

See the step-by-step list in ARCHITECTURE.md ("Adding a tool"). In short:
create or extend a module in `src/tools/` exporting `registerXxxTools(ctx)`,
register it in `server.ts`, add a device-free boundary test plus on-device
coverage, and update the README tool list and CHANGELOG.

## Commits and pull requests

- Keep commits small and focused; write what changed and why.
- Before opening a PR, confirm `npm run build` is clean and
  `npm run test:ci` passes. Run the relevant device-dependent suites locally
  if your change touches device behavior.
- Update documentation in the same PR as the code: the README tool list for
  new or renamed tools, and a CHANGELOG entry for any user-visible change.

## Security

Do not introduce raw shell interpolation or widen the on-device `su` allowlist.
To report a vulnerability, follow the process in SECURITY.md rather than opening
a public issue.

## License

DeepADB is licensed under Apache-2.0. By contributing, you agree that your
contributions are licensed under the same terms.
