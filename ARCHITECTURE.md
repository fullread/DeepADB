# DeepADB Architecture

This document orients contributors to how the server is put together. For the
user-facing feature overview see the README; for the security model and its
guarantees see SECURITY.md.

## Overview

DeepADB is a Model Context Protocol (MCP) server that exposes 204 tools across
45 tool modules, plus 5 resources and 4 prompts, for driving Android devices
through ADB (or directly, on-device). It is plain TypeScript compiled to
`build/` and run on Node (>= 22). There is no application framework: the
structure is a small set of explicit layers wired together at startup in
`server.ts`.

## Layered design

```
MCP client (Claude Code / claude.ai / any MCP client)
        |  stdio . HTTP/SSE . WebSocket   (+ optional GraphQL API)
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
3. The tool handler runs. Any user value destined for a shell command is
   passed through `shellQuote()` (see SECURITY.md) so it cannot break out of
   its argument position.
4. The handler calls `ctx.bridge.shell(...)` or a higher-level helper. The
   middleware layer applies command filtering and rate limiting (when
   `DA_SECURITY=true`), audit logging, and output processing.
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
- `DA_HTTP_PORT`: HTTP/SSE (`GET /sse`, `POST /message`, `GET /health`)
- `DA_WS_PORT`: WebSocket (`ws://host/ws`, `GET /health`), needs the optional `ws` package

A standalone GraphQL API (`DA_GRAPHQL_PORT`, `POST /graphql`) can run alongside
any of the above for composed device queries; it needs the optional `graphql`
package. Network transports support bearer-token auth (`DA_AUTH_TOKEN`) and CORS
restriction; read SECURITY.md before exposing a port beyond loopback.

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
(that is the opt-in allowlist/blocklist in SecurityMiddleware), and it does not
validate semantic correctness (that is the per-tool Zod schema). It only
guarantees that a value cannot escape the lexical position it was placed in.
These properties are exercised by `tests/test-sanitize-fuzz.mjs`, which
property-tests round-trip faithfulness and the rejection invariant across
thousands of generated, metacharacter-dense inputs. See SECURITY.md for the
complete model, including transport auth, privilege escalation, and AT-command
handling.

## Testing model

Tests live in `tests/` as standalone `.mjs` suites discovered by
`tests/run-all.mjs`. The shared harness (`tests/lib/harness.mjs`) spawns the
compiled `build/index.js` over stdio and drives it as a real MCP client, so
the suites exercise the actual server, not mocks.

Suites fall into two groups:

- Device-free: validate behavior with no hardware attached. These run in CI.
  `test-boundaries` (Zod bounds and enum rejection), `test-result-handles`,
  `test-supply-chain`, `test-transports` (boots each transport on an ephemeral
  port and does a real MCP round-trip), and `test-sanitize-fuzz`. Device-
  dependent assertions inside an otherwise device-free suite skip-guard
  themselves when no device is present, so the run stays green either way.
- Device-dependent: require a connected device or emulator and are run locally.

Useful commands:

- `npm test` runs the full suite (needs a device for the device-dependent parts).
- `npm run test:ci` runs only the device-free suites (`run-all.mjs --ci`).
- `npm run coverage` runs the suite under c8 and writes `coverage/` (lcov + summary).

Build discipline: the project compiles clean under a strict `tsconfig`
(`strict`, plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`). Land changes with zero errors and zero warnings.

## Adding a tool

1. Add (or extend) a module in `src/tools/` that exports a
   `registerXxxTools(ctx: ToolContext)` function.
2. Inside it, call `ctx.server.tool(name, description, zodSchema, handler)`.
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
  http-transport.ts   HTTP/SSE transport (MCP SDK SSEServerTransport)
  ws-transport.ts     WebSocket transport (optional ws package)
  graphql-api.ts      standalone GraphQL API (optional graphql package)
  config/             version and configuration
  middleware/         bridge, sanitize, security, output, logger, auth, etc.
  tools/              45 tool modules + resources.ts + prompts.ts
build/                compiled output (tsc); what actually runs
tests/                .mjs suites + run-all.mjs + lib/harness.mjs
```
