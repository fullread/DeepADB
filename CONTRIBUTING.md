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
npm test          # strict rooted Pixel 6a / Android 16 hardware profile
npm run test:emulator # portable stock-emulator profile; SDK + JDK required
npm run test:ci   # device-free suites only (what CI runs)
npm run test:browser # real Chromium CORS checks; Chrome/Edge/Chromium required
npm run coverage  # full suite under c8; writes coverage/ (lcov + summary)
node --test tests/ci/*.test.mjs # CI reporting and fixture safety, no device access
```

The device-free suites (`test-boundaries`, `test-next-version`,
`test-result-handles`, `test-supply-chain`, `test-transports`,
`test-sanitize-fuzz`, `test-sdk-compat`, `test-browser-access`, `test-local-llm`,
`test-audit-hardening`, `test-code-scanning`, `test-runtime-audit`,
`test-sensor-parsing`, `test-ui-automation`, `test-screenshot-cleanup`) run without
any hardware and are the fastest way to validate a change. A single suite can be run directly, e.g.
`node tests/test-next-version.mjs`. Device-facing changes should also run the
relevant hardware suite; the focused diagnostics use
`node tests/test-next-version-device.mjs`.

### Physical Pixel and portable emulator profiles

`DA_TEST_PROFILE` defaults to `pixel`. This preserves the rooted Pixel 6a /
Android 16 contract: exact model, bluejay/Shannon/dual-SIM firmware, Magisk,
sensor part names, ODPM power rails and root `sendevent` must pass. Missing
Pixel capabilities remain failures, not new automatic skips. `DA_TEST_PIN`
still controls the four lock/unlock checks. Unknown profile names fail startup.
This is a test setting, independent of the server's `DA_TOOL_PROFILE` policy.
Use dedicated validation hardware: full suites exercise app lifecycle, clear
the selected test package's data, grant/revoke its permission and interact with
the screen. The Pixel profile still targets Magisk for its existing app checks.

For a **disposable** stock emulator, install Android SDK platform-tools,
platform 35, build-tools 35.0.0, an emulator/system image, and a JDK (17+).
Set `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) and put Java tools on PATH, or set
`JAVA_HOME`. Boot one emulator and wait for Android startup to complete;
disconnect other devices before running. For example, in PowerShell:

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SERIAL = 'emulator-5554' # use the serial shown by adb devices
npm run test:emulator
```

The command builds a tiny test-only app. Its wrapper selects
`DA_TEST_PROFILE=emulator`, verifies the target is an online, booted emulator,
then installs the app. It refuses physical
or ambiguous targets and existing installations of the fixture package
`io.github.fullread.deepadb.fixture`. The app has no network permission and
never opens the camera; CAMERA is declared only for grant/revoke/audit tests
across API 30/33/35. Its temporary debug key and APK stay under ignored
`.test-artifacts/`, outside the published package. Screenshots and other host
outputs from each run are isolated in a fresh
`.test-artifacts/emulator-run-*` directory, so an old baseline cannot satisfy a
new test. These outputs are retained locally for diagnosis. The app is removed after the
run, including test failures. Cleanup errors fail the run too. A forcibly killed
host or disconnected emulator can prevent cleanup; inspect/remove only this
test package before retrying if the wrapper reports an existing installation.

Emulator lifecycle, intents, permission, data-clear and APK checks use that
app instead of Magisk. UI tests verify navigation actually occurred and scroll
to a target initially off screen, independent of Settings text, back stacks,
Google account overlays or locale. Sensor tests activate the emulated calibrated
accelerometer and compare results with Android's SensorManager inventory. An absent
optional sensor gets a named skip; missing fixture data or a broken parser fails.
Physical modem/firmware, ODPM/IIO and root-only assertions have explicit skips
on this profile. Other failures remain failures. This does not substitute for
the strict Pixel regression or the deferred real phone-to-watch Wear test.

After `npm run build`, `node tests/fixtures/android/build.mjs` builds just the APK and
`node .github/scripts/run-emulator-tests.mjs 33` runs the wrapper and records
`emulator-api33.log` and `emulator-api33-summary.md`. The number labels the report;
it does not create or select an API image. The scheduled workflow boots API
30/33/35 images and runs this same wrapper. Keep fixture source and both test
profiles in the validation checkout; do not deploy the fixture as part of DeepADB.

For a full on-device run, use a complete validation checkout with `src/`,
`tests/` (including fixtures), the compiled `build/`, and development dependencies.
Run `node tests/run-all.mjs` under the device's Node runtime; set `DA_TEST_PIN`
to enable lock/unlock recovery. To test a prebuilt deployment, use a separate
validation checkout whose build files match the installed artifact, keeping
test/development dependencies out of the production directory. Do not symlink
`build/` into a different installation: Node can then load separate SDK copies,
invalidating fixtures that patch the transport prototype. Type-compatibility
fixtures also require the source files; the production package alone is insufficient.

`node tests/test-runtime-audit.mjs` exercises the registered audit handler with
synthetic bridge results and never contacts ADB. It covers independent failures,
timeouts, nonzero exits, output overflow, incomplete capability rows, dependent
modem checks, target-resolution errors and preservation of successful results.
SQLite backend regressions run the handler and actual host query worker in
child processes with `node:sqlite` disabled, and verify that a device binary
cannot make host-mode inspection ready. All device probe results are synthetic;
the disabled worker fails before opening a database.
Keep failure distinct from confirmed absence, and check the complete report
rather than treating its header or a normal MCP response as proof of readiness.

Some device-free suites also run optional hardware assertions when an
authorized device is visible. Disconnect USB and wireless devices, or use an
isolated ADB configuration, when you need a strictly device-free local run.

Network-discovery negative tests must not assume TEST-NET addresses refuse TCP
connections or that an explicit range excludes ARP neighbors. The boundary
suite uses an empty range with an unavailable anchor over MCP, then synthetic
closed sockets to test the no-listener result and absence of connect attempts.
These checks never depend on or auto-connect to the developer's LAN.

For browser transport changes, also run `npm run test:browser`. It launches an
isolated headless browser with normal browser security enabled and exercises
real CORS preflights, authenticated SSE and Streamable HTTP initialization,
session headers/deletion, repeated full page reloads without retained session IDs,
restricted tool calls, and rejected Origins/headers.
Set `DA_TEST_BROWSER` to the browser executable if it is not found in a
standard installation path. It uses no Android device and does not touch your
normal browser profile.

The oversized `Content-Length` regression sends headers without a body and
requires an immediate 413, no session ID, and a successful subsequent session.
Uploading the already-rejected body can surface `EPIPE` in Android's fetch
client before it exposes the response. Keep the separate oversized chunked-body
and unfinished-upload tests; do not treat arbitrary network errors as a pass.

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

`test-screenshot-cleanup` exercises the real host and local bridge routing with
controlled device I/O, including concurrent captures, root/Termux ownership,
guest targets, allocation refusal, capture/pull/cleanup failures and incomplete
results. It also invokes all seven screenshot tool entry points and preserves
workflow per-step error reporting. Keep screenshot operations on the shared
`captureScreenshot` method; do not reintroduce caller-derived device paths or
silently ignore cleanup errors. For hardware changes, rerun analysis, lifecycle
and UI-control suites with the strict Pixel profile, then separately verify the
LocalBridge path as the Termux app user: a root-only process cannot reproduce the
original cleanup ownership mismatch.

`test-code-scanning` adds bounded bearer parsing, safe GraphQL request/resolver
errors and adversarial split-APK argument checks. It uses the real GraphQL HTTP
handler with synthetic backend failures; no device is contacted. Keep known
GraphQL limit messages in `middleware/graphql-errors.ts`, and never pass raw
backend error messages or extensions into an HTTP response. Test both thrown
request errors and errors returned inside an execution result.
The SDK compatibility suite also holds an old SSE response's close event until
after its replacement initializes, then verifies the new client remains usable.
Keep this deterministic ordering test when changing transport teardown; a
successful retry alone does not establish that a reconnect race is fixed.

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
  the emulator profile explicitly skips only its named physical-device checks
  and sensor categories absent from Android's inventory.
  Failed assertions, missing/incomplete test summaries, interrupted tests and
  emulator boot failures mark the job failed. Logs and summaries are uploaded
  even after failure. The lane is not required by branch protection; investigate
  failures individually rather than treating every hardware-related failure as
  expected. Older runs that used `continue-on-error` can show green jobs despite
  failed assertions; their logs remain the source of truth.
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
harmless fake `su`/`pm` functions. Alert #4 was dismissed as a false positive
after this review and regression run; the rule remains enabled. This is not a
blanket exemption for LocalBridge command sinks.

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
