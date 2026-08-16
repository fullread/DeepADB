# Changelog

All notable changes to DeepADB are documented in this file.

## Unreleased

### Dependency maintenance

- Updated the MCP SDK lockfile resolution, c8 to 12.0.0, GraphQL to 17.0.2,
  and compatible transitive development dependencies. No tool or API behavior
  changed.
- Coverage with c8 12 requires Node 20.19, 22.12, or newer; the published
  runtime requirement remains Node 22.
- Verified with a clean build and lint, device-free coverage and transport
  suites, plus security and hardware-core validation on a Pixel 6a. The
  TypeScript 7 upgrade remains deferred because the current typescript-eslint
  release supports TypeScript below 6.1.

## v1.1.3 — Transitive Dependency Security & CI Hardening

Patched the transitive `hono` dependency against four advisories and shipped the
previously-unreleased CI supply-chain hardening and device-free test fixes.
Dependency lockfile, CI configuration, and test files only — no tool, API, or
behavior changes.

### Security — transitive hono dependency (4 advisories)

Bumped the transitive `hono` dependency from 4.12.18 to 4.12.23 (the four fixes
landed in 4.12.21; 4.12.22–4.12.23 followed). hono is pulled in only by
`@modelcontextprotocol/sdk@1.29.0`, whose `^4.11.4` range already permitted the
patched version — a lockfile refresh, not an SDK or API change, and hono is not
imported anywhere in DeepADB's own source. The four advisories, all fixed at
4.12.21:

- **HTTP request smuggling via `app.mount`** — percent-encoded multi-byte
  characters in the request path could route to unintended sub-application
  routes.
- **`ipRestriction` IPv6 deny-rule bypass** — non-canonical IPv6 forms
  (compressed or explicit-zero representations) skipped configured deny rules.
- **`jwt` middleware authorization bypass** — a valid JWT presented under any
  Authorization scheme, not just `Bearer`, was accepted.
- **Cookie HTTP response-splitting via `serialize`** — crafted `sameSite` or
  `priority` values could inject attributes into the `Set-Cookie` header.

DeepADB's published transport is stdio (see `server.json`), so the HTTP routing
and middleware paths these advisories concern are outside the default
configuration; the dependency is patched regardless.

### Security — CI supply-chain hardening

Hardened the CI/release pipeline against dependency- and action-level
supply-chain attacks. CI configuration only — no package or behavior changes.

- **Dependabot cooldown.** Update PRs now wait out a hold window before they are
  opened: 7 days for npm and GitHub Actions updates, 30 days for npm majors, so a
  malicious release has time to be detected and pulled before it reaches a PR.
- **npm ci --ignore-scripts in CI.** Every install step skips dependency lifecycle
  scripts, neutralizing the postinstall path that self-propagating npm worms use
  to harvest credentials when a PR runs CI. The lockfile currently declares no
  install scripts, so nothing about what is built changes.
- **SHA-pinned GitHub Actions.** Every uses: is pinned to a full commit SHA (with
  the version in a trailing comment) rather than a movable tag, closing the
  re-pointed-tag vector. Dependabot keeps the pins current.

### Fixed — device-free CI suite

- Made four device-free assertions tolerate the `ubuntu-latest` state where adb is installed but every command exits 1 (no device/server) — they previously assumed adb was either fully working or entirely absent, which had kept the Test workflow red. Test files only.

## v1.1.2 — Hardware Re-validation & Security-Test Corrections

Re-ran the full four-cell hardware matrix and corrected three security-suite
tests that were asserting outdated expectations. No tool or behavior changes —
test files only.

### Fixed — tcpdump filter sanitization test (neutralize vs. reject)

`tests/test-security.mjs` asserted that `adb_tcpdump_start` *rejects* a filter
containing shell metacharacters (`port 80; rm -rf /`). The tool intentionally
does not reject filters — a valid BPF expression legitimately needs parens,
bitwise ops, and spaces — it single-quote-wraps the filter so metacharacters are
neutralized, rejecting only the characters that can escape single quotes (`'`,
NUL, CR/LF). The old assertion only passed in ADB mode because `tcpdump` is
root-only and unreachable over a non-root ADB shell, so the tool short-circuited
on a not-found error before the filter was ever evaluated; on-device (root) it
reached the real neutralize-and-succeed path and the test failed. Rewrote the
test to skip-guard when `tcpdump` is unreachable, prove neutralization directly
(an injected `touch` marker is never created), and keep a genuine rejection
check for the single-quote case the tool does reject. Neutralization was
verified empirically — the injected command does not execute.

### Fixed — gracefulKill signal-code race

Two `gracefulKill`/`gracefulKillAll` assertions read a force-killed child's
`signalCode` immediately after `gracefulKill` returned. `gracefulKill` sends
`SIGKILL` and returns without awaiting the exit event, so `signalCode` was still
null when read — a test race, surfaced only on-device (the cooperative-SIGTERM
case happens to exit within the awaited grace window). The tests now await the
child's exit before asserting, and accept either a `SIGKILL` signal-code or a
signal-terminated child (null code with null exit) for platform portability. The
production `gracefulKill` was left unchanged — it correctly kills the child;
only the test's read timing was wrong.

### Hardware matrix (re-validated, all four cells)

Re-ran the full suite fresh on hardware (Pixel 6a, Android 16, Termux + Magisk +
QEMU 10.2.1) in all four configurations with the corrected tests — **0 failures
in every cell**:

- **ADB mode, no PIN:** 556 passed / 0 failed / 21 skipped (577 total).
- **ADB mode, with PIN:** 560 passed / 0 failed / 17 skipped (577 total).
- **On-device mode, no PIN:** 606 passed / 0 failed / 7 skipped (613 total).
- **On-device mode, with PIN:** 610 passed / 0 failed / 3 skipped (613 total).

The host/ADB total is 577 and on-device is 613; the difference is the QEMU
virtualization and Alpine VM-boot suites, which run only on-device. The security
suite is 93/0/12 in ADB mode (tcpdump and gracefulKill skip-guarded on a
non-root, Windows host) and 116/0/0 on-device (both run under root + POSIX).

## v1.1.2 — CI, Coverage, Transports & Lint

Tooling and hardening pass: continuous-integration and coverage infrastructure,
a transport test suite exercising the previously-untested HTTP/SSE, WebSocket,
and GraphQL paths, property-based fuzzing of the shell sanitizers, ESLint with a
zero-warning bar, and contributor documentation. Includes one real bug fix
surfaced by the new transport tests.

### Fixed — GraphQL root resolvers (shipped broken)

The standalone GraphQL API (`DA_GRAPHQL_PORT`) returned an `Expected Iterable`
error for its root queries (`devices`, `device`). The custom `fieldResolver`
fell back to returning `source[fieldName]` without invoking function-valued root
resolvers, so `Query.devices`/`Query.device` resolved to the resolver function
object instead of its result. With no test coverage on the GraphQL transport,
this had been broken since it shipped. The fallback now invokes function-valued
fields with the field args, matching graphql-js default-resolver semantics.
Covered going forward by the new transport suite.

### Transport smoke tests (new, +8)

`tests/test-transports.mjs` boots `build/index.js` on an ephemeral port for each
transport and performs a real protocol round-trip: an MCP `tools/list` +
`resources/list` over HTTP/SSE and over WebSocket (204 tools confirmed on each),
the `/health` endpoint on all three, and a `{ devices }` query plus introspection
over GraphQL. Device-free and in the `--ci` set. `ws` and `graphql` were added as
devDependencies so the optional transports are testable; they remain optional for
end users.

### Sanitizer fuzzing (new, +19)

`tests/test-sanitize-fuzz.mjs` property-tests the shell-safety primitives in
`src/middleware/sanitize.ts` with `fast-check`: round-trip faithfulness of
`shellQuote`/`shellEscape` (a POSIX single-quote decoder serves as the oracle),
the metacharacter-rejection invariant of `validateShellArg`, never-throws
robustness, and `validateShellArgs` composition — thousands of generated,
metacharacter-dense inputs per property, plus fixed attack-vector regression
cases. Device-free and in the `--ci` set.

### Continuous integration

`.github/workflows/test.yml` runs on push to main and on pull requests: build,
lint, and the device-free suites across a Node 22.x/24.x matrix, plus a coverage
job that uploads an lcov artifact. Added a `--ci` filter to `tests/run-all.mjs`
(restricts the run to the five device-free suites) and a `test:ci` script.

### Code coverage

Added `c8` with a `coverage` script (`npm run coverage`) and `.c8rc.json`
(source-map remapped to `src/`, lcov + text-summary reporters, `coverage/`
gitignored).

### Lint (ESLint, zero warnings)

Added a flat-config ESLint setup (`eslint.config.mjs`) over the recommended JS +
typescript-eslint rule sets, a `lint` script, and a CI lint step. Brought the
source to zero warnings:

- Removed ten unnecessary regex escape characters across `files.ts`,
  `firmware-analysis.ts`, `network-capture.ts`, and `sensors.ts`.
- Replaced four `any` usages: the two `as any` casts at the GraphQL execution
  call were removed by widening the dynamic-import `graphql` arg type with
  `variableValues?: unknown`; the sensors IIO-read bridge shim now types its
  options as `AdbExecOptions`.
- Attached the caught error as `cause` on a re-thrown JSON parse error
  (`fetch-utils.ts`), removed a dead assignment and an unused caught binding
  (`health.ts`), and replaced a zero-width space in a doc comment with a normal
  space (`fs-utils.ts`).
- Configured `no-unused-vars` to honor the existing underscore-prefix convention.

### Compiler strictness

Enabled `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, and
`noFallthroughCasesInSwitch` in `tsconfig.json`. This caught three dead-code
issues, all removed: an unused `before` in `result-handle.ts`, a leftover
`ATTR_REGEXES` alias and its orphaned import in `accessibility.ts`, and an unused
`stderr` callback parameter in `emulator.ts`.

### Repository hygiene

- `.gitattributes` normalizes line endings to LF (policy only; existing files are
  renormalized in a separate commit).
- `.github/dependabot.yml` schedules weekly npm and GitHub-Actions updates.
- `.github/workflows/emulator.yml` adds a best-effort, non-gating emulator lane
  (manual or weekly) across an API-level matrix for Android-version diversity. A
  stock emulator cannot satisfy the baseband, sensor, on-device-virtualization,
  or root tools, so partial failures there are expected by design.

### Documentation

- `ARCHITECTURE.md` (new): layered design, request lifecycle, the two bridges,
  transports, the security boundary, the testing model, and how to add a tool.
- `CONTRIBUTING.md` (new): setup, test commands, build discipline, coding
  conventions, and the PR process.
- `.github/ISSUE_TEMPLATE/` (bug + feature) and `.github/PULL_REQUEST_TEMPLATE.md`.
- `SECURITY.md`: added an explicit sanitizer guarantees-and-verification note
  pointing at the new fuzz suite.
- Corrected the README architecture-diagram counts (45 tool modules, 5 resources).

### Dependencies (devDependencies only)

Added `ws`, `graphql`, `c8`, `fast-check`, `eslint`, `@eslint/js`, and
`typescript-eslint`. `npm audit` reports 0 vulnerabilities.

### Test suite

**558 passed, 0 failed, 18 skipped (576 tests).** Up from 531/0/18 — the +27 are
the new transport (8) and sanitizer-fuzz (19) suites, both device-free, with zero
regressions across the source changes (GraphQL root-resolver fix,
compiler-strictness dead-code removal, and the lint fixes). The 18 skips remain
the legitimate environmental cases (on-device-only QEMU, PIN-gated screen-lock,
POSIX-only signal tests). Device-free `--ci` subset: 148 passed / 0 failed.

## v1.1.2 — Test Coverage Completion

Test-suite audit and coverage improvements. No source/behavior changes — test files only.

### Device-free boundary coverage (+20 tests)

Added Zod-boundary tests in `tests/test-boundaries.mjs` for 16 tools that previously had zero test references. Each assertion triggers schema rejection at the MCP boundary before any device communication or destructive side effect (radio toggles, reboots, installs, builds, mirroring), so they run without a device:

- **Enum constraints**: adb_location (mode), adb_reboot (mode), adb_farm_matrix (type), adb_emulator_start (gpuMode)
- **Numeric bounds**: adb_airplane_cycle (delaySeconds), adb_gradle / adb_build_and_install / adb_ci_run_tests (timeout), adb_mirror_start (maxFps)
- **Regex / array**: adb_mirror_start (bitrate format), adb_install_bundle (non-empty apkPaths)
- **Required-parameter types**: adb_wifi / adb_mobile_data / adb_airplane_mode (boolean enabled), adb_install (apkPath), adb_uninstall (packageName), adb_farm_run (testApk)

Device-free tool coverage rose from 88% to 96% (180→196 of 204 tools referenced). The remaining 8 uncovered tools (adb_bugreport, adb_farm_results, adb_emulator_stop, adb_mirror_stop, adb_market_export, adb_market_install, adb_registry_install, adb_multi_install) require live hardware, an APK, or an external registry and cannot be meaningfully unit-tested.

### Assertion precision (testMatch adoption)

Converted four `testContains` substring checks to the harness's regex-based `testMatch` (previously defined but unused):

- `test-shell-files.mjs` — `date` output: hardcoded `"2026"` → `/\b20\d\d\b/`. Fixes a latent failure that would have triggered on 2027-01-01.
- `test-files-extended.mjs` — grep line number `"2:"` → `/^2:/m` (line-anchored, no longer matches "12:"/timestamps); replace count `"Lines with matches: 2"` → `/Lines with matches: 2\b/` (rejects "20"); grep count `"1 match"` → `/\b1 match\(es\)/` (rejects "21 match(es)").

### Device-absence resilience

Seven device-dependent assertions in `tests/test-boundaries.mjs` (package info, data clear, APK extraction, baseband read, and three multi-device checks) previously failed hard when no authorized device was attached — inconsistent with the graceful auto-skip already used in `test-result-handles.mjs` and the QEMU suites. Added a shared `deviceAvailable` probe (queries `adb_devices` for an authorized `(device)` connection) and guarded those seven so they skip cleanly with a "no device authorized" reason instead. Verified both branches: 78/0/0 with a device connected, 71/0/7 (zero failures) when no device is available. The suite is now robust to a deauthorized or detached device in any environment.

### Test suite

**531 passed, 0 failed, 18 skipped (549 tests).** Up from 511/0/18; +20 new tests, zero regressions. The 18 skips remain the legitimate environmental cases (POSIX-only signal tests, on-device-only QEMU, PIN-gated screen-lock).

## v1.1.2 — Dependency Updates

Pre-release dependency sweep and Zod v3 → v4 upgrade.

### Direct dependency updates

- **zod**: `^3.25.0` → `^4.4.3` (major version). Migration cost: one line — `z.record(z.string())` in `workflow.ts` adb_workflow_run was updated to the explicit two-arg form `z.record(z.string(), z.string())` (the single-arg form was dropped in v4). The two-arg form is forward-compatible with v3 as well. Zero test regressions: 511 passed / 0 failed / 18 skipped, identical to the v3 baseline.
- **@types/node**: `^25.6.0` → `^25.9.1` (minor). Dev-only.
- **qs** (transitive, via @modelcontextprotocol/sdk → express): patched to ≥6.15.1 via `npm audit fix` to close [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26) — moderate-severity DoS in `qs.stringify` with comma-format arrays and `encodeValuesOnly`. DeepADB doesn't directly use qs; the fix is a clean-up for release.

### Zod v4 deprecation cleanups

Two call sites were preemptively migrated off APIs deprecated in v4 (still functional but emit warnings, scheduled for removal in v5):

- `src/tools/input-gestures.ts` — `z.string().url()` → `z.url()` for the adb_open_url URL parameter. String formats are now top-level subclasses in v4 instead of refinements on `ZodString`.
- `src/tools/device-profiles.ts` — `z.object({...}).passthrough()` → `z.looseObject({...})` for the deviceProfileSchema (Z1 fix). The looseObject API is the v4 replacement for the passthrough modifier; allows extra fields while keeping the known shape locked. Inline comment updated to reflect the new API.

### Why the migration was cheap

DeepADB's zod surface is deliberately narrow: primitive types + `.describe()` + `.optional()` + `.default()` + `.min/.max/.regex` + a handful of `.refine(predicate, "string message")` and `z.enum`. No use of `.transform()`, `.coerce.*`, schema composition (`.merge`, `.extend`, `.pick`, `.omit`, `.partial`, `.deepPartial`), type inference helpers (`z.infer<>`, `z.input<>`, `z.output<>`), or internal types (`_def`, `ZodEffects`, `ZodBranded`). These are the surfaces that v4 reshapes most heavily; not using them meant the migration was a one-line change.

### Acknowledged but not migrated

- `.refine(predicate, "string message")` at `src/tools/files.ts:L1302-1303` still uses the string form, which is supported in v4. Only the function-as-second-argument form `(`.refine(predicate, val => ({ message: ...}))`)` was dropped.
- The `.error.issues` access in test-boundaries.mjs was already using the v4-compatible API (v3 had both `.errors` and `.issues`; v4 keeps only `.issues`).

### Test suite

**511 passed, 0 failed, 18 skipped (529 tests).** No regressions across the upgrade. Identical pass count to the pre-upgrade baseline.

## v1.1.2 — Result Handle Primitive

A new primitive for preserving expensive tool results across context
compaction. Ten Tier A tools now accept an optional `result_handle`
parameter; when provided, their output is stored host-side under a
`result://<tool>/<name>` URI that can be retrieved via dedicated
discoverability tools or by reading the URI as an MCP Resource. This
directly addresses the gap acknowledged in v1.1.1: of ~190 one-shot
tools, none had a compaction-resistance story beyond "re-run the tool."

### New Primitive

- **Result handles** — host-side key-value store for tool responses,
  keyed by `<tool>/<name>`. Operator-supplied names (1-32 chars,
  `[a-zA-Z0-9_-]`). Storage is tempDir-backed (survives server restart
  within TTL), per-auth-token-isolated (each `DA_AUTH_TOKEN` value
  resolves to its own namespace via SHA-256), and bounded by a
  configurable triple cap (per-handle bytes / total store bytes /
  total handle count) with hybrid TTL + LRU eviction.

- **Three discoverability tools:**
  - `adb_result_list` — enumerate active handles with size, age,
    expiry, last-access metadata
  - `adb_result_get` — retrieve content by `<tool>/<name>` (preserves
    original block structure)
  - `adb_result_drop` — delete by `<tool>/<name>`, or wipe the
    namespace with `all=true`

- **MCP Resource scheme** — `result://<tool>/<name>` resolves through
  the standard `resources/read` interface, returning flattened text.
  The template is intentionally non-enumerable (`list: undefined`) so
  `resources/list` does not leak active handle names; discoverability
  goes through the auth-gated `adb_result_list` tool.

### Tier A Tool Wiring (10 tools)

The following tools now accept an optional `result_handle` parameter
plus an optional `result_handle_ttl` override:

- `adb_firmware_diff` — stored as `result://firmware_diff/<name>`
- `adb_baseband_info` — `result://baseband_info/<name>`
- `adb_dumpsys` — `result://dumpsys/<name>`
- `adb_logcat` — `result://logcat/<name>`
- `adb_logcat_poll` — `result://logcat_poll/<name>`
- `adb_find` — `result://find/<name>`
- `adb_grep` — `result://grep/<name>`
- `adb_screenshot_diff` — `result://screenshot_diff/<name>`
- `adb_screenshot_baseline` — `result://screenshot_baseline/<name>`
- `adb_screenshot_history` — `result://screenshot_history/<name>`

Wiring is opt-in: calling these tools without `result_handle` produces
exactly the same behavior as before. With `result_handle`, the tool's
response gains a footer block describing the stored URI; retrieval
returns the original response unchanged (no footer in the stored
content). Responses below 64 bytes are refused with a clear message
("cheaper to regenerate than store"); responses above 5 MB per handle
are also refused.

### Storage Module

`src/middleware/result-handle.ts` (399 lines). Public API: `storeResult`,
`getResult`, `listHandles`, `dropHandle`, `dropAllHandles`,
`startupSweep`, `getTokenHash`, `getStoreRoot`. Internal helpers cover
atomic write (.tmp + rename), defensive size cap re-check on every
read, sidecar-JSON layout (one content.json + one meta.json per
handle), and lazy TTL + cap-driven eviction. The store layout is
`<tokenHash>/<tool>/<name>.{content,meta}.json` under a single root
directory configurable via `DA_RESULT_HANDLE_DIR`.

A `startupSweep()` is called once at server initialization to enforce
TTL and size caps against handles persisted from prior sessions.
Reports only when something is swept (silent on first run).

### Helper Layer for Tier A Wiring

`resultHandleSchemaFields` (Zod fragment) and `withResultHandle()`
(response wrapper) exported from `src/tools/result-handles.ts`. Tools
opt in with two changes: spread the schema fragment into their args,
and wrap their success return with `withResultHandle()`. Expanding to
Tier B in a future release is mechanical given the helper pattern.

### Test Suite

New `test-result-handles.mjs` (19 tests, 0 failures):

- **Tier 1 (no device):** discoverability tools' empty-state behavior,
  error paths for `adb_result_drop` (mode conflicts, invalid names),
  MCP Resource resolution for nonexistent handles
- **Tier 2 (device required, auto-skips when unauthorized):** end-to-end
  round-trip via `adb_dumpsys` (store → list → get → resource read),
  collision overwrite (same name overwrites in place, list count stays
  at 1), tool-side schema validation of `result_handle` name, drop
  semantics, drop-all idempotency

New harness primitives `readResource(uri)` and `getResourceText(response)`
were added in support; these are usable by future Resource-testing work.

### Documentation

- README adds a "Result Handles" section under Key Features explaining
  the use case (preserving expensive results across compaction), the
  three discoverability tools, the URI scheme, the Tier A opt-in
  pattern, and the per-token-hash isolation model.
- README env-var table adds 5 rows for `DA_RESULT_HANDLE_*` knobs.
- README "MCP Resources" count bumped from (4) to (5) with the
  result-handle resource added.
- SECURITY.md adds a "Result Handle Storage" section covering threat
  model (per-token-hash isolation), TTL bounds (60s-7d, default 12h),
  rationale for tempDir-backed persistence, and operator override knobs.
- `result-handles.ts` and `result-handle.ts` (middleware) carry full
  inline documentation of the storage layout, idempotency rules, and
  eviction policy.

### Tool & Module Counts

The new module brings the totals to **201 tools across 45 modules**
with **5 MCP Resources** (the previous 4 device-state resources plus
the new result-handle resource template).

## v1.1.2 — Security & Correctness Hardening

A multi-session audit pass over the line-by-line review at
`private-docs/deepadb-main-audit-051226.md` produced twelve ordered
remediation items plus follow-up sweeps, closing 61 unique audit
findings across 22 source files. Tightens shell-command safety, path
containment, filesystem atomicity, network-transport bounds, and
documents the trust models for plugin loading, rate limiting, and
workflow variable substitution. Pairs with the Supply Chain Hardening
section below and shares the same release; nothing in either section
reopens what the other closes.

### Path Containment

- **New shared `isWithinDir(candidate, dir)` middleware** in `fs-utils.ts`,
  separator-aware (recognizes both `/` and `\`). Replaces multiple ad-hoc
  `startsWith` checks that passed sibling directories sharing a string
  prefix (e.g., `/tmp/plugins_evil/x` against `/tmp/plugins`). The qemu.ts
  local helper that had the correct pattern now delegates to the shared
  helper.

- **Six user-supplied path parameters scoped to `tempDir`** across five
  tool modules: `adb_snapshot_compare`, `adb_snapshot_restore_settings`,
  `adb_regression_check`, `adb_ota_compare`, `adb_thermal_compare`, and
  `adb_mirror_start` (scrcpy `--record` path). Each rejects out-of-tempDir
  paths with an explicit error naming `tempDir` before any filesystem
  access. A misled LLM steered to read `/etc/passwd` or write a video file
  outside `tempDir` is rejected at the schema layer.

- **APK extraction containment** in `split-apk.ts` — the `adb_extract_apks`
  tool's user-supplied `outputDir` is now correctly bounded to `tempDir`
  using the shared helper.

- **Plugin path containment fixed** in `registry.ts`. The previous bare
  `startsWith` check passed sibling directories that share a string
  prefix; replaced with the new shared `isWithinDir` helper that uses a
  path-separator boundary.

### Shell Command Safety

- **R1 cluster sweep** — 15 sites across 6 files where identifiers were
  interpolated unquoted into shell templates are now wrapped with
  `shellEscape()`. `validateShellArg` continues to provide the
  metacharacter input filter; `shellEscape` adds defense-in-depth against
  globs (`*?[]`) that `validateShellArg` deliberately permits. Files
  touched: `regression.ts`, `test-gen.ts`, `thermal-power.ts`,
  `split-apk.ts`, `ci.ts`, `diagnostics.ts`.

- **Settings restore word-splitting fixed** —
  `adb_snapshot_restore_settings` now wraps both the key and value with
  `shellEscape()`. Previously a value like `"hello world"` would
  word-split into multiple shell arguments, silently corrupting the
  restored setting.

- **Transient-error pattern narrowing** in `adb-bridge.ts`. The retry
  classifier now anchors each phrase to its adb-style prefix
  (`"error: closed"` not bare `"closed"`; `"connection reset by peer"`
  not bare `"Connection reset"`) so a tool whose user output happens to
  contain `"closed"` is not misclassified as transient and retried.

- **Hostname format validation** in `wireless.ts`. New module-level
  `hostSchema` and `hostSchemaOptional` Zod schemas validate IPv4:port,
  [IPv6]:port, and hostname:port. Applied to all three `host` fields
  (`adb_pair`, `adb_connect`, `adb_disconnect`). Argv-mode invocation was
  already injection-safe; this catches user errors at schema validation
  time with a clear message.

- **`adb_grep` recursive mode** in `files.ts` now uses
  `find ... -type f -exec grep {} +` instead of `find ... | xargs grep`.
  The terminating `+` batches files into one grep invocation (matching
  xargs throughput) while correctly handling filenames containing
  whitespace, quotes, or newlines.

### Filesystem Atomicity

- **9 `writeFileSync` call sites converted to `writeAtomicSync`** across
  6 files (`workflow-market.ts` x2, `test-gen.ts`, `ota-monitor.ts`,
  `device-profiles.ts` x2, `thermal-power.ts`, `registry.ts` x2). All
  persistent state files are now written via the unique-per-call `.tmp` +
  rename pattern, defending against mid-write crashes leaving corrupt
  data, concurrent readers seeing partially-written files, and concurrent
  writers racing on `.tmp` filenames.

- **UI-dump path collision-defended** — `middleware/ui-dump.ts` default
  path now embeds `process.pid`, `Date.now()`, and 4 random bytes, so
  concurrent `captureUiDump()` calls within the same millisecond cannot
  collide on the same filename.

- **Destination-space pre-flight in `adb_file_copy`** — `files.ts` now
  parses the `df -k` output that was previously captured but unused,
  extracts available KB, applies 5% slack to source size, and returns an
  error before `cp` if there isn't enough room. Prevents partial
  destination files from mid-write `ENOSPC`.

### Filename Sanitization

- **`sanitizeFilenameComponent` consolidated and extended** with an
  optional `maxLen` parameter and empty-input coercion to `_`. New
  `sanitizeFilenameComponentDotted` variant preserves Android-style
  package identifiers (`com.example.app`) while defanging pure-dot
  sequences (`.`, `..`, `...`) so a caller cannot be steered into
  parent-directory traversal via the result. 8 caller modules now use
  the shared helpers (a local helper in `screenshot-diff.ts` was deleted
  in favor of the shared one).

### Defense in Depth

- **PNG pixel writer y-bound check** — `setPixel` in
  `middleware/png-utils.ts` now takes `imgHeight` and rejects out-of-range
  y the same way it already rejected out-of-range x. Both existing
  callers pre-check bounds, but a future caller forgetting the check
  could silently corrupt a different scanline. 6 internal call sites
  updated.

- **Redirect re-validation on external fetches** — `fetch-utils.ts` was
  rewritten with manual redirect handling. The previous default-follow
  behavior would have silently traversed an `https://` -> `http://`
  redirect from a compromised registry endpoint, bypassing the initial
  protocol allowlist documented in the Supply Chain Hardening section.
  New behavior: every redirect target is re-validated via a new exported
  `requireHttps(url, context)` helper, with `MAX_REDIRECTS = 5` and a
  single `AbortSignal.timeout(30_000)` shared across all hops, header
  arrival, and body read (so the 30 s budget bounds the entire operation,
  not 30 s x N). Redirect response bodies are eagerly cancelled to free
  the connection. `304 Not Modified` is treated as terminal.

### Network Transport Limits

- **WebSocket payload cap** — `ws-transport.ts` now sets
  `WS_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024` (10 MB) and passes it at
  `WebSocketServer` construction. Replaces the `ws` library's 100 MB
  default. 10 MB is generous for MCP JSON-RPC messages (which are
  normally sub-100 KB) while bounding worst-case memory pressure.

- **GraphQL query depth limit** — `graphql-api.ts` now rejects queries
  whose nesting depth exceeds `GRAPHQL_MAX_QUERY_DEPTH = 10`.
  Brace-counting (skipping strings and `#` comments) is a conservative
  proxy for AST depth analysis; sufficient because GraphQL uses `{` only
  for selection sets and inline fragments.

- **SSE transport close-on-replace** — `http-transport.ts` now explicitly
  `await activeTransport.close()` before replacement when a new SSE
  connection arrives. Previously the old transport's response stream
  stayed open until GC, briefly leaking a file descriptor.

### Threat-Model Documentation

- **Rate-bucket design** (`middleware/security.ts`) — Documented why the
  rate limiter uses a single global bucket under the single-operator
  threat model: it backstops accidental tool-call fan-out (LLM loops),
  not fairness among competing clients. Documents the `Map<key, bucket>`
  upgrade path with a memory-bound warning for future multi-client work.

- **Plugin loading trust model** (`tools/plugins.ts`) — Documented that
  `loadPlugins()` performs no signature/hash verification on plugin
  files because the operator controls the plugin directory and
  registry-installed plugins already get SHA-256 verification via
  `registry.ts`. Documents the stronger-model upgrade path: Ed25519
  signature against a pinned key, mtime-vs-manifest check, world-writable
  startup warning.

- **Workflow variable substitution** (`tools/workflow.ts`) — Documented
  the trust model of `substituteVars`: `{{key}}` substitution is a raw
  textual replacement with no shell escaping. Two sources feed variables:
  operator-supplied (workflow JSON + invocation params) and
  device-controlled (`vars[step.capture] = result` — captured stdout from
  a previous step). Per-call-site safety is itemized: `case "shell"` and
  `case "root_shell"` rely on the security middleware's blocklist as a
  backstop; `case "install"` uses argv style; `case "logcat"` and
  `case "getprop"` validate after substitution. Documents the per-step
  provenance-tracking upgrade path for stronger models.

- **`RESTRICTED_PATH_PATTERNS` clarifying comment** in
  `bridge/local-bridge.ts` — the substring match against the raw command
  (which over-triggers `su` wrapping on harmless `echo '/sdcard'`) is
  documented as deliberate conservative bias, with a do-not-optimize
  warning explaining why the over-trigger direction is safe and the
  alternative is not.

### Changed

- **`/sdcard/` -> `/data/local/tmp/`** for internal device-side temp paths.
  7 sites flipped across 6 files (`middleware/ui-dump.ts`,
  `tools/input-gestures.ts`, `tools/screenshot-diff.ts`, `tools/testing.ts`,
  `tools/ui.ts` x2, `tools/workflow.ts`). `/data/local/tmp/` is owned by
  the shell user, accessible in both rooted-on-device and standard ADB
  modes, and not subject to Android 16+ scoped-storage restrictions on
  `/sdcard/`. The two `/sdcard` references in `tools/files.ts` are
  intentionally preserved — they are Zod defaults for `adb_files_list` /
  `adb_files_find` browse-start directory params, where `/sdcard` is the
  correct UX (user-visible storage).

### Breaking Changes

- **`adb_gradle` `args` parameter is now `array of string` instead of
  `string`.** The previous `args.split(" ")` naively whitespace-split the
  string, mangling args containing quoted values like
  `-Pmessage='hello world'`. Callers must now pass an array:
  `["-Pversion=1.0", "--info"]`.

- **`maskBits` in `tools/qemu.ts` uses `BigInt`** so cores with ID >= 32
  don't wrap (JS bitwise ops are 32-bit). Practical irrelevance on phones;
  correctness on server-class ARM systems with 32+ cores.

### Fixed

- **Atomic-write helper unique suffix** — `.tmp` filenames embed process
  pid + timestamp + 4 random bytes so concurrent writers to the same
  target path each pick their own `.tmp`.

- **`mkdirSync` private-mode permissions** — `ensurePrivateDir` helper
  applied codebase-wide creates directories with mode `0o700` on Unix,
  defending against other-user reads on shared hosts.

- **`result-handle.ts` structural validation** — stored meta now validated
  by `isValidMeta` type guard.

### Tests

- **45 new unit tests** added across 2 test files:
  - `test-supply-chain.mjs` (+10) — covers the `requireHttps` redirect
    validator across every non-https scheme, positive control, and
    context-message preservation.
  - `test-security.mjs` (+35) — covers `sanitizeFilenameComponent` and
    `sanitizeFilenameComponentDotted` (24 tests), plus `isWithinDir`
    (11 tests including the explicit sibling-with-shared-prefix bypass
    case).

- **Combined suite: 118 passing, 1 Windows-skip** (75 `test-security` + 24
  `test-supply-chain` + 19 `test-result-handles`). The skip is the
  `/bin/sh` round-trip in QEMU shell-escape tests, intentionally skipped
  on Windows hosts.

- Build is clean (`tsc` zero errors).

## v1.1.2 — Supply Chain Hardening

Five hardening items plus the dependency security patch for newly-disclosed
transitive vulnerabilities. Lockfile changes account for the dependency half;
the hardening half is source-level changes to `registry.ts`, `workflow-market.ts`,
and `fetch-utils.ts` plus a new release workflow.

### Supply Chain Hardening

- **Mandatory SHA-256 integrity verification on plugin and workflow installs.**
  `registry.ts` and `workflow-market.ts` now refuse to install any registry
  entry that lacks an `sha256` field in the manifest. The previous behavior
  was to log a warning and proceed, which left manifest integrity dependent
  on whoever controls the manifest. Refusing without a hash forces the
  ecosystem toward consistent hash-publishing discipline; legitimate
  registries (including a private/internal one) can always add hashes.

- **Soft fail-closed default registry/marketplace URLs.** Previously,
  `DA_REGISTRY_URL` and `DA_WORKFLOW_REGISTRY_URL` fell back to a hardcoded
  default pointing at a GitHub namespace DeepADB does not own. v1.1.2
  removes the default; registry/marketplace tools are still registered but
  return a friendly "registry not configured" error until the operator
  sets the env var to a manifest URL they trust. Selecting the source is
  an operator-side supply-chain decision and should not be silently
  inherited from a default that DeepADB cannot vouch for.

- **HTTPS-only protocol allowlist on external fetches.** `fetch-utils.ts`
  now rejects any URL not beginning with `https://` before any network
  call is made. Defends against SSRF (`file://`, `http://internal.rfc1918`),
  plaintext credential leak (`http://`), and content injection via `data:`
  or `javascript:` URLs. Tests that need to exercise post-fetch parsing
  should mock at the `fetchText`/`fetchJson` function level rather than
  feeding non-https URLs through the real fetcher.

- **30-second request timeout on external fetches.** `fetch-utils.ts` now
  passes `signal: AbortSignal.timeout(30_000)` on every fetch. The signal
  covers both header arrival and body read, so a slow-drip server tripping
  the streaming size cap is no longer an unbounded hang risk. Combined
  with the existing 5 MB body cap, external fetches are now strictly
  bounded in both time and space.

- **npm publish workflow with Sigstore provenance.**
  `.github/workflows/release.yml` triggers on `v*` tag push, builds, and
  publishes to npm with `--provenance --access public`. Provenance
  attestations let downstream consumers verify the published tarball was
  built from this exact GitHub commit by this workflow run, defending
  against typosquatting and npm account compromise vectors. Requires a
  one-time `NPM_TOKEN` repo secret (granular automation token scoped to
  the `deepadb` package).

### Dependency Security Patch

Patched 4 transitive vulnerabilities in dependencies of
`@modelcontextprotocol/sdk` (lockfile-only — no API or behavior changes):

- `hono` 4.12.14 → 4.12.18:
  - bodyLimit() bypass for chunked / unknown-length requests (GHSA-9vqf-7f2p-gf9v)
  - hono/jsx Unvalidated JSX Tag Names → HTML injection (GHSA-69xw-7hcm-h432)
  - CSS Declaration Injection via JSX SSR (GHSA-qp7p-654g-cw7p)
  - Improper NumericDate validation in JWT verify() (GHSA-hm8q-7f3q-5f36)
  - Cache Middleware ignores Vary headers → cross-user cache leakage (GHSA-p77w-8qqv-26rm)
- `fast-uri` 3.1.0 → 3.1.2:
  - Path traversal via percent-encoded dot segments (GHSA-q3j6-qgpj-74h6)
  - Host confusion via percent-encoded authority delimiters (GHSA-v39h-62p7-jpjc)
- `ip-address` 10.1.0 → 10.2.0:
  - XSS in Address6 HTML-emitting methods (GHSA-v2v4-37r5-5v8g)
- `express-rate-limit` 8.3.1 → 8.5.1:
  - Depends on patched `ip-address`

**Practical exposure assessment:** of 8 CVE references, only one (hono
bodyLimit) has any reachable code path in DeepADB's usage pattern, and
that one requires authenticated client access via `DA_AUTH_TOKEN`. The
remaining seven cover hono/jsx, hono JWT verify, hono cache middleware,
AJV `$ref` URI parsing with external schemas, and Address6 HTML-emitting
methods — none of which are reached by any DeepADB tool or transport
surface. Patched as supply-chain hygiene rather than active exploit
mitigation.

Full dependency audit: 0 vulnerabilities post-patch.

### Test Suite

New `test-supply-chain.mjs` suite, extended through the audit pass to 24 tests:

- 5 tests for registry/marketplace not-configured behavior across
  `adb_registry_search`, `adb_registry_update`, `adb_market_search`,
  plus message-content assertions verifying the friendly "not configured"
  text is returned (not a stack trace or HTTP failure).
- 9 tests for HTTPS-only protocol allowlist: rejects `http://`, `data:`,
  `file://`, `ftp://`, `javascript:`, empty string, relative paths, and
  bare hostnames. Positive control verifies `https://` URLs are not
  over-rejected by the allowlist.

Mandatory-SHA-256 enforcement and fetch-timeout behavior are not in the
automated suite — both require mock HTTP infrastructure (a manifest
endpoint with a hashless entry; a slow-drip response) that doesn't exist
yet. Covered by manual audit during release prep.

### Documentation

- README env-var table updated for `DA_REGISTRY_URL` and
  `DA_WORKFLOW_REGISTRY_URL` defaults; Plugin Registry and Workflow
  Marketplace sections updated to reflect mandatory hash verification
  and the no-default-URL policy.
- SECURITY.md "External Resource Fetching" section rewritten to cover
  the new HTTPS-only allowlist, 30s timeout, and mandatory SHA-256
  hash requirement. New "Verifying npm Tarball Provenance" subsection
  documents how consumers can verify published tarballs against the
  Sigstore attestation.
- Inline documentation in `fetch-utils.ts` covers all three layered
  defenses (protocol / timeout / size) with what each defends against.
- Version pin examples bumped to `deepadb@1.1.2`.

## v1.1.2 — Audit Hardening

A multi-session line-by-line audit of every module produced 5 high, 7 medium,
43 low, and 138 note-level findings. **Every severity-rated finding has been
addressed** plus 15 selected note items. This section documents the full
scope of the audit cleanup work.

### Headline Fixes (high / medium severity)

- **BM1 / M2+Q1 — `DA_LOG_LEVEL` runtime validation.** An invalid env value
  previously left `this.level = undefined` in the Logger constructor, causing
  the level comparison `LOG_LEVELS[level] >= undefined` to evaluate to
  `false` and silently disable ALL logs. The Logger now validates against
  the known levels at runtime and falls back to `info` with a stderr
  warning. `src/server.ts` parses the env var defensively.
- **AT1 — `snapshot.ts` capture timestamp comment.** The inline comment
  claimed UTC; the code used `Date.now()` (epoch ms). Updated to
  `new Date().toISOString()` and comment now matches the format.
- **BF1 — `thermal-power.ts` docstring accuracy.** Tool description claimed
  `adb_battery_drain` measured "over a fixed 5-second window"; actual
  parameter accepts 3–60 seconds. Description corrected.
- **AE1 — `firmware-analysis.ts` path containment.** `adb_firmware_diff`
  accepted arbitrary `from`/`to` paths. Both parameters now flow through
  `isWithinDir` against the fingerprint directory before any `readFileSync`.
- **AM2 — `network-capture.ts` tcpdump filter validator.** Filter validation
  rejected legitimate BPF expressions containing parentheses or bitwise
  operators. Validator relaxed to permit those tokens; the filter string
  is now also single-quote-wrapped via `shellQuote` so any surviving
  characters cannot break out of the inner shell context.

### Fix #1 — `shellQuote` Promoted to Canonical Shell-Interpolation Primitive

Audit findings AS9 / AD8 / O1 and the D6-class scattered duplicates
documented an inconsistent shell-quoting story: three independent
implementations of the same wrap-and-escape pattern (`escapeQemuShellArg`
in qemu.ts, a private `shellQuote` method in local-bridge.ts, and
`'${shellEscape(x)}'` inline at ~38 sites in files.ts) plus dozens of
unwrapped `${variable}` interpolations in tool modules.

- `shellQuote(arg)` added to `src/middleware/sanitize.ts` as the canonical
  primitive. Wraps any value in single quotes and neutralizes embedded
  single quotes via the `'\''` close/reopen pattern. ~12 unit tests added
  to `tests/test-security.mjs` plus a POSIX round-trip test
  (Windows-skipped) verifying that `sh -c "printf %s ${shellQuote(payload)}"`
  yields the original `payload` byte-for-byte.
- Codebase-wide application across 4 phases: **~130 call sites** in 25+
  files now route through the canonical `shellQuote`.
- Private `shellQuote` method in `local-bridge.ts` removed; `escapeQemuShellArg`
  in `qemu.ts` is now a backward-compat alias (`= shellQuote`); all 38
  manual `'${shellEscape(x)}'` patterns in `files.ts` converted; 29 more
  manual wraps across 13 other files converted in a final consistency
  pass.
- Single remaining `shellEscape()` call site is in `local-bridge.ts:L325`
  — the legitimate nested-quote pattern `su -c 'cat ${shellEscape(args[1])}'`
  where the outer single quotes are part of the `su -c` argument
  structure. Documented in-source.

### N1 / BI1 — Schema-Layer Host Validation

The `adb_connect` tool now rejects malformed host strings at the Zod
schema layer via the `HOST_PORT_RE` regex (matches IPv4, bracketed IPv6,
or DNS hostname with required `:port`). Previously a host like
`"not-a-valid-host"` would pass through to adb which printed a confusing
low-level error.

A test in `tests/test-boundaries.mjs` was updated to cover both surfaces:
`testRejects` confirms the schema rejection works, and a second test
uses `127.0.0.1:1` (no listener → immediate ECONNREFUSED on Windows) to
verify graceful runtime-error surfacing for hosts that pass the regex
but are unreachable. `192.0.2.1:5555` (RFC 5737 TEST-NET-1) was tried
first but caused tests to hang past the 5-second framework timeout
because TEST-NET-1 packets are silently blackholed; `127.0.0.1:1` fails
fast and produces the same diagnostic.

### A7 — Truncation Order in `sanitizeFilenameComponentDotted` (latent)

The previous order applied the pure-dot defang BEFORE `maxLen` truncation,
leaving a gap: input `"..a"` with `maxLen=2` survived the defang (not
pure-dot at that point), then truncated to `".."` and a parent-directory
traversal string reached the caller. The defang and empty-check now run
AFTER truncation. 6 regression tests cover the edge cases (input that
truncates to `".."`, `"."`, longer pure-dot, mixed-with-dots,
unaffected, and empty).

Latent in the sense that no current caller passes the optional `maxLen`
argument — but a future caller could, so the fix is in place before any
caller depends on the broken order.

### Item 7 — Two-Stage SIGTERM → SIGKILL for Child-Process Cleanup

Audit findings AC3 (emulator) and AK8 (mirroring/scrcpy) noted that the
cleanup paths used bare `proc.kill()` (sends SIGTERM only) with no
SIGKILL fallback. An emulator hung mid-snapshot or a scrcpy session with
a wedged video pipe could ignore SIGTERM and orphan the child process.
The same hazard existed in `logcat-watch.ts` and `ril-intercept.ts`
though the audit didn't flag those.

- New helper `gracefulKill(child, graceMs)` in `src/middleware/cleanup.ts`
  sends SIGTERM, waits up to `graceMs` for the child to exit voluntarily,
  then escalates to SIGKILL if still running. Resolves cleanly on
  already-dead children.
- Convenience helper `gracefulKillAll(children, graceMs)` for parallel
  cleanup of multiple children.
- Cleanup registry made async-aware: `CleanupFn` type now returns
  `void | Promise<void>`; `runAllCleanups` is async and `await`s each
  cleanup; SIGINT/SIGTERM handlers `await runAllCleanups()` before
  exiting. The synchronous `'exit'` event handler can't await — it
  invokes async cleanups best-effort and emits a one-shot stderr warning
  the first time it discards a pending Promise.
- **10 call sites converted** across 4 modules: emulator.ts (cleanup
  callback + `adb_emulator_stop`), mirroring.ts (cleanup + stop-all +
  stop-single), logcat-watch.ts (cleanup + explicit stop),
  ril-intercept.ts (cleanup + stop-all + stop-single).
- 7 POSIX-only unit tests in `tests/test-security.mjs` cover: already-dead
  child no-op, cooperative SIGTERM exit (with `signalCode === "SIGTERM"`
  verification), stubborn child SIGKILL escalation (`trap "" TERM` shell
  loop, with timing and `signalCode === "SIGKILL"` verification), and
  concurrent `gracefulKillAll` (verifying total elapsed is ~graceMs not
  N × graceMs). Windows-skipped because POSIX signals are a precondition.

### Item 8 — `sanitizeFilenameComponent` Consolidation

Five tool modules contained inline duplicates of the
`.replace(/[^a-zA-Z0-9._-]/g, "_")` pattern (some with dots, some without)
that already lived as canonical exports in `fs-utils.ts`. The audit
flagged AB6, AE2 (×2), AH10, BG6 — Item 8 closed all of them plus a
sixth bonus site the audit missed.

- `diagnostics.ts:L293` (AB6 heap_dump filename) → `sanitizeFilenameComponentDotted`
- `firmware-analysis.ts:L452, L648` (AE2 ×2) → `sanitizeFilenameComponent`
  with explicit `serial ? sanitize(serial) : undefined` preserving the
  optional-chaining semantics for the second site.
- `input-gestures.ts:L574` (AH10 screenshot_compressed) → `sanitizeFilenameComponentDotted`
- `ui.ts:L17-21` (BG6 `sanitizeFilename` helper) refactored to route
  through canonical while preserving the `basename` strip and
  `file_${timestamp}` fallback for empty input.
- `ui.ts:L264` (BG6 second site) → `sanitizeFilenameComponentDotted`
- `workflow.ts:L217` (bonus, audit-missed) → `sanitizeFilenameComponent`

### Item 9 — Per-Module Low-Severity Findings (all 19)

| Code | Fix |
|---|---|
| A6 | `sanitizeFilenameComponent` empty-check moved AFTER truncation (matches A7 pattern; handles `maxLen=0` degenerate case) + 2 regression tests |
| B6 | `pathsFor(tool, name)` re-validates inputs via `validateName` so a future caller forgetting the upstream check still cannot build a traversal path |
| B7 | Inner `readdirSync(toolDir)` in `scanStore` wrapped in try/catch (concurrent deletion now skips the dir instead of aborting the walk) |
| B11 | Eviction loop comparison `>` → `>=` (no transient overshoot at exactly `MAX_HANDLE_COUNT`) |
| C1 | `adb_result_list` empty-state message corrected (removed bogus `adb_bugreport`, swapped `adb_search` → `adb_grep`) |
| C8 | `DEFAULT_TTL_SECONDS` exported from `result-handle.ts` and imported by `result-handles.ts` so the success footer's TTL display tracks `DA_RESULT_HANDLE_TTL` env var instead of a hardcoded 43200 |
| D1 | Docstring on `SHELL_METACHARACTERS` documents why whitespace is intentionally permitted (post-Fix-#1, every interpolation goes through `shellQuote` which wraps in single quotes; whitespace is harmless there) |
| D3 | `validateShellArg` error message appends "(also no newlines or carriage returns)" — previously the message listed every other rejected character but omitted `\n` and `\r` |
| E3 | Two warn-level log entries for blocked/disallowed commands now route through `redactForLog` (previously the raw command leaked credentials to stderr while the same command in the audit log was redacted) |
| E4 | `redactForLog` keyword regex expanded — `authorization`, `bearer`, `api[_-]?key` added so `Authorization: Bearer` headers in echoed curl commands no longer pass through unredacted |
| F1 | Replaced `uniqueChars / length` ratio heuristic in `validateTokenStrength` with Shannon-style entropy (`length × log2(uniqueChars)`, threshold 128 bits). `openssl rand -hex 32` (the documented best practice) previously triggered a false-positive "weak token" warning because hex tokens have a 16-character alphabet → ratio ≈ 0.25 |
| F3 | `hasValidToken` length-mismatch path now runs a self-compare via `timingSafeEqual(AUTH_TOKEN_BUF, AUTH_TOKEN_BUF)` before returning `false`. Previously the early-return on length mismatch leaked the configured token's byte length through response timing |
| G2 | `formatError` handles structured-object exceptions — probes `.message` first, then `JSON.stringify` fallback, then `String()`. No more "Error: [object Object]" for libraries that throw plain objects |
| H4 | Documented the function-level Content-Length pre-check at the top of `fetchText` as the actual H4 defense; explained the rare null-body fallback path |
| I3 | `encodePng` precondition throws on `pixels.length < width × height × bpp` so a caller-bug (wrong `bpp` passed) surfaces as a clear error instead of producing a silently-corrupt PNG |
| J1 | Qualcomm chipset matcher `platform.includes("sm")` → `/\bsm\d/` (require a digit after `sm`). No more false-positive Qualcomm detection on hypothetical platforms named `samsung`, `cosmic`, `osmium`, etc. |
| K3 | SIGINT exit code now `130` (was `0`); SIGTERM exit code now `143`. Conventional Unix `128 + signum` so wrapper scripts checking `$?` can distinguish normal exit from signal termination |
| K4 | Documented the sync/async cleanup contract in `cleanup.ts`. Sync cleanups guaranteed to run on the synchronous `'exit'` event; async cleanups awaited only on SIGINT/SIGTERM. One-shot stderr warning fires the first time the `'exit'` handler discards an async-returned promise |
| O6 | `pm uninstall` args in `local-bridge.ts` now `shellQuote`-wrapped for non-flag tokens. A package name surviving upstream validation but containing whitespace no longer word-splits at the inner shell |
| S2 | New `parseWmDensity` helper in `accessibility.ts` parses Override density when set, falls back to Physical density. Previously the regex `/(\d+)/` always captured the first digit run (Physical), producing slightly-off dp conversions on devices with a user-set Override density |

### P2 — Parser Deduplication

`getDeviceProps` in `bridge/device-manager.ts` previously re-implemented
the `[key]: [value]` getprop parser inline — a five-line duplicate of
`OutputProcessor.parseGetprop` in `middleware/output-processor.ts`. Now
delegates to the canonical implementation. Same fix applied to the
inline `parseProps` helper in `tools/snapshot.ts` (AT5).

### Tier 1 — Corrupt-JSON Silent-Skip Pattern (recurring across 5 modules)

The audit identified the same defensive pattern in 6 sites across 5
modules: `try { JSON.parse(readFileSync(...)) } catch { /* skip corrupt */ }`.
Operators saw a quietly-reduced count with no indication a fingerprint
or baseline had become corrupt.

New helper `tryReadJsonOrWarn(filePath, context, logger?)` in
`fs-utils.ts` parses JSON and on any failure logs a warning via the
supplied `Logger` or to stderr if no logger is in scope. Returns `null`
so the caller skips the entry; the silent-skip becomes a visible-skip.

Wired into: `firmware-analysis.ts` `loadFingerprints` (AE8, stderr),
`ota-monitor.ts` history listing (AO6, ctx.logger), `regression.ts`
baseline listing (AU6, ctx.logger), `workflow-market.ts`
`getInstalledWorkflows` (BJ7, stderr), `registry.ts` plugin meta
(BN7 × 2 sites).

### Tier 2 — Selected Note Items (14 closed)

- **K1** — Cleanup registry now also handles `SIGHUP`, `SIGBREAK`
  (Windows Ctrl+Break), `uncaughtException`, and `unhandledRejection`.
  Previously, closing a parent terminal without Ctrl+C left orphan
  emulator/scrcpy/logcat children; catastrophic JS errors exited
  without running cleanup. Uncaught/unhandled paths now log the
  stack trace to stderr before invoking cleanups and exiting 1.
- **K7** — `runAllCleanups` catch block now logs the failing cleanup's
  registry key + error detail to stderr. Previously a silent catch
  made zombification diagnosis impossible.
- **E1** — `DA_AUDIT_LOG` disable check now case-insensitive
  (`(value ?? "").toLowerCase() !== "false"`). Previously `False` or
  `FALSE` silently failed to disable audit logging.
- **Q3** — `maxOutputSize` clamped at a 1 GB ceiling with a warn-and-
  clamp message. An operator typo (`DA_MAX_OUTPUT=2000000000`) previously
  caused `execFile`'s `maxBuffer` to be 4 GB (`2 × maxOutputSize`),
  blowing up host memory before any tool ran.
- **N1 (transient retry)** — `"device unauthorized"` removed from
  `TRANSIENT_PATTERNS` in `adb-bridge.ts`. ADB authorization is a
  one-time user action (accept prompt on device screen), not a
  transient transport hiccup. Retrying wastes the retry budget; the
  operator now sees the unauthorized error immediately.
- **G1** — `OutputProcessor.truncate` reserves 80 chars for the
  `--- OUTPUT TRUNCATED ---` suffix before computing the cut point.
  Previously the returned string overshot `limit` by ~75 chars
  because the suffix was appended after the cutoff calculation.
- **H2** — `fetchJson` wraps `JSON.parse` with URL context. HTML error
  pages from misconfigured registries now produce
  `Invalid JSON from https://... — Unexpected token <` instead of a
  bare parse error with no indication of which fetch failed.
- **AH8** — `adb_screenshot_compressed` description rewritten to match
  implementation. Previously claimed "device-side conversion to JPEG"
  but the code pulls the full PNG with sizing metadata for client-side
  post-processing (Android doesn't ship imagemagick on the device).
- **AN9** — `adb_network_auto_connect` description documents that it
  probes a SINGLE port (default 5555) and directs operators to
  `adb_network_scan` for the full 5555-5558 ADB port range.
- **AI8** — `adb_logcat_start` `tag` field gets Zod regex
  `/^[a-zA-Z0-9_]+$/` — Android logcat tags are identifier-shaped in
  practice; non-conforming values now produce a clear schema-layer
  rejection instead of confusing logcat-side parsing failures.
- **V5** — `adb_gradle` and `adb_build_and_install` got an operator-
  controllable `timeout` Zod field (30s–30min, default 5min). Large
  multi-module Android projects (60+ modules) routinely exceed the
  default; the timeout message also reflects the actual configured
  value now.
- **Y4** — `adb_farm_run` got a new `execTimeoutMs` Zod field (1min–
  60min, default 10min) replacing the hardcoded 600000. Bigger device
  matrices or larger APKs no longer hit the hardcoded ceiling silently.
- **AX6** — `adb_screen_record` pull timeout scales:
  `30s base + 2s per second of recorded duration`, capped at 10
  minutes. Previously a 3-minute recording at high bitrate could
  exceed the hardcoded 60s pull timeout on slow USB 2.0 or wireless
  ADB.
- **BJ8** — `adb_market_install` with `force: true` now writes a
  `{name}.json.bak` backup before overwriting an existing workflow.
  Fat-finger protection for customized local workflows.
- **BL7** — Server startup warns to stderr if both `DA_HTTP_PORT` and
  `DA_WS_PORT` are set. HTTP takes precedence; previously
  `DA_WS_PORT` was silently ignored with no diagnostic.

### Audit Findings Explicitly Accepted (no fix)

- **BK1 — workflow `{{var}}` substitution and device-captured stdout.**
  Workflow steps can capture stdout into named variables that later
  steps interpolate via raw textual replacement (no shell escaping).
  Under the documented single-operator / trusted-device threat model
  this is acceptable — the operator chose to run the workflow, and the
  device is trusted. The in-source comment block at the substitution
  site (`workflow.ts:L66-115`) documents the trust assumption and the
  fix path (per-step provenance tracking with shell-escape on
  DEVICE-source values) for any future contributor who needs a
  stricter threat model.
- **BG5 — `adb_start_activity` intent string unwrapped.** Intent
  expressions legitimately need multi-token forms like
  `-a android.intent.action.VIEW -d https://example.com -f 0x10000000`.
  Defense is the upstream security middleware
  (`ctx.security.checkCommand`), not interpolation-time wrapping.
  In-source comment marks this as intentional.
- 6 additional documented design decisions (A5, A10, AQ5, AR2, B2,
  C5) are explicit threat-model carve-outs or platform behavior notes;
  see audit document for rationale.

### Test Suite

The audit cleanup added test coverage proportional to the security-
sensitive surface touched:

- **+12 `shellQuote` unit tests** verifying the wrap-and-escape primitive
  on plain strings, embedded quotes, injection attempts via semicolon /
  pipe / backtick / `$()` / ampersand, and (POSIX-only) round-trip
  through `/bin/sh`.
- **+6 A7 regression tests** locking in the post-truncation
  defang/empty-check order.
- **+2 A6 regression tests** for the `maxLen=0` degenerate case.
- **+7 `gracefulKill` / `gracefulKillAll` unit tests** (POSIX-only) for
  already-dead children, cooperative SIGTERM exit, stubborn SIGKILL
  escalation timing and `signalCode` verification, and concurrent
  multi-child cleanup.
- **+1 N1/BI1 schema rejection test** + revised graceful-error test
  using `127.0.0.1:1` (immediate ECONNREFUSED) instead of the
  pre-existing test that depended on adb's runtime error surfacing
  (broken by the new schema-layer rejection).

Final test tally: **482 passed, 0 failed, 18 skipped (500 total).** Up
from the pre-fix baseline of 460 passed / 1 failed / 10 skipped — every
previously-passing test still passes, the 1 pre-existing stale-test
failure is resolved, and 22 new passing tests cover the new surface.
Of the 18 skipped tests, 11 are platform-conditional Windows-host
skips (POSIX-only round-trips and signal-handling tests), 5 are QEMU
on-device-only, and 2 are conditional on `DA_TEST_PIN` being set for
the screen-unlock test.

## v1.1.2 — Tier 3 Defensive Hardening

A follow-on cleanup pass after the main Audit Hardening section closed every
severity-rated finding. This section addresses 33 selected items from the
audit's note-level findings — defensive enhancements that wouldn't surface
under the documented threat model but are worth fixing because they continue
the consolidation themes, sharpen schema validation, polish operator UX, or
add structural protections that future code paths will benefit from.

### Consolidation & Race Defense (8 items)

Continues the v1.1.2 themes of filename sanitization, temp-path uniqueness,
and preflight existsSync checks:

- **AB3** — `adb_bugreport` filename built from `serial` now flows through
  `sanitizeFilenameComponent`. Network ADB serials (`localhost:5555`,
  `192.168.1.10:5555`) contain `:` which is invalid in Windows filenames;
  the sanitizer maps it to `_`.
- **AG1** — Health check probe filename gets PID + timestamp + 6-char random
  suffix on `/sdcard`. Eliminates the cross-process race when two DeepADB
  instances probe the same connected device simultaneously.
- **AY7** — `screenshot-diff` `currentPngPath` adds PID + random suffix
  to defeat `Date.now()` collisions when parallel automation calls the
  diff tool from a script.
- **AO7** — `ota-monitor` saved-fingerprint filename gets the same
  uniqueness suffix; the filename IS the storage key, so a same-millisecond
  collision would silently overwrite.
- **V1** — Both `adb_gradle` and `adb_build_and_install` preflight
  `projectPath` with `existsSync` before invoking gradle. Operator
  typing the wrong path no longer gets an obscure ENOENT from execFile.
- **Y5** — `adb_farm_run` preflights both `appApk` and `testApk`
  paths. Avoids the slow gcloud network roundtrip for a typo.
- **BC6** — `adb_install_bundle` preflights every APK path in the bundle.
  A missing split in the middle of a list previously aborted the whole
  install with a confusing adb-side "Could not stat" message.
- **AE7** — Shannon firmware date regex tightened from `(\d{4})(\d{2})(\d{2})`
  to `(\d{4})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])`. Eliminates false
  matches like `2025-13-13` from random 8-digit substrings starting with
  a 4-digit year. Both site 1 (strict format) and site 2 (separator-tolerant
  format) updated.

### In-Source Comments — Intentional Patterns (6 items)

Documents patterns that look like bugs but are intentional, so future
contributors don't "fix" them and break behavior:

- **AW4** — `ril-intercept.ts categorizeMessage` first-match-wins ordering.
  Pattern order in `RIL_CATEGORIES` matters; reordering changes downstream
  categorization for ambiguous messages.
- **AH11** — `adb_batch_actions` pinch action uses bare `&` to background
  the first `input swipe` so both fingers move in parallel. Not a shell-
  injection vector — all values were validated against `/^[\d\s]+$/`
  upstream.
- **AI7** — Logcat session IDs reset to 0 on server restart; external scripts
  caching IDs across restarts will see them refer to absent or new sessions.
- **O4 / O5 / O7** — `local-bridge.ts` sanitization-at-caller contract.
  `commandNeedsElevation`'s first-token tokenizer, install-flag joins, and
  logcat-flag joins all expect upstream callers to have already
  `shellQuote`-wrapped operator-supplied values. New callers must
  preserve this contract.

### Schema Validation Tightening (4 items)

- **Z1** — `adb_profile_save` validates parsed JSON against a Zod
  `DeviceProfile` schema before persisting. Locks the known fields
  (name, model, chipsetFamily, sdkLevel, simSlots, etc.) and allows
  extra fields via `.passthrough()` for forward compatibility.
- **AZ7** — `adb_audit_app_perms` `packageName` parameter gets a Zod
  regex enforcing the dotted Java-identifier shape
  `^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$`. Defense in depth
  at the schema layer before the existing `validateShellArg` check.
- **AK2** — `adb_mirror_start` `bitrate` parameter gets Zod regex
  `/^\d+(\.\d+)?[KMG]?$/`. Invalid bitrate strings now produce a clear
  schema error instead of a confusing scrcpy-side rejection.
- **AF2** — `adb_forward`, `adb_reverse`, and the matching unforward
  tools all gate their spec parameters with a shared `FORWARD_SPEC_RE`
  regex matching the documented adb spec grammar (`tcp:<port>`,
  `localabstract:<name>`, `localreserved:<name>`, `localfilesystem:<path>`,
  `dev:<path>`, `jdwp:<pid>`). Body characters restricted to
  `[A-Za-z0-9_./-]` so shell metacharacters can't smuggle through.

### Operator UX (8 items)

- **AP5** — `adb_clear_data` is destructive (wipes all app data
  irreversibly) and now requires a `confirm` parameter matching
  `packageName` to proceed. Two regression tests added to
  `test-boundaries.mjs` covering rejection-without-confirm and
  rejection-on-mismatch.
- **W1** — `adb_ci_device_ready` ping target now defaults to
  `1.1.1.1` (Cloudflare, documented no-log policy) and is operator-
  configurable via `DA_CI_PING_TARGET`. Validated as hostname/IP shape
  before interpolation.
- **BO6** — http-transport's `/health` endpoint now falls back to the
  imported `VERSION` constant instead of the literal string `"unknown"`.
- **BP8** — Same fix for ws-transport.
- **BB6** — `adb_root_shell` now appends `--- Exit code: N ---` on
  non-zero exit, matching `adb_shell`'s pre-existing behavior. The
  asymmetry was a longstanding minor consistency gap.
- **V4** — `adb_build_and_install` now appends an
  `--- BUILD AND INSTALL TIMED OUT (Ns limit) ---` marker when the
  build was killed by the timeout, matching the gradle tool's V5 pattern.
  Also fixed a latent duplicate `maxBuffer` line in the execFile options
  that had been introduced during an earlier edit.
- **BD6** — `adb_test_gen_from_intents` now reports
  "tested N of M activities (cap=20)" when an app has more than 20
  activities. Previously the operator might think the workflow covered
  everything when it didn't.
- **AN6** — `adb_network_auto_connect` ARP-discovery failure path now
  surfaces the reason ("no anchor device available") instead of a silent
  catch.

### Substantial Defensives (7 items)

These change behavior surfaces and ship with test coverage where applicable:

- **A4** — `writeAtomicSync` now `fsync()`s the .tmp file before
  `renameSync`. Without this, a system crash between write and rename
  could leave the renamed inode's data blocks unflushed on some
  filesystems, producing a "successfully written" file containing
  zeros. The fsync is best-effort and wrapped in try/catch — if it
  fails on an exotic platform, the rename still proceeds, matching
  pre-fix behavior.
- **AQ4** — `loadPlugins` resolves both the plugin directory and each
  candidate plugin's path via `realpathSync` and rejects any plugin
  whose resolved path doesn't live under the resolved plugin dir.
  Catches symlink-based plugin smuggling under the threat model where
  someone has write access to the plugin directory but not the
  malicious target file.
- **AV3** — Optional per-resource TTL cache for `device://info`,
  `device://battery`, `device://telephony`. Off by default
  (`DA_RESOURCE_CACHE_TTL_MS=0` → no caching). Enable for high-
  frequency polling scenarios where slightly-stale data (1-30s) is
  acceptable. Cache is in-memory, per-process, per-serial isolated.
  Opportunistic GC drops up to 20 expired entries on each insert.
- **AU7** — Regression parsers `parseMemoryKb` / `parseCpuPercent` /
  `parseFrameStats` exported from `tools/regression.ts` and unit-
  tested against synthesized Android 11 / 12 / 13 / 14 dumpsys output
  fixtures. Also hardened `parseMemoryKb` to handle the
  `TOTAL PSS: NNN` format introduced in Android 12 (previous regex
  only matched A11's `TOTAL:` form and silently returned null on A12+).
  17 new tests in `test-monitoring.mjs`.
- **P1** — `parseDeviceLine` defends against malformed adb output —
  a single-token line (`"foo"`) previously produced
  `{ serial: "foo", state: undefined }`. Now requires both fields and
  treats missing state as `"unknown"`. Also changed the `key:value`
  split to use `indexOf(":")` so values containing `:` (rare but
  possible) survive.
- **L1** — `captureUiDump`'s optional `dumpPath` parameter now must
  start with `/data/local/tmp/` or `/sdcard/`. Eliminates the misuse
  pattern where a buggy caller passes an arbitrary device path — the
  finally-block `rm` would then delete from that path.
- **AX5** — `adb_screen_record_stop` checks the pulled file's size and
  surfaces an explicit error message (with troubleshooting hints) when
  the file is empty. Catches the silent failure mode common on
  emulators without hardware H.264 encoders.

### Test Suite Growth

- **+17 AU7 unit tests** in `tests/test-monitoring.mjs` covering
  `parseMemoryKb` (5 tests: A11/A12/A13/A14 formats + 2 null-return
  edge cases), `parseCpuPercent` (6 tests: A11/A12/A13 formats +
  not-present + integer percentage + dotted-package regex-escape),
  and `parseFrameStats` (6 assertions across 3 fixtures).
- **+2 AP5 regression tests** in `tests/test-boundaries.mjs` covering
  the new confirmation gate (rejection on missing confirm + rejection
  on mismatched confirm).
- **+1 net change** to the Magisk clear_data test (now passes
  `confirm: packageName`).

Final test tally: **502 passed, 0 failed, 18 skipped (520 tests).** Up
from the Audit Hardening section's 482/0/18 (500 tests) — +20 new
passing tests, baseline preserved.

### Files Modified (Tier 3 cleanup, ~29 files)

**Middleware (3):** fs-utils.ts (A4 fsync), ui-dump.ts (L1 path bound),
device-manager.ts (P1).

**Bridge (1):** local-bridge.ts (O4 + O5 + O7 contracts).

**Transports (2):** http-transport.ts (BO6 VERSION import), ws-transport.ts
(BP8 VERSION import).

**Tools (21):** diagnostics.ts (AB3), health.ts (AG1), screenshot-diff.ts
(AY7), ota-monitor.ts (AO7), build.ts (V1 ×2 + V4 + dup-maxBuffer fix),
device-farm.ts (Y5), split-apk.ts (BC6), firmware-analysis.ts (AE7 ×2),
ril-intercept.ts (AW4), input-gestures.ts (AH11), logcat-watch.ts (AI7),
device-profiles.ts (Z1 schema), selinux-audit.ts (AZ7), mirroring.ts
(AK2), forwarding.ts (AF2 ×4 + FORWARD_SPEC_RE constant), packages.ts
(AP5), ci.ts (W1), shell.ts (BB6), test-gen.ts (BD6), network-discovery.ts
(AN6), screen-record.ts (AX5), plugins.ts (AQ4), resources.ts (AV3),
regression.ts (AU7 parser hardening + exports).

**Tests (2):** test-monitoring.mjs (+17 AU7 unit tests),
test-boundaries.mjs (+2 AP5 regression + 1 update).

## v1.1.2 — Tier 4 Cosmetic + Bucket F Documentation & Defensives

Final cleanup pass on the v1.1.2 audit work. Tier 4 closes the 2 remaining
purely cosmetic findings; Bucket F adds 18 in-source documentation comments
explaining intentional patterns and 21 concrete defensive fixes that fell
under the audit's "Tier 3 — defensive enhancement" tier (lower severity than
the main Audit Hardening section but worth landing for code quality).

### Tier 4 — Cosmetic Fixes (2 items)

- **BL6** — Detection-based ASCII fallback in the warning banner at server
  startup. Detects Unicode-capable terminals via the `WT_SESSION` (Windows
  Terminal), `TERM_PROGRAM` (VS Code, modern Mac terminals), and `TERM`
  (Unix-like environments) env vars. Falls back to ASCII (`+`/`-`/`|`/`*`)
  on legacy Windows `cmd.exe` where the box-drawing characters render as
  mojibake. Operators can force ASCII via `DA_ASCII_ONLY=1` regardless of
  detection.
- **BP7** — Replaced magic number `socket.readyState === 1` with a named
  `WS_OPEN` constant plus a comment explaining why the value is mirrored
  locally (the typed cast intentionally avoids importing the ws module's
  type to prevent a dependency cycle).

### Bucket F Category 3 — Concrete Defensives (21 items)

**Robustness fixes:**
- **G4** — `parseBattery` uses `Number.isFinite` to skip non-numeric
  temperature/voltage rather than emitting "Temperature: NaN°C".
- **I1** — `setPixel` clamps R/G/B to [0, 255] via `Math.max(0, Math.min(255, n|0))`
  rather than silently truncating via Buffer coercion. Surfaces caller bugs
  as visible saturated pixels.
- **X6** — `adb_screen` PIN unlock uses `Number.isFinite` on parsed
  `wm size` dimensions before passing to `input swipe`. Previously a
  parse failure produced `input swipe NaN NaN NaN NaN` on the device.
- **AE7** is part of the Audit Hardening section (already landed earlier).

**Defense-in-depth quoting:**
- **T5** — `MODEM_PATHS` entries now wrapped with `shellQuote` at both
  probe sites in at-commands.ts. Safe by construction today (hardcoded
  `/dev/...` paths), defensive against future contributors adding
  whitespace-containing paths. Added `shellQuote` import to at-commands.ts.
- **U3** — Corrected the misleading comment on the dmesg grep suffix
  (previously claimed single-quotes "would break" through rootShell, which
  was technically wrong — `shellQuote` handles both styles correctly).
  Comment now reflects the actual rationale (readability of escaped quotes,
  not safety). Also wrapped the non-dmesg `grep` with `shellQuote` for
  consistency.

**Schema & validation:**
- **Z2** — `adb_profile_save` rejects when the `name` parameter and
  the JSON's `profile.name` field disagree, or auto-derives when
  `profile.name` is absent. Eliminates the confusion where the file
  on disk has a different name than `adb_profile_list` shows.
- **Z5** — `adb_profile_save` caps the profile JSON at 1 MB
  (`Z5_MAX_PROFILE_BYTES = 1024 * 1024`). Defends against operator paste
  errors filling the temp directory.

**Wording softening:**
- **T1** — `DANGEROUS_AT_COMMANDS` docstring now explicitly notes the
  list is NON-EXHAUSTIVE, with examples of missed vendor-specific dangers
  (Huawei `AT^SYSCFG*`, MediaTek `AT^EFNAME`, Quectel `AT+QCFG`,
  Cinterion `AT^SCFG`, generic `AT+CPOL`). Operators are directed to
  the vendor datasheet before using `force: true`.
- **T7** — Three `adb_at_cross_validate` output sites: `✗ DISCREPANCY`
  softened to `⚠ HEURISTIC MISMATCH`, and the "may indicate firmware
  tampering" text replaced with a clarifying note that vendor AT strings
  rarely match Android getprop labels even on healthy hardware. Operators
  should treat findings as investigation hints, not tampering evidence.

**Type-safety and consolidation:**
- **F2** — Auth warning-box dynamic-content lines now padded to align with
  the fixed-text right border (`PREFIX`/`SUFFIX`/`CONTENT_WIDTH`
  constants). Lines exceeding the content width emit unpadded rather
  than truncating, since operators need full warning text.
- **Q1** — Added `logLevel: "debug" | "info" | "warn" | "error"` field
  to `DeepADBConfig` interface and populated it in the default config
  via an IIFE that case-insensitively validates `DA_LOG_LEVEL` and falls
  back to "info" with a stderr warning on invalid input. Single source
  of truth for the env-var parse.
- **Q2** — Created `src/middleware/parse-utils.ts` as the canonical home
  for `parseIntSafe`. Both config.ts and result-handle.ts now import from
  there instead of carrying their own copies.
- **S1** — `parseElements` in accessibility.ts now delegates to the
  canonical `parseUiNodes` from ui-dump.ts. Eliminates the duplicate
  `<node>` regex + attr extraction + bounds parsing. Added
  `parseUiNodes` to the import list.

**Lifecycle and verification:**
- **AF4** — Forwards/reverses now tracked in `trackedForwards: Set<TrackedForward>`
  and removed on server exit via the cleanup registry. Eliminates orphan
  forwards that survived graceful DeepADB restarts. Cleanup is best-effort
  (3s timeout per entry, `ignoreExitCode: true`).
- **AH7** — `adb_clipboard` write mode now reads the clipboard back
  immediately after both fallback writes. Surfaces success/failure
  honestly rather than always emitting "Clipboard set." Documents the
  Android 12+ foreground-app limitation that can defeat read-back even
  when the write succeeded.

**Performance and helper extraction:**
- **BA8** — Extracted `iioPath(dir)` helper in sensors.ts. The
  `${IIO_BASE}/${dir}` pattern at 4 sites now goes through one helper.
- **BC7** — `adb_extract_apks` parallelized with `Promise.allSettled`
  over `paths.map`. Multi-split bundles (typically 4-6 splits) now
  pull concurrently. Result ordering preserved.
- **BD7** — Consistency fix: `adb_test_gen_from_ui` now uses `{{pkg}}`
  variable substitution matching the intents variant rather than
  `shellQuote(packageName)` direct interpolation. Generated workflows
  are now portable across packages by editing only `variables.pkg`.
- **BH7** — All three wireless-firmware tools (wifi/bluetooth/nfc) now
  accept a `maxLines` Zod parameter (`z.number().int().min(50).max(2000)`)
  controlling `head -N` truncation. Defaults preserve pre-fix behavior.
  Lets operators on Samsung One UI / MIUI raise the cap when firmware
  info appears past the default truncation.

**Workflow validation and CORS:**
- **BK9** — `validateWorkflow` now pre-scans all step strings for
  `{{var}}` references and emits an error for any not declared in
  `workflow.variables`. Catches typos before any shell call runs with
  literal `{{var}}` in the command.
- **BO7** — `DA_HTTP_CORS_ORIGIN` now supports comma-separated multiple
  origins. The request's `Origin` header is matched against the list,
  and only the matching origin is reflected in
  `Access-Control-Allow-Origin` (with a `Vary: Origin` header).
  Backwards-compatible single-origin fallback retained for server-to-server
  requests with no `Origin` header.

### Bucket F Category 2 — Intentional-Pattern Comments (18 items)

In-source documentation explaining patterns that look like bugs but are
intentional, so future audits and contributors don't try to "fix" them
and break behavior or threat-model alignment.

- **A8** (fs-utils): `sanitizeFilenameComponentDotted` preserves leading
  dots — creates Unix hidden files in the result-handle store; `ls -A`
  needed to see them. Intentional under the package-name-allowed design.
- **A9** (fs-utils): `isWithinDir` dual-separator check is platform-
  portability defense, not a bug. After `resolve()`, one of the two
  checks always misses on a given run.
- **C6** (result-handles): MCP SDK template params are `string | string[]`;
  single-placeholder template makes the cast safe, but added a shape-check
  to fail loud if the template ever evolves to variadic.
- **D4** (sanitize): `validateShellArg` doesn't runtime-type-check
  `value` — all current callers receive Zod-validated strings, future
  non-MCP callers should pre-check.
- **E5** (security): Length-in-redaction is a weak side-channel. Acceptable
  under DeepADB's single-operator threat model; noted for deployments
  shipping the audit log to external SIEMs.
- **H1** (fetch-utils): `requireHttps` case-sensitivity is intentional.
  Real client libraries normalize URLs to lowercase; uppercase scheme is
  either operator typo or adversarial.
- **J3** (chipset): `/dev/ttyACM0` and `/dev/ttyACM1` appear in BOTH
  `intel` and `generic` MODEM_PATHS lists. Intentional — keeps each
  family list self-sufficient if used standalone; first-success short-
  circuits make the redundancy cost two extra `test -e` calls in worst
  case.
- **M1** (logger): Logger does NOT redact. Threat-model note added
  explaining the design — SecurityMiddleware audit log redacts untrusted
  command strings; Logger trusts its callers (which are first-party code).
- **N6** (adb-bridge): `spawnStreaming` has no built-in stdout/stderr
  budget — caller responsibility to drain or discard. Documented the
  three valid patterns (drain handler / "ignore" stdio / pipe-to-file).
- **AD9** (files): `sed` `lineNumber` interpolation safe by Zod
  constraint (`z.number().min(1)`). Type-system is the validation.
- **AL7** (multi-device): MATCH truncation at 120 chars vs DIFFERS at 200
  is intentional asymmetry — MATCH is glance-verification, DIFFERS is
  diagnostic.
- **BA7** (sensors): Outer-double-quote `su -c "..."` invocations are
  safe today (IIO_BASE is a stable kernel-layout const, dev.path is
  regex-validated). Note flags this as the future-contributor trip-wire
  if IIO_BASE ever changes shape.
- **BE6** (testing): `activeSession` race window is trivial under single-
  session enforcement. Tightening would mean lock complexity for negligible
  realistic risk.
- **BE7** (testing): Step screenshot remote path has no PID — single-
  session enforcement means no race. Future multi-session would need
  collision defense.
- **BF8** (thermal-power): `adb_battery_drain` blocks the JS event loop
  for its duration parameter. Documented for operators running multi-tool
  workflows — sequence drain last or in isolation.
- **BI5** (wireless): `HOST_PORT_RE` doesn't range-check IPv4 octets or
  port. Acceptable — adb rejects invalid ports at invocation; the regex
  is a metacharacter-smuggling defense, not a network validator.
- **BN8** (registry): `code.includes("register")` is a heuristic — real
  export check happens at load time in plugins.ts. Documented the two-
  layer defense.
- **Y3** (device-farm): `logger.info` for the gcloud command line
  includes APK paths and bucket names. Privacy note for SIEM-shipping
  deployments, related to M1.

### Test Suite Status

- 502 passed, 0 failed, 18 skipped (520 tests) — baseline preserved.
- No new tests added in this section: Tier 4 changes are detection-based
  banner fixes (testable only by running the server with different env
  vars), and Bucket F Category 3 fixes are mostly defensive enhancements
  whose behavior changes don't have natural unit-test surfaces beyond
  what's already covered.

### Files Modified (Tier 4 + Bucket F, ~28 files)

**Tier 4:** `src/index.ts` (BL6 ASCII fallback), `src/ws-transport.ts` (BP7
WS_OPEN constant).

**Bucket F Category 3 (concrete fixes):**
`middleware/output-processor.ts` (G4),
`middleware/png-utils.ts` (I1),
`middleware/auth.ts` (F2),
`middleware/parse-utils.ts` (NEW for Q2),
`middleware/result-handle.ts` (Q2 wrapper rename + import),
`config/config.ts` (Q1 + Q2),
`tools/at-commands.ts` (T1 + T5 ×2 + T7 ×3 + shellQuote import),
`tools/baseband.ts` (U3),
`tools/control.ts` (X6),
`tools/device-profiles.ts` (Z2 + Z5),
`tools/accessibility.ts` (S1 + parseUiNodes import),
`tools/forwarding.ts` (AF4 with TrackedForward set + cleanup registry wire),
`tools/input-gestures.ts` (AH7 clipboard read-back),
`tools/sensors.ts` (BA8 iioPath helper),
`tools/split-apk.ts` (BC7 parallelization),
`tools/test-gen.ts` (BD7),
`tools/wireless-firmware.ts` (BH7 ×3 tools),
`tools/workflow.ts` (BK9 validateWorkflow var check),
`tools/result-handles.ts` (C6 with shape guard),
`http-transport.ts` (BO7 multi-origin CORS).

**Bucket F Category 2 (comments):**
`middleware/fs-utils.ts` (A8 + A9),
`middleware/sanitize.ts` (D4),
`middleware/security.ts` (E5),
`middleware/fetch-utils.ts` (H1),
`middleware/chipset.ts` (J3),
`middleware/logger.ts` (M1),
`bridge/adb-bridge.ts` (N6),
`tools/files.ts` (AD9),
`tools/multi-device.ts` (AL7),
`tools/sensors.ts` (BA7 — separate site from BA8),
`tools/testing.ts` (BE6 + BE7),
`tools/thermal-power.ts` (BF8),
`tools/wireless.ts` (BI5),
`tools/registry.ts` (BN8),
`tools/device-farm.ts` (Y3).

## v1.1.2 — Tunnel Automation

Three new convenience tools layered over the existing `adb_forward` /
`adb_reverse` primitives. Operators previously composed 3-4 calls for the
typical "open a managed tunnel on a free port" pattern; this brings it down
to one. The low-level forward/reverse tools remain unchanged — these wrap
them rather than replace them.

### New tools

- **`adb_tunnel_open`** — Opens a managed tunnel and returns an opaque
  `tun_XXXXXX` ID (3 random bytes, ~16M space). For `direction: "forward"`,
  omitting `hostSpec` auto-picks a free host port via Node's
  `net.createServer().listen(0)` idiom; for `direction: "reverse"`,
  `hostSpec` is required (auto-pick for device-side ports would need an
  extra probe call against the device). The tool hooks into the existing
  AF4 cleanup path so managed tunnels are removed automatically on server
  shutdown alongside any low-level forward/reverse entries.

- **`adb_tunnel_list`** — Unified view of managed tunnels. Optional
  `device` filter. Output sorted by `createdAt` for stable ordering;
  shows the tunnel ID, direction, both endpoints, and age in seconds.
  Intentionally separate from `adb_forward_list` (which still reports
  the low-level adb-side view); the empty-state message points operators
  to `adb_forward_list` if they're looking for tunnels created via the
  primitives rather than the managed path.

- **`adb_tunnel_close`** — Takes either a specific `tun_XXXXXX` ID or
  the literal string `"all"`. Removes the corresponding adb forward/reverse
  entry and drops the tunnel from both the `tunnels` map and the
  AF4 `trackedForwards` set. Bulk close (`id: "all"`) reports partial
  success/failure per tunnel.

### Implementation notes

- Tunnel IDs are intentionally opaque so operators don't try to parse them.
  All metadata (device, direction, endpoints) is surfaced by
  `adb_tunnel_list` — there's no parseable structure to depend on.
- The `pickFreeHostPort` helper carries a TOCTOU note explaining the
  close-to-bind race: it exists in theory but kernels don't immediately
  re-hand-out just-released ports, so this is the standard cross-platform
  free-port-pick idiom.
- Cleanup is unified through AF4: managed tunnels populate both the
  `tunnels: Map<id, Tunnel>` (for ID-indexed lookup) AND the existing
  `trackedForwards: Set<TrackedForward>` (for shutdown cleanup). No
  second cleanup mechanism.

### Tests added (9 new in `test-boundaries.mjs`)

New section "Tunnel Automation Boundaries":
- 4 Zod rejections (bad direction, shell-metachar in deviceSpec, unknown
  spec scheme, bad hostSpec format)
- Reverse-without-hostSpec rejection
- Empty `adb_tunnel_list` (with and without device filter)
- Unknown ID `adb_tunnel_close` rejection
- `adb_tunnel_close` "all" when empty

Tests that actually open a tunnel against a real device aren't included
here — the boundary checks validate the surface, and operators with a
connected device can verify end-to-end via the tool's documented behavior.

### Files modified

- `src/tools/forwarding.ts` — Added `randomBytes` / `createServer`
  imports; new `Tunnel` interface, `tunnels` map, `generateTunnelId`
  helper, `pickFreeHostPort` helper, and three new tool registrations
  before the closing brace of `registerForwardingTools`.
- `tests/test-boundaries.mjs` — Added 9 boundary tests under new section.

### Test suite

**511 passed, 0 failed, 18 skipped (529 tests).** Up from the prior
v1.1.2 baseline of 502/0/18 — +9 new passing, no regressions.

## v1.1.2 — License Change (Apache 2.0)

### License Change

- Changed project license from **MIT** to **Apache License 2.0** (canonical text at http://www.apache.org/licenses/LICENSE-2.0).
  - Apache 2.0 is permissive like MIT but adds three meaningful protections: an **explicit patent grant** from contributors to users, a **patent retaliation clause** (the grant terminates if the user sues any contributor for patent infringement on the work), and an **express trademark disclaimer**.
  - These protections are particularly relevant for a security/hardware-research-adjacent project that touches patent-heavy territory (cellular baseband, modem firmware parsing, hardware sensor subsystems).
  - `LICENSE` file replaced with the canonical Apache 2.0 text (byte-identical to apache.org).
  - New `NOTICE` file added per Apache 2.0 convention for attribution.
  - `package.json` SPDX identifier updated from `"MIT"` to `"Apache-2.0"`.
  - Copyright line updated from `Copyright (c) 2025 Jason` to `Copyright 2026 Jason <fullread@github>`.
  - README License section updated to reference Apache 2.0 and cite the patent grant rationale.
  - SPDX per-file headers added to all 80 source and test files (`// SPDX-License-Identifier: Apache-2.0` + copyright line). Industry-standard machine-readable format used by the Linux kernel, Android AOSP, and most modern open-source projects. Enables automated license scanners, SBOM generators, and corporate license-compliance tooling to identify the license without having to trace back to the repository LICENSE file. Apache 2.0's Appendix recommends per-file boilerplate; the SPDX short-form satisfies this while minimizing visual noise (2 lines per file vs. the 13-line full-boilerplate alternative).

No source code or behavior changes. This affects distribution terms only — downstream users gain stronger legal protections, and the project is now compatible with GPLv3 codebases (MIT is also GPLv3-compatible, but Apache 2.0's patent provisions make it the FSF-recommended permissive license).

## v1.1.1 — Hardware Sensor Access

### New Tools (18 new tools, 1 new module — 198 tools across 44 modules)

**`adb_sensor_read`** — Read hardware sensor values from the device. Enumerates all available sensors from `dumpsys sensorservice` and returns their last-known readings with timestamps. Parses the full "Sensor List:" section for sensor inventory (name, vendor, type, mode, rate range, wake capability) and the "Recent Sensor events:" section for last-known values. Sensor availability is device-dependent — the tool reports what's present rather than assuming a fixed set. A Pixel 6a exposes 44 sensors (36 hardware + 8 AOSP virtual). Supports `category` filter (accelerometer, gyroscope, magnetometer, light, barometer, proximity, gravity, linear_accel, rotation, orientation, motion, step, temperature) and `listOnly` mode for fast discovery without reading values. Axis-labeled formatting for 3-axis sensors (accelerometer: `x=... y=... z=... m/s²`). Type map covers 21 standard Android sensor types with appropriate units. No root required.

**`adb_iio_read`** — Read raw hardware data from the Linux IIO (Industrial I/O) subsystem. Auto-discovers all IIO devices under `/sys/bus/iio/devices/` and classifies them by kernel driver name. On Tensor/Exynos devices, this exposes per-rail ODPM (On-Device Power Monitor) data from the S2MPG PMICs — real-time power consumption per SoC subsystem (CPU big/mid/little clusters, GPU, TPU, display, DDR, UFS, GPS, AOC, etc.) sorted by consumption with percentage breakdown. On other devices, may expose raw accelerometer, gyroscope, magnetometer, pressure, ADC, or temperature channels with automatic `raw * scale + offset` calibration. Supports `listOnly` mode for discovery. Root required (SELinux blocks sysfs access for non-root). Hardware-verified on Pixel 6a: 2 PMICs (s2mpg10 + s2mpg11), 16 monitored power rails, 125 Hz sampling, physically plausible readings (~5W under CPU load, ~0.4W sub-PMIC idle).

Both tools added to new `sensors.ts` module.

### File Tools Expansion (14 new tools in existing files.ts — 4 → 18 tools)

Expanded `files.ts` from 4 basic tools (push, pull, ls, cat) to 18 comprehensive file operations. Every new tool closes a specific security gap where MCP agents would otherwise fall back to `adb_shell`, bypassing the sanitization infrastructure.

**Safety model — consistent across all modifying tools:**
- Hard-blocked paths: `/`, `/dev`, `/proc`, `/sys` — kernel virtual filesystems
- Depth-based recursive protection: recursive delete/chmod/chown refuse at depth ≤ 2 from root
- Symlink resolution: `realpath` resolved BEFORE depth checks to prevent traversal bypass
- Filesystem-aware warnings: erofs/squashfs (read-only), sdcardfs/FUSE (ignores chmod), vfat/FAT32 (no perms, 4GB, 2s timestamps), tmpfs (volatile)
- Explicit root opt-in: `root=false` default, no auto-elevation
- Execution time and storage metrics on every operation

**Hardened existing tools:**
- `adb_push` — added hard-block, fs-type detection, symlink resolution, storage reporting, metrics
- `adb_pull`, `adb_ls`, `adb_cat` — added execution time metrics

**New tools (14):**
- `adb_file_write` — heredoc content delivery, buffer limit warning, append mode, post-verify
- `adb_find` — file search with maxResults/maxDepth caps, truncation detection
- `adb_file_stat` — metadata with SELinux context
- `adb_file_checksum` — SHA-256/SHA-1/MD5, size-based timeout estimation
- `adb_mkdir` — directory creation with hard-block and read-only detection
- `adb_rm` — depth-based recursive protection, symlink resolution, pre-flight count
- `adb_file_move` — source depth protection, post-verify
- `adb_file_copy` — pre-flight size+space check, post-verify size match
- `adb_file_chmod` — Zod-validated octal mode, depth-based recursive protection
- `adb_file_touch` — create/update/explicit timestamp with format validation
- `adb_file_fsinfo` — comprehensive filesystem report (type, mount, capacity, capabilities, SELinux)
- `adb_file_chown` — root required, depth-based recursive protection, Zod-validated owner format
- `adb_grep` — fixed-string default, recursive with depth control, result capping
- `adb_file_replace` — sed-backed find/replace with proper escaping, backup option, match counting

**Bugs found and fixed during implementation:**
- `stat -f -c '%T'` returns hex magic numbers on Android (e.g., `0x65735546`) instead of readable names — added `FS_MAGIC_MAP` lookup table for 8 common Android filesystems
- `df` on a deleted file fails — `getStorageInfo()` now falls back to parent directory
- grep flag construction: `.join("")` produced `-F-i-n` — fixed to `.join(" ")`

### Port Forward Cleanup (2 new tools in existing forwarding.ts — 3 → 5 tools)

- `adb_forward_remove` — remove a specific port forward or all forwards (`--remove` / `--remove-all`)
- `adb_reverse_remove` — remove a specific reverse forward or all reverse forwards
- Closes cleanup gap: test suites now properly clean up port forwards created during testing

### Bug Fixes

- Fixed event block boundary calculation in sensor value parser — the `-50` character offset was overshooting into preceding event data when sensor headers were close together, truncating multi-axis values (e.g., accelerometer showing 2 values instead of 3). Replaced with precise `headerStart` tracking.
- Fixed wake-up flag detection — `nextLine.includes("wakeUp")` matched both `wakeUp` and `non-wakeUp`, incorrectly tagging all sensors as wake-up. Fixed with word-boundary regex and explicit `non-wakeUp` exclusion.
- Fixed rate range display in `listOnly` mode — one-shot and special-trigger sensors showed ugly `—–—` double-dash, on-change sensors showed trailing `–—`. Now displays clean mode-only for sensors without rates, `up to X Hz` for max-only, and `X Hz` for min-only.
- Fixed ODPM power unit conversion — `in_powerN_scale` was being applied to `lpf_power` values that are already calibrated in μW by the ODPM driver, producing physically impossible readings (~51W total). Fixed: divide by 1000 for μW→mW without additional scale.

### Security

- Fixed printf format string injection in AT command passthrough (`at-commands.ts`). The AT command string was placed directly in `printf`'s format position (`printf '${cmd}\r'`), causing `%` characters in legitimate AT commands (e.g., `AT%RESTART`) to be misinterpreted as format specifiers. Fixed by separating format from data: `printf '%s\r' '${cmd}'`.
- Fixed sed shell injection in `adb_file_replace` (`files.ts`). `sedEscapePattern()` and `sedEscapeReplacement()` handled regex metacharacters but not single quotes, so a `find` or `replace` value containing `'` would close the surrounding shell single-quote and execute arbitrary commands (e.g., `find = "';rm -rf /sdcard/evil;echo '"`). Fixed by appending `'\''` closing/reopening logic to both escapers. Additionally, Zod `.refine()` now rejects newlines in `find` and `replace`, since sed treats embedded newlines as script-command separators. Regression test added with a canary-file pattern that proves the injection payload no longer executes.

### Code Quality

- **sensors.ts**: O(n) line offset index with binary search replaces O(n²) `substring+split` per sensor entry; self-describing key=value IIO reads (immune to `cat` alignment fragility); file reorganized into clean domain groups (HAL types/parsers/helpers → IIO types/parsers/helpers → tool registration); defense-in-depth validation on IIO device dirs (`^iio:device\d+$`) and sysfs attributes (`^[a-zA-Z0-9_]+$`).
- **at-commands.ts**: Extracted `autoDetectAtPort()` shared helper, replacing 4 copies of the 15-line modem probe pattern across `adb_at_send`, `adb_at_batch`, `adb_at_probe`, and `adb_at_cross_validate`. `adb_at_detect` retains its own implementation (reports all nodes, not just the first).

### Documentation

- README architecture diagram: updated module count from 43 to 44, added `sensors`, `input-gestures`, `wireless-firmware` to module name list
- README Available Tools: updated section header from 180 to 182, added `### Hardware Sensor Access (2 tools)` section with `adb_sensor_read` and `adb_iio_read` descriptions
- README project structure tree: added missing `input-gestures.ts` (18 tools), fixed `plugins.ts` description, fixed ASCII tree syntax (`└──` followed by `├──`)
- Tool count verified as 198 via comment/string-aware grep across all 44 modules (naive grep returns 200 due to 2 false positives in `plugins.ts` template literal examples)

### Housekeeping

- Added `.mcpregistry_*` credential files to `.gitignore`

### Test Suite

Validated on hardware (Pixel 6a, Android 16, Termux + Magisk + QEMU 10.2.1) across a four-cell matrix — 0 failures:

- **ADB mode, no PIN:** 383 passed / 10 skipped (393 total)
- **ADB mode, with PIN:** 387 passed / 6 skipped (393 total)
- **On-device mode, no PIN:** 419 passed / 4 skipped (423 total)
- **On-device mode, with PIN:** 420 passed / 3 skipped (423 total)

On-device delta (+30 tests) reflects the 5 QEMU tests, 1 shell round-trip, and 9 on-device-specific code paths in test-boundaries that are skipped on the host.

- New `test-sensors.mjs` suite (30 tests): sensor discovery (list, categories, total), full value read with calibrated data verification, category filters with device-specific sensor name assertions (11 categories), list-only with filter, accelerometer z-axis regression test, rate display formatting (one-shot clean output, continuous range), wake-up flag correctness (non-wake exclusion + wake inclusion), IIO device discovery (list, ODPM detection), and IIO power monitor output verification (power data, sampling rate, channels, totals, CPU subsystem, unit formatting)
- New `test-files-extended.mjs` suite (95 tests): push safety (hard-blocked /dev, /proc, /sys, /), existing tool metrics (ls, cat execution time), file write (create, append, verify, storage, refusals), find (locate, timing, maxResults, no results), stat (size, permissions, SELinux, nonexistent), checksum (SHA-256, MD5, size, nonexistent), mkdir (nested, timing, refusals), rm depth protection (8 tests: depth 1/2/4 boundaries, symlink resolution, /dev refusal), move (verify, depth protection, refusals), copy (size verification, storage), chmod (permissions, recursive depth, Zod validation), touch (create/update/explicit timestamp, format validation), fsinfo (type, capacity, capabilities, mount), chown (ownership, recursive depth, Zod validation), grep (case sensitivity, line numbers, recursive, no match), file replace (match count, content verification, backup, no match, refusal), **sed injection regression (canary-file pattern proving single-quote payload is neutralized, newline rejection in find/replace)**, end-to-end lifecycle (write → stat → checksum → copy → hash compare → rm), cleanup verification

### Post-Audit Additions

Work completed after the initial v1.1.1 scope landed, during a multi-pass security and test-quality audit:

**Additional security fixes (Passes 2–4):**
- **Shell injection in `adb_qemu_start` kernel `append` parameter** (`qemu.ts`, KVM path only). The `escapeQemuShellArg()` heuristic only quoted arguments containing `=`, `/`, `,`, or `:`, so payloads like `append: "; reboot"` slipped through unquoted into `su -c "..."` and executed. Fixed by extracting `escapeQemuShellArg()` as a module-level export and unconditionally wrapping every QEMU argv element in single quotes with `'\''` closing/reopening to neutralize embedded quotes. The non-KVM path was already safe since it uses `spawn(cmd, args)` with an argv array. 11 unit assertions plus 6 Unix shell round-trip tests verify the quoting property end-to-end.
- **Discarded validator return in `adb_heap_dump`** (`diagnostics.ts`). `validateShellArg(target, "target")` was called but its error result was never checked — subsequent `shellEscape()` made exploitation impractical, but the intent was to reject shell metacharacters. Fixed by capturing and returning the error properly. 4 injection-rejection tests added.
- 61 other interpolation sites verified safe across the codebase: 22 `shellEscape`-wrapped, 21 `validateShellArg`-gated, 8 numeric Zod bounds, 4 hardcoded values, 3 Zod enums, 3 free-form gated by `ctx.security.checkCommand()`.

**Test harness correctness fixes** (`tests/lib/harness.mjs`):
- `testContains` and `testNotContains` now throw on empty expected/forbidden string. Previously these were always-pass no-ops (`String.includes("")` is always true) and silently masked 7 misused assertions across the suite. Every misuse was converted to a meaningful check.
- `testRejects` no longer counts thrown exceptions as successful rejections. Previously, a tool crash or timeout would be silently tagged "correctly rejected" — now crashes/timeouts are correctly marked failures.
- `getText(response)` returns an empty string on RPC error instead of fabricating a `"[RPC ERROR] ..."` wrapper string. The fabricated text could leak into `testContains` assertions — a test checking for "error" substring would falsely match the wrapper. Callers use `isError()` to distinguish success from RPC failure.
- Server startup "Ready" substring match tightened. Previously matched the bare word "Ready" anywhere in stderr — a log line like "Preparing to be Ready..." would fire prematurely. Now matches specific phrases: `"Ready for connections"` (from `index.ts` post-initialization log) or `"tool modules, 4 resources"` (from `server.ts` init-complete log).
- Added `h.assert()` and `h.assertEq()` primitives for unit-style tests that feed into the suite's pass/fail counter.

**Test coverage additions:**
- Wireless ADB: 5 tests in `test-boundaries` (Zod port bounds, malformed-host graceful handling, idempotent disconnect, unreachable-pair rejection)
- Multi-device: 5 tests in `test-boundaries` (single-device shell with whoami, <2-device rejection for compare, firmware profile, listing profiles, custom commands)
- `adb_at_probe`: tolerant unit test accepting either success or clean rejection
- `adb_profile_save`: corrected schema (`{ name, profile }`) + invalid-JSON rejection
- `adb_tcpdump_stop`: no-active-capture rejection path
- `adb_network_auto_connect`: empty-range graceful handling with correct `ipRange` field

**Assertion quality (tightened loose substrings):**
- `test-shell-files`: `"sh"` → `"toybox"` (unambiguous Android system binary)
- `test-hw`: `"==="` (section-header prefix) → `"ANR Traces"` (actual crash_logs section header)
- `test-sensors`: `"W"` (matched any word with W) → `"mW"` (actual power unit emitted by sensors.ts)

**On-device mode-awareness** — LocalBridge legitimately stubs wireless ADB (`connect`, `disconnect`, `pair`, `tcpip`) and port forwarding (`forward`, `reverse`) since there is no ADB server to route through. Four test-boundaries/test-lifecycle assertions were originally written against ADB-mode semantics and would fail cleanly in on-device mode. Made mode-aware via `existsSync("/data/data/com.termux")`:
- `Connect to malformed host surfaces error` — ADB mode asserts the bad host appears in stdout; on-device asserts the stub's "not applicable" message appears.
- `Pair with unreachable host` — ADB mode uses `testRejects` with 45s timeout (adb pair blocks ~30s on unreachable hosts); on-device asserts the stub's "not applicable" message.
- `multi_shell on single device (whoami)` — ADB mode gets "shell" (uid=2000); on-device gets "root" or the Termux user depending on elevation path. Replaced with tool-executed-and-produced-output check.
- `Forward list (shows entries)` — ADB mode asserts the created forward appears; on-device skips since the forward creation is itself a stub.

**Alpine VM auto-fetch for `test-qemu-boot.mjs`:**
Previously required a pre-built Alpine image at a hardcoded path, so the boot test would fail on any fresh on-device install. Added setup phase between pre-flight and boot that:
- Computes `imageDir` from `process.env.HOME` to match the runtime `ctx.config.tempDir` resolution (avoiding a hardcoded path that mismatches when HOME is overridden by a test wrapper)
- Probes for cached `vmlinuz-virt`, `initramfs-virt`, and `alpine-test.qcow2`; skips downloads on repeat runs
- Fetches kernel (~10 MB) and initrd (~9 MB) from `https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/aarch64/netboot/` via `curl --fail --location --silent --retry 2 --max-time 120`
- Atomic writes (`.tmp` → `mv`) prevent partial downloads from poisoning the cache
- Size sanity check (>1 MB per file) catches truncation or error-page situations
- Creates a 64 MB placeholder qcow2 via `qemu-img create` (required by `adb_qemu_start`'s image argument; VM actually boots from kernel+initrd)
- On any failure (no curl, no network, size check fail), all downstream boot tests skip with explicit reasons rather than crashing

No checksum verification — Alpine doesn't publish per-file sha256 for the netboot directory (only for the 425 MB full-release tarball). HTTPS + TLS chain to `dl-cdn.alpinelinux.org` is the integrity mechanism. Trade-off documented in the test file header.

## v1.1.0 — MCP Registry Integration

### MCP Registry Support
- Added `server.json` metadata file for the official MCP Registry (`registry.modelcontextprotocol.io`)
- Added `mcpName` field (`io.github.fullread/deepadb`) to `package.json` for npm package validation
- Server namespace: `io.github.fullread/deepadb` — authenticated via GitHub ownership
- Registry metadata points to the npm package for distribution, with stdio transport

### Housekeeping
- Updated `.gitignore` to exclude `mcp-publisher.exe` binary

## v1.0.9 — Input Completeness, UI Efficiency, Screen Control & Permission Management

### New Tools (6 new tools — 180 tools across 43 modules)

**`adb_input_fling`** — High-velocity fling gesture for triggering scroll momentum on lists, launchers, and paged views. Distinct from swipe by duration: 20–200ms (default 50ms) creates the velocity needed for momentum scrolling. Also available as a `fling` action type in `adb_batch_actions`. Added to `input-gestures.ts`.

**`adb_revoke_permission`** — Revoke a runtime permission from a package via `pm revoke`. Counterpart to the existing `adb_grant_permission`. Useful for resetting permission state to test first-run flows and denial handling. Input validated via `validateShellArgs` on both `packageName` and `permission`. Added to `packages.ts`.

**`adb_list_permissions`** — List all declared and granted permissions for a package. Parses `dumpsys package` install-time and runtime permission blocks with current grant state. Filterable by `all` / `granted` / `denied`. Reports granted count vs total and permission type (install/runtime) with ✓/✗ indicators. Added to `packages.ts`.

**`adb_screencap_annotated`** — Screenshot with UI element bounding boxes and numbered labels composited directly onto the PNG using a zero-dependency pure-TypeScript PNG pipeline (decode → draw → encode). Accepts `clickableOnly` (default true). Returns annotated PNG path plus a text legend. Color palette cycles through 8 distinguishable colors with auto-contrasted white/black digit labels. Added to `ui.ts`.

**`adb_screen_state`** — Combined screen state in one call: foreground activity, screen dimensions and density, orientation, battery level/status/temp, and a TSV node list of interactive elements. Replaces the common `adb_current_activity` + `adb_screen_size` + `adb_device_state` + `adb_ui_dump` sequence with a single round-trip. Uses `Promise.allSettled` for resilience. Added to `ui.ts`.

**`adb_input_pinch`** — Multi-touch pinch (zoom out) or spread (zoom in) gesture with layered injection architecture. Two fingers move symmetrically around a configurable center point with adjustable start/end radius, duration, axis angle, and interpolation steps. Primary method: parallel `input swipe` with shell backgrounding (universal, no root required). Advanced method: atomic binary writes of raw Linux Multi-Touch Type B protocol events (`ABS_MT_SLOT`, `ABS_MT_TRACKING_ID`, `ABS_MT_POSITION_X/Y`, `SYN_REPORT`) to the touchscreen device node via `xxd -r -p` (root required). Each frame's events are written as a single binary blob to ensure Android's `MultiTouchInputMapper` receives all slot updates atomically — individual `sendevent` calls are too slow (~5-10ms per fork) and cause the InputReader to miss the gesture. Auto-detection probes `getevent -p` to discover the touchscreen device node, coordinate ranges, slot count, and pressure range — cached for the session. `method` parameter: `auto` (default — uses sendevent when root available), `swipe` (force parallel swipes), `sendevent` (force raw MT). Also available as a `pinch` action type in `adb_batch_actions` (uses swipe method). Hardware-verified on Pixel 6a FTS touchscreen (1080×2400, 10-slot MT Type B) — both pinch/zoom-out and spread/zoom-in produce visible map zoom in Google Maps. Added to `input-gestures.ts`.

### Enhancements to Existing Tools

**`adb_screen`** — Added `lock` action, improved `unlock`, and added `pin` parameter for full credential-based unlock.

Lock: checks `mWakefulness` via `dumpsys power`. If already off, still checks keyguard state via `dumpsys window` and returns `"Screen: already locked (keyguard active)"`. If awake, sends `KEYCODE_SLEEP`, waits 1.5s for the sleep token to appear, then returns `"Screen: locked (keyguard active)"` or `"Screen: sleep sent"` depending on verified state.

Unlock: sends `KEYCODE_WAKEUP` then `wm dismiss-keyguard`. Reports honestly — `"Screen: unlocked (keyguard dismissed)"` or `"Screen: awake — keyguard still active (PIN/pattern/biometric required)"`. If `pin` is supplied and the keyguard survives dismiss, performs the full credential entry sequence: derives proportional swipe coordinates from `wm size`, swipes up to reveal the PIN keypad, types the PIN via `input text`, confirms with `KEYCODE_ENTER`, then re-checks keyguard state and returns `"Screen: unlocked (PIN accepted, keyguard dismissed)"` or `"Screen: PIN entered — keyguard still active (wrong PIN or biometric required)"`.

Key finding from live hardware research: `mWakefulness=Awake` and `mResumedActivity` are both unreliable keyguard indicators — the keyguard is a window overlay above the activity stack and the launcher can show as resumed while the keyguard is blocking everything. `dumpsys window | grep keyguard` (sleep token presence) is the correct signal for all lock/unlock state decisions. (`control.ts`)

**`adb_ui_dump`** — Added `format` parameter: `text` (default), `tsv` (compact tab-separated: `index\ttext\tresource_id\tcontent_desc\tcenter_x\tcenter_y\tclickable\tscrollable` — order-of-magnitude token reduction for automation loops), `xml` (raw uiautomator XML). Tabs in text/content_desc fields are escaped to spaces to preserve TSV structure. (`ui.ts`)

**`adb_batch_actions`** — Added `fling` as a supported action type. Args: `x1 y1 x2 y2 [durationMs]` — same as swipe but defaults to 50ms duration. Numeric-only validation, goes through existing security middleware. (`input-gestures.ts`)

### New Infrastructure

**`src/middleware/png-utils.ts`** — New shared middleware module providing zero-dependency PNG utilities:
- `decodePngPixels()` — moved and exported from `screenshot-diff.ts`; handles RGBA (colorType 6) and RGB (colorType 2), all 5 PNG filter types
- `encodePng()` — filter-0 (None) scanlines + level-1 deflate; CRC32 chunk integrity
- `drawRect()` — inward-thickness rectangle border on a pixel buffer
- `drawLabel()` — filled number label with 5×7 pixel font and ITU-R BT.601 auto-contrasted foreground
- `ELEMENT_COLORS` — 8-color cycling palette

**`src/tools/screenshot-diff.ts`** — Refactored to import `decodePngPixels` from `png-utils.ts`. Removed private copy and local `inflateSync` import. Zero behavioral change.

### Test Suite (235 ADB-mode / 257 on-device tests)
- `test-analysis.mjs`: Permission Management section — grant, list (all), list (granted filter), revoke, re-grant cleanup (5 tests)
- `test-ui-control.mjs`: Screen lock/wake/unlock cycle, unlock-without-PIN advisory path, UI Dump TSV/XML formats, annotated screenshot, fling gesture, fling batch action type, screen state, multi-touch pinch/spread/auto/horizontal-angle, batch pinch type, pre-flight keyguard guard for recovery from prior failed runs (14 new tests, 5 conditional on `DA_TEST_PIN` for the lock/unlock cycle)
- `test-boundaries.mjs`: Pinch Zod boundary validation — startRadius below min, durationMs above max, steps above max (3 new tests)
- Lock/wake/unlock tests skip cleanly when `DA_TEST_PIN` is not set. With PIN supplied, `adb_screen { action: "unlock", pin }` handles the full sequence internally — the test simply calls the tool and asserts `"PIN accepted"` in the response
- Wake assertions tightened from `"Screen:"` to `"wake sent"` for specificity
- Multi-touch tests open Google Maps at a known location to provide a zoomable surface for pinch/spread verification
- On-device validated: 257/257 with `DA_TEST_PIN` on Pixel 6a (Termux + Magisk + QEMU 10.2.1)

### Security Hardening
- **`adb_screen` PIN shell injection** (finding #76) — The `pin` parameter was passed unsanitized to `input text`, allowing shell injection via crafted PIN values. Fixed with three layers: Zod `.trim().regex(/^[a-zA-Z0-9]+$/)` rejects non-alphanumeric input at the schema level, `shellEscape()` wraps the value in the shell command, and `shellEscape` import added to `control.ts`. The `.trim()` handles cmd.exe trailing-space edge case when `DA_TEST_PIN` is set via `set VAR=value && command`.
- **`adb_input_pinch` event device node injection** (finding #76b) — The touchscreen device node path from `getevent -p` was used unvalidated and unquoted in the `xxd -r -p > <node>` shell command. While the value comes from system output (not user input), defense-in-depth requires validation. Fixed with `/dev/` prefix check, shell metacharacter rejection (`["'\`$\\!;|&(){}<>\n\r]`), path traversal (`..`) rejection, and single-quote wrapping in the shell command.
- **PNG decoder hardening** (3 findings in `png-utils.ts`) — (a) PNG signature only checked 2 of 8 bytes — a non-PNG binary starting with `\x89\x50` would pass validation. Fixed with full 8-byte magic number check. (b) No dimension bounds on IHDR width/height — a crafted PNG claiming extreme dimensions (e.g. 100000×100000) would trigger a multi-gigabyte `Buffer.alloc()` OOM crash. Fixed with `MAX_DIM = 10000` ceiling per axis. (c) `inflateSync` called without `maxOutputLength` — a decompression bomb (tiny compressed payload decompressing to gigabytes) would exhaust memory before the size check. Fixed with `maxOutputLength` computed from validated IHDR dimensions, aborting decompression immediately if output exceeds expected pixel data size.

## v1.0.8 — Input Gestures, UI Automation & Device Awareness

### Input Gestures, UI Automation, Efficiency, Device Awareness & Crash Analysis (18 new tools, 1 new module — 174 tools across 43 modules)

**Batch 1 — Input Gestures (7 tools):**
- **`adb_input_drag`** — Drag from point A to point B using Android's `draganddrop` command with swipe fallback for older devices. Configurable duration.
- **`adb_input_long_press`** — Long press at coordinates with configurable hold duration. Triggers context menus, selection mode, and drag handles.
- **`adb_input_double_tap`** — Double tap with configurable interval between taps. Triggers zoom, text selection, and double-tap gestures.
- **`adb_input_text`** — Dedicated text input with `%s` space encoding and shell escaping for special characters.
- **`adb_open_url`** — Open a URL on the device via `android.intent.action.VIEW` intent.
- **`adb_orientation`** — Get or set screen orientation: auto-rotate, portrait, landscape, reverse portrait, reverse landscape.
- **`adb_clipboard`** — Read or write the device clipboard. Multiple fallback methods for cross-version compatibility.

**Batch 2 — UI Automation Helpers (4 tools):**
- **`adb_tap_element`** — Find a UI element by text, resource-id, or content-description, then tap its center. Atomic search+tap in one call.
- **`adb_wait_element`** — Poll UI hierarchy until an element appears or disappears. Configurable timeout and polling interval.
- **`adb_wait_stable`** — Poll until consecutive UI dumps produce identical structure. Detects when screen transitions and animations are complete.
- **`adb_scroll_until`** — Scroll repeatedly until a target element is found in the UI hierarchy. Configurable direction, max scrolls, and optional auto-tap when found.

**Batch 3 — Efficiency Features (2 tools):**
- **`adb_screenshot_compressed`** — Capture screenshot with size/quality metadata for token-efficient LLM workflows.
- **`adb_batch_actions`** — Execute up to 50 input actions (tap, swipe, long_press, double_tap, keyevent, text, drag, back, home, sleep) in a single tool call. All actions validated through security middleware.

**Architecture:**
- Extracted `parseUiNodes` and `UiElement` to shared `ui-dump.ts` middleware — eliminates duplication between `ui.ts` and the new `input-gestures.ts` module.

**Device Awareness (3 tools):**
- **`adb_screen_size`** — Screen resolution and display density: physical width, height (pixels), DPI, aspect ratio, DP width. Detects override sizes/densities.
- **`adb_device_state`** — Combined snapshot in one call: battery level/status/temperature, network type, WiFi state, screen on/off, orientation lock, foreground activity. Uses `Promise.allSettled` for resilience.
- **`adb_notifications`** — Parse active notifications from `dumpsys notification --noredact`. Extracts package, title, text, importance, channel, flags, and timestamp. Supports package filter and max results.

**Crash Analysis & Debugging (2 tools):**
- **`adb_crash_logs`** — Read ANR (Application Not Responding) traces and tombstone crash dumps from the device. Supports ANR-only, tombstones-only, or both. Shows directory listing and most recent trace/tombstone content.
- **`adb_heap_dump`** — Capture a heap dump from a running process for memory analysis. Triggers `am dumpheap`, pulls the .hprof file locally, and cleans up the remote temp file.

## v1.0.7 — Wireless Firmware, QEMU Guest Connectivity & Dependency Security Patch

### Wireless Firmware Tools (4 new tools, 1 new module — 156 tools across 42 modules)

- **`adb_wifi_firmware`** — WiFi chipset and firmware identification: driver version, firmware version, supported bands (2.4/5/6 GHz), WiFi standard detection (5/6/6E/7), current connection info (SSID, RSSI, link speed, frequency). MAC address opt-in only (permanent hardware identifier).
- **`adb_bluetooth_firmware`** — Bluetooth firmware and chipset identification: firmware version, BT version (4.0–5.4 from LMP), adapter state, LE capabilities (2M PHY, Coded PHY, extended advertising, LE Audio), active profiles (A2DP/HFP/HID/PAN/MAP), bonded device count. MAC/name opt-in only.
- **`adb_nfc_firmware`** — NFC controller firmware identification: controller type (NXP/Broadcom/Samsung/ST), firmware version, NCI version, supported technologies (NFC-A/B/F/V, MIFARE), secure element availability (eSE/UICC), HCE support.
- **`adb_gps_firmware`** — GNSS/GPS chipset and firmware identification: hardware model (manufacturer, chip, firmware), supported constellations (GPS/GLONASS/Galileo/BeiDou/QZSS/NavIC/SBAS), signal types with frequencies, dual-frequency (L1+L5) detection, raw GNSS measurement capabilities (pseudorange access for spoofing detection), A-GPS modes (MSB/MSA — cellular-routed assisted GPS relevant to IMSI catcher research), SUPL server configuration, carrier phase measurements, navigation message decoding.
- Enhanced `adb_firmware_probe` with WiFi/Bluetooth/NFC/GPS firmware summary section and cross-references to detailed tools

### QEMU Session 3 — Guest ADB Connectivity (3 new tools)

- **`adb_qemu_connect`** — Connect to a running VM's guest ADB service. Restricted to `localhost` only — no remote host connections. Port derived from running VM state, never user input.
- **`adb_qemu_disconnect`** — Disconnect from a guest VM's ADB service. Auto-clears connection state.
- **`adb_qemu_guest_shell`** — Execute shell commands on a guest VM via ADB. Subject to the same security middleware as `adb_shell`. Guest serial derived internally — no user-supplied host/IP reaches the ADB binary.

### AT Cross-Validation (1 new tool)

- **`adb_at_cross_validate`** — Cross-validate baseband firmware by comparing direct modem AT command responses (ATI, AT+CGMR, AT+CGMM) against Android system properties (gsm.version.baseband, ro.hardware.chipname). Shannon-specific AT+DEVCONINFO support. Flags discrepancies as potential firmware tampering, incomplete OTA updates, or property spoofing. Performs 4 validation checks: firmware revision consistency, modem identity vs chipset family, model identification, and expected vs running baseband. Requires root.

### Comparative Testing Workflows (1 new tool)

- **`adb_multi_test`** — Run comparative test workflows across all connected devices (host + QEMU guests). Supports predefined diagnostic profiles: `firmware` (baseband, bootloader, kernel, security patch, build fingerprint), `security` (SELinux, verified boot, encryption, flash lock), `network` (radio type, operator, SIM state, WiFi), `identity` (model, chipset, architecture, RAM), and `full` (all profiles combined). Also accepts custom command lists (max 50 checks). Runs each check in parallel across all devices, compares outputs per-check, and produces a structured match/difference report. All commands go through security middleware.

### QEMU Enhancements
- Enhanced `adb_qemu_stop` to auto-disconnect guest ADB before killing QEMU process
- Enhanced `adb_qemu_status` to show per-VM ADB connection state
- Enhanced process cleanup to disconnect all connected VMs before killing on exit
- VM exit handler clears connection state when QEMU process exits unexpectedly

### Multi-Device Integration (QEMU Session 4)

- Enhanced `LocalBridge` with guest device routing — commands targeting a connected QEMU guest are transparently routed through the real ADB binary instead of local execution
- Added guest device registry (`registerGuestDevice`/`unregisterGuestDevice`) with static set — only populated by QEMU connect/disconnect flow with validated `localhost:<port>` serials
- Enhanced `syntheticDeviceList()` to merge ADB-connected guest devices into the device list, enabling existing `adb_multi_shell`, `adb_multi_install`, and `adb_multi_compare` tools to operate transparently across host + guest VMs
- Zero changes to any of the 42 tool modules — multi-device integration is entirely bridge-level

### Security Hardening

- Bearer token strength validation at startup: warns if `DA_AUTH_TOKEN` is shorter than 32 characters, has low character diversity, uses repeated characters, or matches common weak patterns (e.g., "password", "changeme", "test")
- Updated SECURITY.md with explicit minimum token length requirement (32 characters), `node -e` alternative for environments without openssl, and token strength guidance

### Dependency Security Patch

- Patched 6 moderate vulnerabilities in transitive dependencies of `@modelcontextprotocol/sdk`:
  - `hono` 4.12.9 → 4.12.12: cookie name validation bypass (GHSA-26pp-8wgv-hjvm), cookie name prefix bypass (GHSA-r5rp-j6wh-rvv4), IPv4-mapped IPv6 bypass in ipRestriction (GHSA-xpcf-pg52-r92g), path traversal in toSSG (GHSA-xf4j-xp2r-rqqx), middleware bypass via repeated slashes (GHSA-wmmm-f939-6g9c)
  - `@hono/node-server` 1.19.11 → 1.19.13: middleware bypass via repeated slashes in serveStatic (GHSA-92pp-h63x-v22m)
- Lockfile-only change — no API changes
- Full dependency audit: 0 vulnerabilities
- Updated `@types/node` 25.5.0 → 25.5.2, `path-to-regexp` 8.4.0 → 8.4.2 (transitive)
- Updated future roadmap documentation to reflect current state

---

## v1.0.5 — Transport Security & Auth Documentation

- Bearer token authentication (`DA_AUTH_TOKEN`) documented in README and SECURITY.md — env var table, usage examples, deployment configurations, and plaintext-over-HTTP warning
- Token comparison hardened with `crypto.timingSafeEqual()` to prevent timing-based side-channel attacks; uses pre-computed buffer with byte-length comparison to handle multi-byte UTF-8 tokens correctly
- Non-loopback binding warning: startup alerts operators when network transports bind to non-`127.0.0.1` addresses without `DA_AUTH_TOKEN` set, referencing common MCP security findings
- Auth status logged at startup for network transports (token enabled vs. no auth configured)
- CORS headers updated to allow `Authorization` header across all transports (HTTP/SSE, WebSocket, GraphQL) with OPTIONS preflight handling
- Added HTTPS via reverse proxy guidance to SECURITY.md (Caddy and SSH tunnel examples)
- Upgraded `@modelcontextprotocol/sdk` from 1.28.0 to 1.29.0
- Upgraded dev dependencies: TypeScript 5.9.3 → 6.0.2, @types/node 22.x → 25.5.0; added `"types": ["node"]` to tsconfig.json for TypeScript 6.0 compatibility
- Removed unused `checkAuth` import from WebSocket transport
- Code consistency: non-loopback check uses `isAuthEnabled()` instead of duplicating env var logic

---

## v1.0.4 — Dependency Security Patch

- Fix CVE-2026-4926 (CVSS 8.7 High): ReDoS vulnerability in `path-to-regexp@8.3.0` — updated to `8.4.0` via lockfile refresh
- Upgraded `@modelcontextprotocol/sdk` from 1.27.1 to 1.28.0
- Full dependency audit: 0 vulnerabilities, all transitive dependencies current

---

## v1.0.3 — Security Hardening

- Audit logging (`DA_AUDIT_LOG`) now enabled by default — all commands logged to stderr with credential redaction. Set `DA_AUDIT_LOG=false` to disable.
- Added `SECURITY.md` documenting threat model, security architecture, recommended configurations for personal/shared/network-exposed deployments, version pinning guidance, AT command safety, and vulnerability reporting process
- Fixed `package-lock.json` version — was stuck at 1.0.0 across prior releases, now synced to 1.0.3

### Test Suite Improvements (203 on-device / 183 ADB-mode)

- New `test-boundaries.mjs` suite (28 tests): Zod parameter bounds enforcement, `adb_input` injection validation, error path handling, previously untested tools (`adb_clear_data`, `adb_extract_apks`, `adb_snapshot_restore_settings`, `adb_market_search`, `adb_registry_search`), and sensitive data protection checks
- Harness: added `testNotContains()` and `testMatch()` assertion methods
- `run-all.mjs`: now tracks and displays skipped test counts in per-suite and total summary
- `test-qemu.mjs`: fixed missing `process.exit()` that silently swallowed failures

---

## v1.0.2 — Version Reporting Fix

- Read version from package.json at runtime instead of hardcoding across 4 files
- New `VERSION` export in config.ts — single source of truth for McpServer, HTTP/SSE, WebSocket, and GraphQL transports
- Future version bumps only require editing package.json

---

## v1.0.1 — Code Quality Patch

- Fix unused `bridge` parameter in GraphQL `buildResolvers()`
- Fix unused `deviceManager` parameter in GraphQL `buildFieldResolvers()`
- Remove unnecessary `async` from 8 synchronous GraphQL field resolvers
- Add `pretest` script to package.json so `npm test` auto-builds first

---

## v1.0.0 — Full Release

**147 tools, 4 resources, 4 prompts across 41 modules.**
**Triple transport (stdio + HTTP/SSE + WebSocket) + GraphQL API.**
**Dual-mode: ADB (PC) and on-device (Termux) with automatic detection.**
**175/175 tests passing on hardware (Pixel 6a, Android 16).**

### Highlights
- 22-pass comprehensive security and code quality audit (75 findings resolved)
- On-device mode via LocalBridge with automatic privilege escalation
- QEMU/KVM virtualization for on-device guest VM management
- Zero shell injection vectors across all 147 tools
- Every numeric parameter bounded with Zod `.min()/.max()` constraints
- Centralized process cleanup registry for all child process modules

---

## v0.9.0 — Firmware Intelligence & Ecosystem

6 new tools, 2 new modules. Total: 133 tools across 37 modules.

- **Modem Firmware Analysis** — Multi-family baseband version parsing (Shannon, Qualcomm MPSS, MediaTek MOLY, Unisoc, HiSilicon, Intel XMM), bootloader parsing, RIL implementation parsing, comprehensive diffing and version history tracking
- **Workflow Marketplace** — Community sharing for workflow definitions with SHA-256 integrity verification
- **GraphQL API** — Composed device queries via optional HTTP endpoint (requires `graphql` package)

## v0.8.0 — Intelligence & Monitoring

12 new tools, 4 new modules, 1 new transport. Total: 127 tools across 35 modules.

- **Automated Test Generation** — Generate test workflows from live UI hierarchy or package intent registrations
- **OTA Update Monitoring** — Track system fingerprint across sessions, detect firmware changes
- **RIL Message Interception** — Passive radio interface layer monitoring with category-based filtering
- **Device Profile Library** — Hardware-specific knowledge base with auto-detection
- **WebSocket Transport** — Bidirectional streaming MCP transport (optional `ws` package)

## v0.7.0 — Advanced Tooling

17 new tools, 5 new modules. Total: 115 tools across 31 modules.

- **AT Command Interface** — Direct modem AT command passthrough with multi-chipset auto-detection (Shannon, Qualcomm, MediaTek, Unisoc)
- **Screenshot Diffing** — Pixel-level visual regression detection with PNG decoding and tolerance thresholds
- **Workflow Orchestration** — Declarative JSON workflow engine with variables, conditionals, and loops
- **Split APK Management** — App bundle installation, split inspection, APEX module listing
- **Device Mirroring** — Live screen mirroring via scrcpy integration

## v0.6.0 — Security & Cloud Testing

12 new tools, 4 new modules. Total: 98 tools across 26 modules.

- **Accessibility Auditing** — WCAG checks for touch targets, labels, focusability
- **Regression Detection** — Performance baseline capture and comparison
- **Device Farm Integration** — Firebase Test Lab via gcloud CLI
- **Plugin Registry** — Community plugin search, install, and management
- **HTTP/SSE Transport** — Browser-based MCP client support

## v0.5.0 — Baseband/Modem Integration

6 new tools, 1 new module. Total: 86 tools across 22 modules.

- **Baseband Tools** — Modem firmware ID, cell identity, signal measurements, neighboring cells, carrier config, modem logs

## v0.4.0 — Advanced Features

14 new tools, 5 new modules. Total: 80 tools across 21 modules.

- **Multi-Device Orchestration** — Parallel shell, install, and compare across devices
- **Snapshot/Restore** — Comprehensive device state capture and diffing
- **Network Capture** — tcpdump packet capture with pcap pull
- **CI/CD Integration** — Boot wait, readiness check, instrumented test runner
- **Plugin Architecture** — Dynamic ESM module loading

## v0.3.0 — Resources, Prompts & Security

8 new tools, 4 resources, 4 prompts, 3 new modules. Total: 66 tools across 16 modules.

- **Screen Recording** — Start/stop video capture with mp4 pull
- **Emulator Management** — AVD list, start, stop
- **Test Sessions** — Numbered step capture with screenshots and logcat
- **MCP Resources** — Device list, info, battery, telephony
- **MCP Prompts** — debug-crash, deploy-and-test, telephony-snapshot, airplane-cycle-test
- **Security Middleware** — Command filtering, rate limiting, audit logging

## v0.2.0 — Extended Core

14 new tools, 1 new module. Total: 58 tools across 13 modules.

- **Port Forwarding** — Forward, reverse, list
- **App Lifecycle** — Force stop, start, restart
- **Intent Resolution** — Discover registered activities, services, receivers
- **Bug Report** — Full bugreport zip capture
- **Settings** — Read/write any Android setting with verification

## v0.1.0 — Initial Release

44 tools across 12 modules. Core ADB integration.

- Device discovery, shell execution, package management, file operations
- Logcat snapshots and persistent watchers, diagnostics (dumpsys, telephony, battery)
- UI screenshots, input events, activity inspection
- Device control (airplane, WiFi, data, location, screen)
- Wireless debugging, build tools, health check
- ADB bridge with transient retry and device caching
