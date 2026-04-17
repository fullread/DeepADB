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
- **AT commands** are validated against a separate character set that rejects shell operators while allowing legitimate AT syntax (`+`, `=`, `?`, etc.). AT command strings are fed to `printf` via `%s` format, never the format position itself, preventing format string injection from commands containing `%` characters (e.g., `AT%RESTART`).
- **`sed` escaping in `adb_file_replace`** (`files.ts`) applies `'\''` closing/reopening to both the pattern and the replacement value, handling single quotes that would otherwise close the outer shell single-quote. Zod also rejects newlines in `find`/`replace` since sed treats embedded newlines as script-command separators.
- **Device node paths** must start with `/dev/` and cannot contain path traversal (`..`).

### Zod Parameter Bounds (always active)

Every `z.number()` parameter across all 198 tools has explicit `.min()/.max()` constraints. This prevents resource exhaustion from extreme values — for example, requesting a 999999-second sleep or a buffer size of 2^31.

### Security Middleware (opt-in enforcement)

Set `DA_SECURITY=true` to enable command filtering and rate limiting:

- **Blocklist**: `DA_BLOCKED_COMMANDS` — comma-separated substrings. Any shell command containing a blocked substring is rejected.
- **Allowlist**: `DA_ALLOWED_COMMANDS` — if set, only commands matching at least one pattern are permitted.
- **Rate limiting**: `DA_RATE_LIMIT` — maximum commands per minute (0 = unlimited).
- **Audit logging**: `DA_AUDIT_LOG` — enabled by default since v1.0.3. Logs all commands to stderr with automatic credential redaction. Set `DA_AUDIT_LOG=false` to disable.

### Privilege Escalation (on-device mode)

When running in Termux, the LocalBridge uses a **frozen 16-command allowlist** to determine which commands get routed through `su`. This allowlist is a `ReadonlySet` wrapped in `Object.freeze()` — it cannot be modified via environment variables, runtime API, or configuration files.

### Process Lifecycle

All modules that spawn child processes (logcat watchers, RIL interceptors, screen mirroring, QEMU VMs, emulators) register with a centralized cleanup registry. SIGINT, SIGTERM, and process exit trigger cleanup of all registered child processes, preventing orphans.

### Network Transport Security

- **stdio** (default): No network exposure. Communication over local pipes only.
- **HTTP/SSE**: Binds to `127.0.0.1`. CORS denied by default — set `DA_HTTP_CORS_ORIGIN` to explicitly allow a specific origin.
- **WebSocket**: Same binding and CORS defaults as HTTP/SSE.
- **GraphQL**: Same binding and CORS defaults. POST body limited to 1 MB.

### Bearer Token Authentication

When `DA_AUTH_TOKEN` is set, all network transport requests (HTTP/SSE, WebSocket, GraphQL) must include a valid `Authorization: Bearer <token>` header. Requests without a valid token receive a 401 Unauthorized response. WebSocket connections are closed immediately with code 4401. Token comparison uses constant-time `crypto.timingSafeEqual()` to prevent timing-based side-channel attacks.

Health check endpoints (`GET /health`) are exempt from authentication — they only return transport status and version info, no device data.

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
npm start   # stdio mode, audit logging on, security enforcement off
```

Appropriate when you are the only operator, running locally via Claude Code or similar. Audit logging provides a trail without restricting functionality.

### Shared or demo environments

```bash
DA_SECURITY=true \
DA_AUTH_TOKEN="$(openssl rand -hex 32)" \
DA_BLOCKED_COMMANDS="rm -rf,mkfs,dd if=,reboot" \
DA_RATE_LIMIT=30 \
DA_HTTP_PORT=3000 \
npm start
```

Enables command filtering, rate limiting, and bearer token authentication. Blocks destructive commands while allowing normal inspection tools. Share the token with authorized clients only.

### Network-exposed deployments

```bash
DA_SECURITY=true \
DA_AUTH_TOKEN="your-secret-token" \
DA_HTTP_PORT=3000 \
DA_HTTP_CORS_ORIGIN="https://your-app.example.com" \
DA_BLOCKED_COMMANDS="rm -rf,mkfs,dd if=,reboot,su " \
DA_RATE_LIMIT=20 \
DA_ALLOWED_COMMANDS="dumpsys,getprop,pm list,screencap,uiautomator" \
npm start
```

Locks down to read-only inspection tools via allowlist. Restricts CORS to a specific origin. Rate-limited. Bearer token required for all requests. For HTTPS, place a reverse proxy in front of DeepADB (see below).

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
npm install -g deepadb@1.1.1

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

DeepADB has **2 runtime dependencies**:

- `@modelcontextprotocol/sdk` — Anthropic's official MCP SDK
- `zod` — TypeScript schema validation (used by the MCP SDK)

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
