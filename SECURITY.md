# Security

DeepADB provides deep access to Android devices — shell execution, root commands, file operations, modem AT commands, and network capture. This power is intentional and necessary for its use cases, but it requires understanding the security model.

## Threat Model

DeepADB is a **local development and research tool**. Its threat model assumes:

- **Trusted operator**: The person running DeepADB controls the host machine and the connected Android device(s).
- **Untrusted input**: MCP clients (Claude, Cursor, etc.) may pass user-supplied parameters that could contain injection attempts.
- **Trusted transport**: stdio mode communicates over local pipes. HTTP/SSE, WebSocket, and GraphQL transports bind to `127.0.0.1` by default and deny cross-origin requests.

DeepADB is **not designed** for multi-tenant, internet-facing, or shared-server deployments without additional hardening. If you need to expose it over a network, enable the security middleware and restrict CORS origins.

## Security Architecture

### Input Sanitization (always active)

Every tool that interpolates user-supplied parameters into shell commands validates inputs before execution. This is not optional — it runs regardless of security middleware settings.

- **`validateShellArg()`** rejects strings containing shell metacharacters (`;`, `|`, `&`, `$`, backticks, parentheses, etc.) for identifiers like package names, property keys, service names, and setting keys.
- **`shellEscape()`** wraps file paths in single quotes with proper escaping — `'\''` closing/reopening is used to neutralize embedded single quotes without breaking single-quote context.
- **`escapeQemuShellArg()`** (exported from `qemu.ts`) applies the same unconditional single-quote-with-escape to every QEMU argv element on the KVM path, where arguments are composed into a `su -c "..."` command string. The non-KVM path uses `spawn(cmd, args)` with an argv array and requires no escaping.
- **`adb_input`** applies type-specific validation: `tap`/`swipe` accept only numeric coordinates, `keyevent` accepts only alphanumeric keycodes, `text` is shell-escaped.
- **AT commands** are validated against a separate character set that rejects shell operators while allowing legitimate AT syntax (`+`, `=`, `?`, etc.). AT command strings are fed to `printf` via `%s` format, never the format position itself, preventing format string injection from commands containing `%` characters (e.g., `AT%RESTART`). Device-node discovery and exchange require character devices, and no-create writes prevent missing `/dev` candidates from becoming regular files.
- **SQLite inspection** validates one read-only statement, rejects linked package/database directories and database/WAL files, and checks each opened descriptor's kernel path and link count before reading. The OS-owned Android user root may retain its normal compatibility alias. Queries run only against a private snapshot; SQLite never opens the live app path or its SHM file. Database plus WAL is capped at 64 MiB, failed WAL reads fail the inspection, and snapshots are removed after success, error, timeout or cancellation.
- **SQLite execution limits**: at most two inspections run concurrently. Host queries run in a separate Node process with a 10-second execution deadline, cancellation, a 64 MiB SQLite native-heap limit, a 64 MiB V8 old-space limit, 128 columns, bounded row iteration and 64 KiB formatted output. SQL-side BLOB/text projection prevents large values from being materialized in Node on older LTS versions; newer Node also limits SQLite value size. These are allocation/output budgets, not a promise of 64 MiB total process RSS. On-device sqlite3 uses the private snapshot, the same deadline/native-heap cap, a 64 KiB value limit and 128 KiB captured-output limit. Snapshot copies have a separate 60-second deadline per file. Host inspection requires Node 22.16+; on-device inspection requires a trusted sqlite3 binary.
- **Split APK operands** are resolved to absolute paths before argv construction. LocalBridge recognizes only the supported installation flags and quotes every filename, including names beginning with a dash.
- **`sed` escaping in `adb_file_replace`** (`files.ts`) applies `'\''` closing/reopening to both the pattern and the replacement value, handling single quotes that would otherwise close the outer shell single-quote. Zod also rejects newlines in `find`/`replace` since sed treats embedded newlines as script-command separators.
- **Device node paths** must start with `/dev/` and cannot contain path traversal (`..`).

**Guarantees and verification.** `shellQuote()` provides a round-trip property: for any input string, its single-quoted output decodes back to exactly that string under POSIX shell rules, so no metacharacter, embedded quote, or newline can escape the argument position. `validateShellArg()` provides the complementary rejection property: any value containing a shell metacharacter is refused rather than escaped. These two properties are exercised by `tests/test-sanitize-fuzz.mjs` using property-based fuzzing (thousands of generated, metacharacter-dense inputs) alongside fixed attack-vector regression cases. The sanitizers prevent a value from escaping its lexical position; they do not authorize commands (the opt-in allowlist below does) or validate semantic correctness (the per-tool Zod schema does).

SQLite snapshots are diagnostic copies, not transactional backups. Concurrent app
writes can make a snapshot inconsistent; stop the writer when a consistent view
is necessary. Copy failures are reported rather than silently discarding the WAL.

### Zod Parameter Bounds (always active)

Every `z.number()` parameter across all 209 tools has explicit `.min()/.max()` constraints. This prevents resource exhaustion from extreme values — for example, requesting a 999999-second sleep or a buffer size of 2^31.

### Security Middleware (opt-in enforcement)

Set `DA_SECURITY=true` to enable command filtering and rate limiting **on paths
that call `SecurityMiddleware.checkCommand`**, such as generic shell and workflow
shell steps. This is not a global tool authorization policy:

- **Blocklist**: `DA_BLOCKED_COMMANDS` — comma-separated substrings rejected by checked command paths.
- **Allowlist**: `DA_ALLOWED_COMMANDS` — if set, checked commands must match at least one substring.
- **Rate limiting**: `DA_RATE_LIMIT` — maximum checked commands per minute (0 = unlimited); not an HTTP request or global tool-call limit.
- **Audit logging**: `DA_AUDIT_LOG` — enabled by default since v1.0.3. Logs commands passing through this middleware to stderr with credential redaction. Set `DA_AUDIT_LOG=false` to disable. It is not a complete audit of every dedicated tool or plugin action.

Dedicated tools such as `adb_reboot` and `adb_wifi` call the bridge directly and
do not consult this command filter. `DA_ALLOWED_COMMANDS=getprop` or a `reboot`
blocklist does not make the `full` profile read-only. Use the server-enforced
`DA_TOOL_PROFILE=inspect` for the three reviewed device/property tools. Full mode
remains appropriate only for an operator trusted with its entire catalog and plugins.

### Privilege Escalation (on-device mode)

When running in Termux, the LocalBridge uses a **frozen 16-command allowlist** to determine which commands get routed through `su`. This allowlist is a `ReadonlySet` wrapped in `Object.freeze()` — it cannot be modified via environment variables, runtime API, or configuration files.

### Process Lifecycle

All modules that spawn child processes (logcat watchers, RIL interceptors, screen mirroring, QEMU VMs, emulators) register with a centralized cleanup registry. SIGINT, SIGTERM, and process exit trigger cleanup of all registered child processes, preventing orphans.

### Network Transport Security

- **stdio** (default): No network exposure. Communication over local pipes only.
- **HTTP/SSE**: Binds to `127.0.0.1`. Requests with an unlisted Origin receive HTTP 403 before session handling. Set `DA_HTTP_CORS_ORIGIN` to an exact HTTP(S) origin or comma-separated list. Invalid allowlists fail startup. Requests without Origin remain supported.
- **Streamable HTTP**: `/mcp` shares the HTTP/SSE Origin and bearer checks, including GET, POST and DELETE. Session IDs are random UUIDs and never replace authentication. Only one MCP client is admitted across both HTTP protocols. POST bodies are limited to 1 MiB with a 15-second upload deadline. Idle sessions expire after 30 minutes by default (`DA_HTTP_SESSION_TTL_MS`, 1000–3600000 ms). Invalid or deleted session IDs receive 404. Browser clients can read the explicitly exposed `Mcp-Session-Id` header.
- **WebSocket**: Same binding and Origin defaults, configured through `DA_WS_CORS_ORIGIN`. Origin and bearer authentication are checked before the upgrade. A second active client receives HTTP 409 instead of an unusable open socket.
- **GraphQL**: Uses the same Origin-rejection middleware, with exact origins in `DA_GRAPHQL_CORS_ORIGIN`. An unlisted Origin receives 403 before resolver execution; native requests may omit Origin. Tokens remain mandatory when configured. POST bodies are capped at 1 MiB with a 15-second upload deadline; query text at 64 KiB and parsing at 4096 tokens. Expanded AST budgets cap depth at 10, fields at 100, aliases at 16 and selections at 256, including fragments. Property-key lists are capped at 100 and device lists at 16. Each request gets 64 device operations and a 30-second admission deadline; disconnect/deadline prevents queued work from starting. Already-running I/O retains its bridge timeout and concurrency slot. At most eight HTTP queries and four underlying operations run concurrently across the API. Responses are capped at 1 MiB.

Legacy SSE `POST /message` requires exactly one session ID matching the active
connection. Missing/duplicate IDs receive 400; mismatches receive 404 while an
SSE session is active (503 when none is active). Transport identity is checked
again after upload, so a replaced client's pending body cannot invoke a handler.
These checks supplement Origin and bearer authentication, not replace them.

Streamable HTTP idle expiry is suspended while MCP requests or bounded uploads are active and
re-armed after the last response or cancellation. An open GET stream alone does
not hold a session indefinitely. Authenticated DELETE still terminates active
sessions. This idle limit is not an absolute execution deadline; cancellation
requires handler cooperation and does not reverse device actions or stop
process-owned watchers. Late responses cannot reset a replacement session's timer.

Before SDK dispatch, `/mcp` atomically reserves request IDs and rejects a whole
POST with HTTP 400 / JSON-RPC `-32600` if it duplicates an in-flight ID or repeats
an ID within its batch. Rejected batches execute no partial work. SDK-rejected
uploads release only their undispatched reservations. Valid cancellation and
responses release their own entries; malformed cancellation cannot clear active
work, and late replies cannot clear a newer request's entry.

A fresh `/mcp` initialization can reclaim a browser session only after a successful
GET notification stream was closed by its peer and no MCP requests, uploads or
HTTP response streams remain. It requires the same non-empty Origin as the original
initialization and passes the usual Origin, bearer, body and header validation
before retiring the old session. The slot remains reserved throughout replacement,
including against legacy SSE; old IDs subsequently return 404. Reconnection with a
retained ID remains supported. Originless native clients, POST-only clients without
an observed GET disconnect, and normal server-initiated stream closures do not
enable reclamation. This does not identify individual tabs or operators sharing
an Origin and credentials; use separate processes for concurrent clients.

Plugin callback contexts also honor cancellation and disconnects. Legacy
`sendNotification` becomes a no-op and `sendRequest` rejects once the request's
signal is aborted, preserving v1 behavior. The adapted v2 `mcpReq` notification,
logging, request, sampling and elicitation helpers have the same lifetime guard,
so saved callbacks cannot send to a replacement client. This does not sandbox
trusted plugins or stop handlers that ignore cancellation from doing local work.

### Bearer Token Authentication

When `DA_AUTH_TOKEN` is set, network requests (HTTP/SSE, WebSocket, GraphQL) must include a valid `Authorization: Bearer <token>` header. Requests without a valid token receive HTTP 401. WebSocket authentication fails before upgrade, replacing the old post-upgrade 4401 close behavior. Token comparison uses constant-time `crypto.timingSafeEqual()` to prevent timing-based side-channel attacks.

Health check endpoints (`GET /health`) are exempt from authentication — they only return transport status and version info, no device data.

HTTP/SSE and WebSocket health endpoints still enforce Origin policy. Browser
OPTIONS preflights are token-free, but enforce the Origin, method, and explicit
header allowlists. They neither create nor replace a session. Actual SSE
subscriptions and message POSTs must each authenticate. Use authenticated HTTP
for browser clients: native browser WebSockets cannot set arbitrary bearer
headers. See [LOCAL_LLMS.md](LOCAL_LLMS.md).

### Tool profiles

`DA_TOOL_PROFILE=full` is the compatible default, including installed trusted
plugins. `inspect` exposes only device listing, device information and property
reads; it rejects excluded tool registration and invocation, including direct
calls by name. Resources, prompts, workflows and plugin management tools are
not registered, plugin files are not imported, and GraphQL configuration fails
startup. The health check is excluded because it performs a device write probe.
Unknown profiles fail startup. Restart to change profiles.

Profiles do not scope devices or redact returned properties. Full mode's
plugins retain host-process privileges, and the existing command restrictions
remain independent. HTTP sessions share process-owned device/plugin state;
disconnect or expiry does not stop background device operations. This is not
multi-tenant isolation.

When `DA_AUTH_TOKEN` is not set, all requests pass through without authentication (backwards compatible). This is appropriate for localhost-only deployments but **must be combined with a token for any network-exposed deployment**.

Example:
```bash
# Generate a strong token (256 bits of entropy)
export DA_AUTH_TOKEN="$(openssl rand -hex 32)"

# Alternative without openssl (Node.js)
export DA_AUTH_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"

# Server
DA_AUTH_TOKEN=$DA_AUTH_TOKEN DA_HTTP_PORT=3000 npm start

# Client
curl -H "Authorization: Bearer $DA_AUTH_TOKEN" http://localhost:3000/sse
```

**Token strength requirements:**
- Minimum recommended length: 32 characters (128+ bits of entropy for hex)
- DeepADB warns at startup if the token is shorter than 32 characters, uses repeated characters, or matches common weak patterns
- Use `openssl rand -hex 32` or `crypto.randomBytes(32)` — do not use dictionary words or predictable values

**Important:** Bearer tokens are transmitted in plain text over HTTP. For deployments beyond localhost, use a reverse proxy with TLS (see below) to prevent token interception on the wire.

### External Resource Fetching

The plugin registry and workflow marketplace fetch from configurable URLs. All fetch operations use streaming body reads with a **5 MB size limit** to prevent memory exhaustion. Plugin downloads verify SHA-256 integrity hashes when provided by the registry manifest.

## Recommended Configurations

### Personal development (default)

```bash
npm start   # stdio mode, full profile, command filtering off
```

Appropriate when you are the only trusted operator, running locally via an MCP client. Middleware-checked commands are logged by default; this is not a complete per-tool audit trail.

### Shared or demo environments

```bash
DA_TOOL_PROFILE=inspect \
DA_AUTH_TOKEN="$(openssl rand -hex 32)" \
DA_HTTP_HOST=127.0.0.1 \
DA_HTTP_PORT=3000 \
DA_HTTP_CORS_ORIGIN="http://localhost:8080" \
npm start
```

Exposes only device discovery, device information and `getprop`, with bearer
authentication and an exact browser Origin. Replace the Origin with the actual
UI origin. Mutating tools, generic shell access, plugins, resources, prompts,
workflows and GraphQL are unavailable. Share the token only with authorized
clients; use a separate process per simultaneous client.

### Network-exposed deployments

```bash
DA_TOOL_PROFILE=inspect \
DA_AUTH_TOKEN="$(openssl rand -hex 32)" \
DA_HTTP_HOST=127.0.0.1 \
DA_HTTP_PORT=3000 \
DA_HTTP_CORS_ORIGIN="https://your-app.example.com" \
npm start
```

Run this loopback listener behind a TLS reverse proxy for network access (see
below). The `inspect` profile enforces the three-tool catalog; Origin and bearer
checks protect the HTTP endpoints. It is not a device allowlist or a guarantee
that returned properties are non-sensitive. Configure request/concurrency limits
at the reverse proxy if needed; `DA_RATE_LIMIT` does not cover these inspect tools.
Do not switch to `full` and assume command allowlisting provides equivalent protection.

### HTTPS via Reverse Proxy

DeepADB does not implement TLS directly — certificate management is better handled by purpose-built tools. For HTTPS, use a reverse proxy:

**Caddy (automatic HTTPS):**
```
your-domain.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**SSH tunnel (quick remote access):**
```bash
ssh -L 3000:127.0.0.1:3000 user@remote-host
```

Both approaches encrypt the bearer token in transit without requiring DeepADB to manage certificates.

## Version Pinning

When installing DeepADB via npm, always pin the version:

```bash
# Pinned (recommended)
npm install -g deepadb@1.1.5

# Unpinned (not recommended — vulnerable to supply chain attacks)
npx -y deepadb
```

When configuring MCP clients, prefer a local clone over `npx`:

```json
{
  "mcpServers": {
    "deepadb": {
      "command": "node",
      "args": ["/path/to/DeepADB/build/index.js"]
    }
  }
}
```

This runs from a known-good local build rather than fetching the latest version from npm on every invocation.

## Supply Chain

DeepADB has **5 direct runtime dependencies**:

- `@modelcontextprotocol/server` — official MCP SDK v2 server core
- `@modelcontextprotocol/node` — official Node.js Streamable HTTP adapter
- `@modelcontextprotocol/server-legacy` — official compatibility bridge for existing SSE clients
- `@modelcontextprotocol/sdk` — v1 compatibility for existing plugin imports and Zod schema conversion
- `zod` — TypeScript schema validation (used by the MCP SDK)

The plugin adapter retains schema validation, including legacy Zod refinements
and transforms; it does not bypass the server's validation or sandbox plugins.
Existing plugin trust and command restrictions still apply. The frozen legacy
SSE package and v1 SDK must remain part of dependency auditing while retained.

Optional peer dependencies (`ws` for WebSocket, `graphql` for GraphQL API) are loaded dynamically only when explicitly enabled via environment variables. They are never fetched or executed unless you set `DA_WS_PORT` or `DA_GRAPHQL_PORT`.

## AT Command Safety

The AT command interface (`adb_at_send`, `adb_at_batch`) includes a blocklist of dangerous modem commands that can disable the radio, write IMEI, or factory-reset the modem:

- `AT+CFUN=0` (kill radio)
- `AT+CFUN=4` (disable TX)
- `AT+CLCK` (lock SIM)
- `AT+EGMR` (write IMEI — illegal in many jurisdictions)
- `AT^RESET`, `AT%RESTART` (modem reset)
- `AT+NVRAM`, `AT+QPRTPARA` (NVRAM/parameter write)

These are blocked by default. Use `force=true` to override, but understand the consequences.

## Reporting Vulnerabilities

If you discover a security vulnerability in DeepADB, please report it privately via GitHub's security advisory feature:

https://github.com/fullread/DeepADB/security/advisories/new

Do not open a public issue for security vulnerabilities. We will acknowledge receipt within 48 hours and work with you on a fix before public disclosure.
