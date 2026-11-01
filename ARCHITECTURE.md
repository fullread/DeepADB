# DeepADB Architecture

This document orients contributors to how the server is put together. For the
user-facing feature overview see the README; for the security model and its
guarantees see SECURITY.md.

## Overview

DeepADB is a Model Context Protocol (MCP) server that exposes 209 tools across
49 tool modules, plus 5 resources and 4 prompts, for driving Android devices
through ADB (or directly, on-device). It is plain TypeScript compiled to
`build/` and run on Node (>= 22). There is no application framework: the
structure is a small set of explicit layers wired together at startup in
`server.ts`.

The server core uses `@modelcontextprotocol/server` v2. Built-in modules use
`registerTool`, `registerResource`, and `registerPrompt`, with explicit schema
objects. `BuiltinToolContext` exposes that native API; the original exported
`ToolContext` prefers legacy overloads for existing typed plugins;
`NativePluginToolContext` exposes v2 callback types for new plugins.
`plugin-compat.ts` adapts
legacy registrations, Zod 3/4 schemas, callback context, and registration-handle
updates before forwarding them to the same v2 server. Public handles retain
the original callbacks, Zod schemas (raw shapes become Zod objects), and resource
templates; successful updates synchronize that view with the converted SDK
registration. Prompt argument
completion metadata survives Zod 3/4 conversion and registration updates,
including optional arguments, without changing schema validation. Plugin initialization
(including asynchronous `register`) runs once at startup.

The adapter guards legacy and adapted v2 callback helpers with the originating
request's abort signal. Cancelled notifications/logging become no-ops; requests,
sampling and elicitation reject without contacting the current client. Legacy
requests retain v1's `ConnectionClosed` error contract, and native helpers use
the v2 SDK error. This preserves request lifetime across reconnects without
sandboxing plugin code or stopping handlers that ignore cancellation.

The v1 SDK remains a compatibility dependency for plugin imports and schema
conversion. Legacy SSE comes from `@modelcontextprotocol/server-legacy/sse`.
This migration keeps the existing 2024/2025 initialization protocol and the
stdio, `/sse` + `/message`, and `/ws` endpoints. It does not opt into the
2026-07-28 request lifecycle. The subsequent `/mcp` transport shares the same
server and single-client admission policy. Device managers, plugins, and handle cleanup are
not recreated per request. Plugins that use low-level SDK request handlers
directly must migrate those calls to v2; the adapter covers the registration
APIs above, not SDK-private or experimental task APIs.

## Layered design

```
MCP client (Claude Code / claude.ai / any MCP client)
        |  stdio . Streamable HTTP / legacy SSE . WebSocket
        |  (+ optional GraphQL API)
        v
Transport            index.ts selects one; server.ts builds the McpServer
        v
Tool / resource / prompt modules     src/tools/*, registered in server.ts
        v
ToolContext          unified dependency injection:
  { server, bridge, deviceManager, logger, security, config }
        v
Middleware           OutputProcessor . SecurityMiddleware .
                     InputSanitizer . Logger (stderr-safe)
        v
Bridge (auto)        AdbBridge (PC, via adb)  |  LocalBridge (on-device, sh/su)
        v
Android device
```

Each layer depends only on the layer beneath it, and every tool reaches its
dependencies through one injected `ToolContext` rather than importing globals.
That single seam is what keeps the tools uniform and testable.

## Request lifecycle

1. An MCP client sends a `tools/call` (or `tools/list`, `resources/*`,
   `prompts/*`) request over the active transport.
2. The MCP SDK `McpServer` validates the call against the tool's Zod schema.
   Out-of-range numbers and malformed input are rejected here, before any
   device command is constructed.
3. The tool handler runs. User values used as shell arguments are quoted or
   validated with the sanitizers described in SECURITY.md. Generic shell tools
   intentionally accept commands; argument escaping does not authorize them.
4. The handler calls `ctx.bridge.shell(...)` or a higher-level helper. Handlers
   that explicitly call `SecurityMiddleware.checkCommand` apply command
   filtering and rate limiting when `DA_SECURITY=true`, plus audit logging when
   enabled. The bridge does not apply these checks globally: dedicated tools
   such as `adb_reboot` and `adb_wifi` bypass that middleware. Use `inspect` for
   the enforced three-tool catalog. Handlers use output-processing helpers as
   appropriate for their results.
5. The bridge dispatches to the device. `AdbBridge` shells out to the `adb`
   binary (USB or Wi-Fi); `LocalBridge` runs `sh`/`su` directly when DeepADB
   runs on the device (Termux). Serial routing, retries, timeouts, and caching
   live in this layer.
6. The result is normalized and returned to the client as an MCP tool result.

## The two bridges

The bridge is selected automatically at startup. `AdbBridge` is the default and
talks to a local `adb` server; the device serial is resolved per call, so one
server can address multiple devices. `LocalBridge` is used when the process
detects it is running on the device itself, and routes a frozen 16-command
allowlist through `su` (the allowlist is `Object.freeze()`d and cannot be
widened at runtime). Both expose the same interface, so tools never know which
bridge they run against.

## Transports

`index.ts` reads environment variables and selects exactly one MCP transport:

- default: stdio (JSON-RPC over stdin/stdout), for Claude Code and local clients
- `DA_HTTP_PORT`: Streamable HTTP (`POST/GET/DELETE /mcp`), legacy SSE (`GET /sse`, `POST /message`), and `GET /health`
- `DA_WS_PORT`: WebSocket (`ws://host/ws`, `GET /health`), needs the optional `ws` package

A standalone GraphQL API (`DA_GRAPHQL_PORT`, `POST /graphql`) can run alongside
any of the above in the full profile for composed device queries; it needs the optional `graphql`
package. Network transports support bearer-token auth (`DA_AUTH_TOKEN`) and CORS
restriction; read SECURITY.md before exposing a port beyond loopback.

`middleware/origin.ts` enforces exact browser Origins before HTTP/SSE session
handling, GraphQL resolver execution or WebSocket upgrade. Native clients may omit Origin. Browser
preflights use explicit method/header allowlists; actual requests authenticate
independently. WebSocket accepts one active client and rejects another with
HTTP 409. Legacy SSE retains its authorized-client replacement behavior.
`POST /message` requires exactly one current `sessionId` query value (400 for
missing/duplicate IDs; 404 for a mismatch while a session is active). Dispatch
rechecks transport identity after body upload, so an admitted message cannot
execute after its SSE connection is replaced. With no SSE session, the existing
503 response is retained.

`streamable-http.ts` uses the official `@modelcontextprotocol/node` adapter.
It reserves one session after validating initialization, shares admission with
SSE, limits POST bodies to 1 MiB/15 seconds, and expires inactive sessions
(30 minutes by default, configurable from 1 second to 1 hour). A session ID
never bypasses Origin or bearer checks. Request IDs are reserved atomically
before SDK dispatch; duplicate in-flight IDs and within-batch duplicates reject
the whole body with 400 / `-32600`. Undispatched reservations are released if the
SDK rejects headers or the batch. Accepted IDs are tracked until their response
is sent or valid cancellation is processed; the idle countdown restarts after
the last active request leaves that set. Bounded uploads also suspend expiry;
cancelled requests with lingering response streams do not. Idle GET streams do not hold the
session open. Bookkeeping belongs to each transport, so late replies cannot
affect a replacement session. DELETE can still terminate active sessions;
the idle timeout is not an absolute tool execution deadline. DELETE and expiry close the transport;
invalid initialization releases the slot. Plugin registration and device/tool
state survive reconnections. No event replay or per-client device isolation is
provided. Long-lived watchers remain process-owned.

Browser reload recovery tracks peer-aborted successful GET notification streams
and all in-flight HTTP responses, including uploads before body parsing. A valid
initialize from the session's same non-empty Origin can replace it only when no
MCP requests or HTTP streams remain. Header validation precedes retirement, and
an admission guard holds the slot throughout close/connect, including against
SSE. A retained ID can resume before replacement; the retired ID returns 404.
Originless native sessions, POST-only sessions without a GET disconnect, and
server-initiated GET closure retain the explicit DELETE/expiry lifecycle.
Per-request ownership tokens prevent late sends or upload cleanup from deleting
a newer request's reservation. Cancellation validation matches the SDK, and
bookkeeping is released after its cancellation handler runs.

`tool-profile.ts` validates the startup-only `full`/`inspect` choice. Full mode
returns the original server unchanged. Inspect initializes only the device
module and guards registration, registration-handle renames/updates, and
invocation against three approved tool names. Other modules, resources, prompts,
plugins and the result-handle sweep do not run. GraphQL configuration fails
startup in inspect mode because its resolvers bypass MCP handlers. This is a
tool admission policy, not a device allowlist or a plugin sandbox.

## Security boundary

Because every tool can interpolate caller-supplied parameters into an `adb
shell` command, the sanitizers in `src/middleware/sanitize.ts` are the
command-injection boundary and run unconditionally, independent of the opt-in
security middleware. The guarantees are narrow and explicit:

- `shellQuote(s)` returns a POSIX single-quoted token that decodes back to
  exactly `s` for any input. Interpolated values cannot break out of their
  argument, regardless of metacharacters, quotes, or newlines they contain.
- `validateShellArg(s)` rejects identifiers (package names, property keys,
  service names, etc.) that contain shell metacharacters, so those values are
  refused outright rather than escaped.

What this layer does NOT do: it does not decide whether a command is allowed
(the opt-in SecurityMiddleware filters only paths that call it; it is not a
global policy for dedicated tools), and it does not
validate semantic correctness (that is the per-tool Zod schema). It only
guarantees that a value cannot escape the lexical position it was placed in.
These properties are exercised by `tests/test-sanitize-fuzz.mjs`, which
property-tests round-trip faithfulness and the rejection invariant across
thousands of generated, metacharacter-dense inputs. See SECURITY.md for the
complete model, including transport auth, privilege escalation, and AT-command
handling.

## SQLite and GraphQL execution boundaries

SQLite reads pin the package directory and validate opened descriptors before
copying the main database/WAL to a private directory. This prevents a root read
from following an app-controlled parent link. Both backends query the private
snapshot: an isolated Node subprocess on hosts, or sqlite3 on the device.
Cancellation kills the query child and cleanup waits for child close before
removing files. Native SQLite heap limits complement V8/output limits; bounded
SQL projection prevents large BLOB materialization on older LTS Node. The source
app's SHM file is never opened. Host inspection needs Node 22.16+.

GraphQL shares Origin admission with MCP HTTP and WebSocket. Expanded-AST
budgets precede execution; runtime device-operation budgets and a shared pool
bound work across aliases, device lists and concurrent requests. Cancellation
stops queued work; active bridge calls retain their timeouts. HTTP URL authority
formatting brackets IPv6 literals independently of the listen address.
The public error boundary uses a closed `GraphQLClientError` code/message table
for request and work-limit failures. Schema validation stays informative;
unexpected errors are masked in both the HTTP catch path and GraphQL execution
results, with internal diagnostics restricted to stderr. Field paths, locations
and execution-result `data` remain available to clients. Shared bearer parsing
is bounded and linear before the existing exact, constant-time byte comparison.
See SECURITY.md for numerical limits and snapshot consistency caveats.

## Testing model

Tests live in `tests/` as standalone `.mjs` suites discovered by
`tests/run-all.mjs`. The shared harness (`tests/lib/harness.mjs`) spawns the
compiled `build/index.js` over stdio and drives it as a real MCP client, so
the suites exercise the actual server, not mocks.

Suites fall into two groups:

- Device-free: validate behavior with no hardware attached. These run in CI.
  `test-boundaries` (Zod bounds and enum rejection), `test-next-version`,
  `test-result-handles`, `test-supply-chain`, `test-transports` (boots each transport on an ephemeral
  port and does a real MCP round-trip), `test-sdk-compat` (v1/v2 clients,
  plugin APIs and schemas, auth, reconnects, and catalog compatibility),
  `test-sanitize-fuzz`, `test-browser-access`, `test-local-llm`,
  `test-audit-hardening`, and `test-code-scanning`. Device-dependent assertions
  inside an otherwise device-free suite skip-guard
  themselves when no device is present, so the run stays green either way.
- Device-dependent: require a connected device or emulator and are run locally.
  `test-next-version-device` exercises the runtime audit, app-route context,
  guarded SQLite open, Wear preflight, and Shannon handshake. On validated
  Shannon hardware it requires a real terminal `AT`/`OK` result rather than
  accepting successful tool registration alone.

Useful commands:

- `npm test` runs the full suite (needs a device for the device-dependent parts).
- `npm run test:ci` runs only the device-free suites (`run-all.mjs --ci`).
- `npm run coverage` runs the suite under c8 and writes `coverage/` (lcov + summary).

The v1.1.5 final audit baseline on Windows/Node 22.23.4 passed 295
checks with zero failures and 17 skips (312 total) across ten suites. Sixteen
skips require hardware; one requires file-symlink creation privileges. The new
41-check hardening suite also passes on Node 24.22.2. Eight disposable Pixel
path/link/race probes cover the POSIX cases unavailable on this Windows account.
Those initial host checks preceded the separate on-device release validation.

The subsequent full host/ADB regression on Pixel 6a / Android 16, with Node
24.22.2, passed all 22 suites: 728 passed, zero failed, 18 expected skips
(746 checks). It includes all 41 hardening checks, 33 local-LLM checks,
36 client/plugin compatibility checks and 46 UI checks with PIN recovery.
The skips comprise five on-device-only QEMU checks, twelve Windows/POSIX/
tcpdump cases and the Windows file-symlink capability case. Every suite had
an explicit successful summary; the aggregate runner exited zero. The run itself
changed no repository files and did not deploy the build.

Release preparation separately validates the production package on Termux Node
24.22.1 with SQLite 3.54.1. The staged LocalBridge passed strict schema/query
reads, rejected SQL writes, runtime/health checks and the live Shannon handshake.
Eight Chromium checks exercised its authenticated SSE/Streamable HTTP routes,
Origin denial and repeated reloads; six optional WebSocket/GraphQL checks verified
real device reads and token/Origin admission. Production installs need optional
`ws`/`graphql` packages when those transports are enabled. The 1.1.4 rollback
copy initializes successfully under the updated runtime and is retained. After
promotion to the normal device path, auto-detection selected LocalBridge and
all eight strict device checks passed again. The 1.1.5 host hardware rerun passed
728/0/18 (pass/fail/skip); device-free Node 24 coverage passed 295/0/17.
Hosted CI covers Node 22/24/26, browser MCP compatibility, coverage and dependency
auditing. CodeQL separately analyzes application code and GitHub Actions.

The original nine CI suites contained 270 checks (254 device-free passes and
16 hardware-dependent skips). A tenth suite, `test-audit-hardening`, covers
the seven final-audit findings; its symlink cases vary with host capabilities.
Before that final hardening pass, the full Pixel 6a / Android 16 host-hardware
run passed 687 checks with zero failures and 17 expected environment-specific
skips (704 total), including PIN-based screen recovery, request-ID/cancellation
handling, and cancelled plugin callback guards. The released v1.1.4 baseline was 604 passed with
the same 17 skips. Real phone-to-watch Wear validation remains deferred.

Unreleased security hardening adds an eleventh device-free suite,
`test-code-scanning`, for bearer-parser limits, GraphQL error boundaries and the
split-APK shell-alert data flow. These local fixture checks do not replace
hosted CodeQL analysis or the release hardware baselines above.
On Windows/Node 26.12.1, the eleven suites passed 321 checks with zero failures
and 17 expected skips (338 total); the new suite contributed 26 passes. Build,
lint and all eight real Chromium compatibility checks passed. Hardware and
hosted CodeQL were not rerun for these changes.

Model-driven validation with llama.cpp b11960 and Qwen3.5-4B Q4_K_M passed over
native stdio and authenticated browser HTTP/SSE using `inspect`. Browser HTTP
reloads that lose the client's session ID now use the guarded reclamation path
above. See LOCAL_LLMS.md for the tested client matrix and remaining lifecycle limits.

`test-browser-access` covers Origin rejection, preflight headers, authentication,
and WebSocket admission without hardware. The separate `npm run test:browser`
command performs eight real Chromium CORS/session/profile checks with a temporary browser profile;
it is not part of the default CI suite and requires Chrome, Edge, or Chromium.
`test-local-llm` covers Streamable HTTP lifecycle and admission, v1/v2 clients,
stateful legacy plugins, malformed/oversized uploads, long-running concurrent
calls, cancellation, DELETE/replacement, guarded browser reloads, stale SSE uploads, and profile enforcement
across stdio, SSE, Streamable HTTP and WebSocket.
It also verifies atomic duplicate-ID rejection, reservation cleanup, malformed
cancellation, and the security guide's shared/network deployment recipes.

GitHub also runs dependency-advisory auditing and CodeQL analysis. The weekly
emulator lane is informational: it preserves execution failures and publishes
pass/fail/skip counts, but unavailable physical-device capabilities can still
cause test failures. Its green workflow status must not be interpreted as an
all-tests-pass result. See CONTRIBUTING.md for CI and merge requirements.
The reporting helper has separate mocked process tests under `tests/ci/`;
these validate CI infrastructure and do not replace the real-server suites.

Build discipline: the project compiles clean under a strict `tsconfig`
(`strict`, plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`). Land changes with zero errors and zero warnings.

## Adding a tool

1. Add (or extend) a module in `src/tools/` that exports a
   `registerXxxTools(ctx: ToolContext)` function.
2. Inside it, call `ctx.server.registerTool(name,
   { description, inputSchema: z.object(zodShape) }, handler)` using the
   native `BuiltinToolContext` type (often imported locally as `ToolContext`).
   Give every `z.number()` an explicit `.min()/.max()`, add a `.describe()` to
   each parameter, and pass any value that reaches a shell command through
   `shellQuote()` (never interpolate raw input).
3. Wire the module into `server.ts`: import its `registerXxxTools` and call it
   alongside the others (this is the single registration point).
4. Add tests: a device-free boundary test in `tests/test-boundaries.mjs` for
   input validation, and on-device behavior in the most relevant suite.
5. Document the tool in the README tool list and add a CHANGELOG entry.

## Repository layout

```
src/
  index.ts            entrypoint: env parsing, transport selection
  server.ts           createServer(): builds ToolContext, registers everything
  tool-context.ts     the injected dependency bundle
  plugin-compat.ts     legacy plugin registration and callback adapter
  http-transport.ts   shared HTTP router and legacy SSE (server-legacy bridge)
  streamable-http.ts  bounded /mcp session lifecycle (official Node adapter)
  tool-profile.ts     startup profile validation and tool admission guards
  ws-transport.ts     WebSocket transport (optional ws package)
  graphql-api.ts      standalone GraphQL API (optional graphql package)
  config/             version and configuration
  bridge/             ADB and on-device execution, device discovery and routing
  middleware/         sanitize, security, output, logger, auth, Origin checks, etc.
  tools/              49 tool modules + resources.ts + prompts.ts
build/                compiled output (tsc); what actually runs
tests/                .mjs suites + run-all.mjs + lib/harness.mjs
```
