# Local LLM clients

DeepADB works through an MCP-capable client that connects the model to tools.
WebSocket is **not required**. Choose the connection supported by your client:

| Client path | DeepADB connection | Authentication |
| --- | --- | --- |
| Local MCP host, including llama-server builds with `--mcp-servers-config` | stdio; launch `node build/index.js` | Local process permissions |
| Browser UI or native client with Streamable HTTP support | `http://127.0.0.1:8787/mcp` | Bearer header on every request; exact Origin allowlist for browsers |
| Older browser UI or native client using SSE | `http://127.0.0.1:8787/sse` | Same bearer and Origin policy |
| Native client requiring WebSocket | `ws://127.0.0.1:8788/ws` | Bearer header before upgrade; Origin allowlist if supplied |

The HTTP server serves Streamable HTTP and legacy SSE on the same port.
Existing stdio, SSE and WebSocket configurations remain supported. Model
tool-calling quality is separate from a successful MCP connection.

## Choose a tool profile

`DA_TOOL_PROFILE` is read once at startup and applies to every MCP transport.

| Profile | Catalog | Other interfaces |
| --- | --- | --- |
| `full` (default) | All 209 built-in tools plus installed plugins | Existing resources, prompts, workflows and optional GraphQL |
| `inspect` | `adb_devices`, `adb_device_info`, `adb_getprop` | No plugins, workflows, resources, prompts, result handles or GraphQL |

Start with `inspect` for basic local-model connection and device-property work.
It does not include the health check, which writes a temporary file on the
device, or generic shell execution. Excluded tools are not registered and
cannot be called directly by name. The registration and invocation guards also
reject unreviewed additions. Plugin files are not even imported in this mode;
configuring GraphQL alongside it fails startup. Unknown profile names fail
startup rather than enabling all tools.

Use `full` when your workflow needs the wider catalog or plugins. Profiles do
not limit which connected device can be inspected, redact properties, or
sandbox code on the host. Existing command filters apply only to middleware-checked
paths, not every dedicated tool; they do not make `full` read-only. `DA_RATE_LIMIT`
is not a global limit and does not cover the three inspect tools. See the
[security recipes](SECURITY.md#recommended-configurations) for shared deployments. Device
allowlists and compact output are separate future work.

## Direct stdio connection

Build DeepADB with `npm ci` and `npm run build`. Configure your MCP client to
launch the resulting `build/index.js` using Node.js.

Recent llama.cpp source supports `--mcp-servers-config` and `--mcp-servers-json`.
Check `llama-server --help` first: older builds may expose browser MCP support
without these native stdio flags. For example, the locally checked build 9878
does not expose them. A browser connection is still an option on such builds.

For a build with native stdio support, save this as `mcp.json`, adjusting the
absolute path for your installation:

```json
{
  "mcpServers": {
    "deepadb": {
      "command": "node",
      "args": ["D:/Projects/DeepADB/build/index.js"],
      "env": {
        "DA_HTTP_PORT": "",
        "DA_WS_PORT": "",
        "DA_GRAPHQL_PORT": "",
        "DA_TOOL_PROFILE": "inspect"
      }
    }
  }
}
```

```sh
llama-server -m /path/to/model.gguf --mcp-servers-config mcp.json
```

The empty port settings prevent inherited environment variables from selecting
a network transport. The client manages the child process; do not separately
start DeepADB for this configuration. Confirm that tools appear before asking
the model to use them. llama-server may prefix names with the server name.

Check the host's process lifecycle before using long-running watchers: native
llama-server can restart MCP processes between discovery and tool use. Do not
assume that in-memory state survives a process restart.

## Browser UI connection

Start DeepADB from PowerShell with a token and the exact origin shown in your
browser's address bar. This example assumes the UI is at `http://localhost:8080`:

```powershell
$env:DA_HTTP_PORT = '8787'
$env:DA_HTTP_HOST = '127.0.0.1'
$env:DA_HTTP_CORS_ORIGIN = 'http://localhost:8080'
$env:DA_GRAPHQL_PORT = ''
$env:DA_TOOL_PROFILE = 'inspect'
$env:DA_AUTH_TOKEN = node -p "require('crypto').randomBytes(32).toString('hex')"
$env:DA_AUTH_TOKEN | Set-Clipboard # Paste into your local UI's bearer header
node build/index.js
```

In the UI's MCP server configuration, select **Streamable HTTP** (sometimes
named **HTTP**) and use `http://127.0.0.1:8787/mcp`. For clients that only support
legacy SSE, select **SSE** and use `http://127.0.0.1:8787/sse` instead. Add this
custom request header using the generated token value:

```text
Authorization: Bearer <your-generated-token>
```

**Browser reload recovery:** a page that loses its session ID can initialize
again after its GET notification stream disconnects and all session requests
finish. DeepADB reclaims that idle slot only for the same allowed Origin, after
validating authentication, initialization and headers. Active clients and work
still receive protection from competing connections; see the details below.

Use a direct connection and the default/omit credential mode; cookie credentials
are not needed for bearer authentication. DeepADB permits the
`MCP-Protocol-Version` header on browser preflights. `/mcp` also allows and
exposes `Mcp-Session-Id`, which the MCP client manages automatically. Do not add
protocol or session headers manually to SDK client configuration. Native browser
WebSockets cannot supply an arbitrary Authorization header, so authenticated
HTTP is the browser path. Do not disable authentication to make WebSocket work.

`localhost` and `127.0.0.1` are different Origins, as are different schemes or
ports. If both UI origins are intentional, configure a comma-separated list.
Entries must be exact serialized HTTP(S) origins: no trailing slash, path,
wildcard, credentials, or `null`. Unlisted Origins receive HTTP 403 before
session handling. Clients that omit Origin can still connect with a valid token.

## Sessions and compatibility

Only one MCP client is active per DeepADB process. `/mcp` and legacy SSE share
that slot; competing connections receive HTTP 409. A new authorized SSE
connection can still replace an existing SSE connection, preserving the older
behavior. A second simultaneous WebSocket client also receives HTTP 409.

Legacy SSE clients must post messages to the endpoint advertised by their
current `/sse` connection, including its `sessionId` query parameter. Missing or
duplicate IDs return 400; stale IDs return 404 while another SSE session is
active (503 if none is active). Reconnect before sending more messages after
replacement. A message still uploading when replacement occurs is rejected
with 400 before it can call a tool.

Streamable HTTP initialization returns a random session ID. The client sends
it on subsequent requests and can end the session with authenticated DELETE.
Closing a browser stream alone does not end the session or cancel work. A valid
new initialization from the same non-empty Origin can reclaim it after a
successful GET notification stream was closed by the client, provided no MCP
requests, uploads or HTTP response streams remain. The old ID then returns 404.
A client that retains its ID can still resume normally before replacement.
Requests from another Origin (even another allowed Origin), connected streams,
originless native sessions, and POST-only sessions without an observed GET
disconnect cannot use this recovery path. A normal server-initiated GET close
does not enable replacement. This is reconnect recovery, not multiple-client
support or an identity boundary between tabs on the same Origin.

The default idle
timeout is 30 minutes; configure `DA_HTTP_SESSION_TTL_MS` from 1000 to 3600000
milliseconds if needed. Authenticated requests with a valid session ID refresh
the countdown. While MCP requests or bounded uploads are active, including long-running tools,
idle expiry is suspended; the countdown restarts after the final response or
cancellation. Merely keeping a GET notification stream open does not refresh
it. DELETE can still terminate an active session. Expired or deleted IDs
receive 404 and require a new initialization. POST bodies are limited to 1 MiB
with a 15-second upload deadline. Event replay is not enabled.

Use distinct request IDs for concurrent calls. Duplicate in-flight IDs or
repeated IDs within a POST batch return HTTP 400 / JSON-RPC `-32600` before any
part of that body executes. SDK-rejected uploads do not leave reservations
behind. Malformed cancellation cannot release an active request's bookkeeping.

Device managers, plugin registration and tool state are created once per
process. Reconnection does not reload plugins or isolate device state between
clients; this remains a single-operator server. Session expiry closes transport
streams, not device operations or background watchers. Request cancellation
does not undo device actions; handlers must cooperate with its abort signal.
Retained plugin callback contexts stop sending notifications or requests once
that signal is aborted, including their adapted v2 helpers. They cannot use a
replacement client's connection after cancellation or disconnect.
The idle timer is not a maximum tool execution time. Use a separate process
for each simultaneously connected client. The existing 2024/2025 negotiation
is retained; the 2026-07-28 request lifecycle is not enabled.

## Troubleshooting

- **HTTP 400 with `Duplicate in-flight request ID`:** fix the client's ID
  allocation, including batches. Rejected batches execute no requests; do not
  cancel the original call simply to reuse its ID.
- **HTTP 403:** compare the page's Origin to `DA_HTTP_CORS_ORIGIN`. For a
  preflight failure, check that the client requests only supported headers:
  Content-Type, Authorization, MCP-Protocol-Version, Last-Event-ID, and (on
  `/mcp`) Mcp-Session-Id.
- **HTTP 401:** provide the bearer token on every request, including GET and
  DELETE. A session ID or URL does not replace authentication.
- **HTTP 409:** another client, upload or tool call may still be active. After
  a browser reload, allow that work and the old GET stream to finish closing,
  then retry the connection with the same Origin. Eligible idle browser
  sessions are reclaimed without a process restart or waiting for the TTL.
  Otherwise terminate the old session with DELETE, wait for idle expiry, or
  use a separate DeepADB process. POST-only/native sessions retain that explicit
  lifecycle. Switching to `/sse` on the same process requires the old HTTP
  session to end first. Do not disable authentication to work around a conflict.
- **`/mcp` returns 404:** an expired session needs reinitialization. If the
  endpoint itself is missing, rebuild/restart DeepADB or use legacy `/sse`.
- **WebSocket never initializes:** check the upgrade response: 401 is an auth
  failure, 403 an Origin failure, and 409 an already-connected client. Wait for
  the old connection's close event before reconnecting; the SDK v1 close()
  promise only initiates the handshake.
- **The model struggles with the catalog:** start the server with
  `DA_TOOL_PROFILE=inspect`. Client-side tool toggles can further adjust what
  the model sees, but do not replace the server's profile restrictions.

See [SECURITY.md](SECURITY.md) for the existing command restrictions and network
deployment guidance. Connection tests do not establish that every model can
select appropriate tools or supply valid arguments.

## Reliability and security limits

HTTP also accepts IPv6 loopback: set `DA_HTTP_HOST=::1` and use
`http://[::1]:PORT/mcp` (or `/sse`). The browser's Origin is still its own
page URL and must appear exactly in the configured allowlist.

Full-profile SQLite inspection uses private snapshots and bounded query
subprocesses. Large/expensive queries may return a limit error; split them into
smaller queries instead of weakening the limits. Host inspection requires
Node 22.16+. GraphQL remains a separate optional full-profile API; it now
rejects invalid Origins and limits query complexity and device work. Neither
SQLite nor GraphQL is enabled by the three-tool `inspect` profile.

Use a supported LTS Node runtime on both the host and phone. A passing host/ADB
run does not deploy the build or validate the installed on-device LocalBridge.
The initial final-audit verification used the host build. Release preparation
then tested the staged production package directly on the Pixel with Termux
Node 24.22.1 and SQLite 3.54.1: all eight real-browser checks passed against
the on-device HTTP server, including CORS/authentication, SSE and Streamable
HTTP, profile restrictions and repeated reload recovery. These are browser
protocol tests; the model-selected llama.cpp trials are described separately
below. Legacy-client/plugin and IPv6 transport regressions also passed. The
verified 1.1.5 package was subsequently promoted to the normal device path;
auto-detection and strict device smoke checks passed again. No network listener
is enabled persistently by the installation; configure the transport, token and
Origin allowlist for the client you intend to use.

## Validated client matrix

October 31, 2026: Windows host, Chrome, rooted Pixel 6a / Android 16, portable
llama.cpp **b11960** (`8642541b2`, 0.8.0-dev), and the cached **Qwen3.5-4B
Q4_K_M** model with reasoning disabled and an 8192-token context. Model tests
used `DA_TOOL_PROFILE=inspect`; the full 209-tool catalog was covered by the
hardware/compatibility suites, not this model trial.

| Path | Observed result |
| --- | --- |
| Native stdio (`--mcp-servers-config`) | Discovered three tools; the model called `adb_devices`, then `adb_getprop`, and answered with the live model string `Pixel 6a`. |
| Browser `/mcp` | Discovered three tools and negotiated protocol 2025-06-18. After the reconnect fix, the model read `Pixel 6a`, the page was fully reloaded, and a fresh model-selected property call returned Android `16` through the same DeepADB process. The server log confirmed guarded session reclamation; no TTL wait, DELETE, proxy or process restart was needed. |
| Browser `/sse` | Discovered three tools and negotiated protocol 2025-06-18; a model-selected property call returned Android `16`. Reconnected successfully after a full page reload. |

Browser trials used a bearer token, an exact Origin allowlist, and the UI's
normal per-call approvals. The llama.cpp CORS proxy, unrelated browser tools,
and native server tools were disabled for the HTTP/SSE chats so those calls
could only use the selected browser MCP connection. WebSocket was not used.
The separate device-free Chromium regression also passes three consecutive
reloads, verifies retired IDs return 404, and checks that the inspect catalog
and direct-call restrictions survive each new session.
The previously installed **b9878** executable was left unchanged; it has no
`--mcp-servers-config` flag, so native stdio needs a newer build. These trials
establish a working model/tool loop, not model quality across all diagnostics.

Compatibility references checked October 31, 2026:
[llama-server MCP configuration](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#mcp-servers),
[llama.cpp UI transport implementation](https://github.com/ggml-org/llama.cpp/blob/master/tools/ui/src/lib/services/mcp.service.ts).
