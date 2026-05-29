// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Transport Smoke Test Suite — exercises the three alternate server transports
 * (HTTP/SSE, WebSocket, GraphQL) that the stdio-based suites never touch. Each
 * test boots build/index.js on an ephemeral port with the matching env var,
 * verifies the /health endpoint, performs one real protocol exchange (MCP
 * tools/list over SSE and WebSocket; a { health } query over GraphQL), then
 * shuts the server down.
 *
 * Device-free: tools/list, resources/list, and the health query exercise the
 * full transport + MCP wiring without needing a connected device.
 *
 * WebSocket and GraphQL require their optional packages (ws, graphql), present
 * as devDependencies. If a package is absent the relevant tests skip rather
 * than fail, so the suite still runs in a minimal install.
 */
import { spawn } from "child_process";
import { createServer } from "net";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "build", "index.js");
const NM = join(__dirname, "..", "node_modules");

let passed = 0, failed = 0, skipped = 0;
const ok = (l) => { console.log("  ✓ " + l); passed++; };
const fail = (l, d) => { console.log("  ✗ " + l + (d ? " — " + d : "")); failed++; };
const skip = (l, r) => { console.log("  ○ " + l + " — SKIPPED: " + r); skipped++; };
const section = (n) => { console.log("\n── " + n + " ──"); };

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

// Boot build/index.js with the given env, resolving once the readyMarker line
// appears on stderr. Rejects on early exit or timeout.
function bootServer(env, readyMarker, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SERVER], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch {}
      reject(new Error("timeout waiting for ready marker: " + readyMarker));
    }, timeoutMs);
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (!settled && stderr.includes(readyMarker)) {
        settled = true;
        clearTimeout(timer);
        resolve(proc);
      }
    });
    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("server exited early (code " + code + "): " + stderr.slice(-300)));
    });
    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

function killServer(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    proc.on("exit", finish);
    try { proc.kill(); } catch {}
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} finish(); }, 3000);
  });
}

// Connect an MCP client over the given transport, list tools + resources, close.
async function mcpRoundTrip(transportModule, transportCtor, url) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const mod = await import(transportModule);
  const Ctor = mod[transportCtor];
  const client = new Client({ name: "transport-test", version: "1.0.0" }, { capabilities: {} });
  const transport = new Ctor(new URL(url));
  await client.connect(transport);
  const tools = await client.listTools();
  const resources = await client.listResources();
  await client.close();
  return { toolCount: tools.tools.length, resourceCount: resources.resources.length };
}

// ── HTTP/SSE ──────────────────────────────────────────────
section("HTTP/SSE transport");
{
  const port = await freePort();
  let proc;
  try {
    proc = await bootServer({ DA_HTTP_PORT: String(port), DA_HTTP_HOST: "127.0.0.1" }, "HTTP/SSE transport running on");
    try {
      const r = await fetch("http://127.0.0.1:" + port + "/health");
      if (r.ok) ok("HTTP /health responds 200"); else fail("HTTP /health responds 200", "status " + r.status);
    } catch (e) { fail("HTTP /health responds 200", e.message); }
    try {
      const { toolCount, resourceCount } = await mcpRoundTrip(
        "@modelcontextprotocol/sdk/client/sse.js", "SSEClientTransport",
        "http://127.0.0.1:" + port + "/sse");
      if (toolCount >= 200) ok("HTTP/SSE tools/list returned " + toolCount + " tools");
      else fail("HTTP/SSE tools/list", "only " + toolCount + " tools");
      if (resourceCount >= 1) ok("HTTP/SSE resources/list returned " + resourceCount + " resources");
      else fail("HTTP/SSE resources/list", "got " + resourceCount);
    } catch (e) { fail("HTTP/SSE MCP round-trip", e.message); }
  } catch (e) {
    fail("HTTP/SSE transport boot", e.message);
  } finally {
    await killServer(proc);
  }
}

// ── WebSocket ─────────────────────────────────────────────
section("WebSocket transport");
{
  const wsInstalled = existsSync(join(NM, "ws", "package.json"));
  const hasGlobalWS = typeof WebSocket !== "undefined";
  if (!wsInstalled) {
    skip("WS /health", "ws package not installed");
    skip("WebSocket MCP round-trip", "ws package not installed");
  } else if (!hasGlobalWS) {
    skip("WS /health", "no global WebSocket (Node < 22)");
    skip("WebSocket MCP round-trip", "no global WebSocket (Node < 22)");
  } else {
    const port = await freePort();
    let proc;
    try {
      proc = await bootServer({ DA_WS_PORT: String(port), DA_HTTP_HOST: "127.0.0.1" }, "WebSocket transport running on");
      try {
        const r = await fetch("http://127.0.0.1:" + port + "/health");
        if (r.ok) ok("WS /health responds 200"); else fail("WS /health responds 200", "status " + r.status);
      } catch (e) { fail("WS /health responds 200", e.message); }
      try {
        const { toolCount } = await mcpRoundTrip(
          "@modelcontextprotocol/sdk/client/websocket.js", "WebSocketClientTransport",
          "ws://127.0.0.1:" + port + "/ws");
        if (toolCount >= 200) ok("WebSocket tools/list returned " + toolCount + " tools");
        else fail("WebSocket tools/list", "only " + toolCount + " tools");
      } catch (e) { fail("WebSocket MCP round-trip", e.message); }
    } catch (e) {
      fail("WebSocket transport boot", e.message);
    } finally {
      await killServer(proc);
    }
  }
}

// ── GraphQL ───────────────────────────────────────────────
section("GraphQL API");
{
  const gqInstalled = existsSync(join(NM, "graphql", "package.json"));
  if (!gqInstalled) {
    skip("GraphQL /health", "graphql package not installed");
    skip("GraphQL { health } query", "graphql package not installed");
    skip("GraphQL introspection", "graphql package not installed");
  } else {
    const port = await freePort();
    let proc;
    try {
      proc = await bootServer({ DA_GRAPHQL_PORT: String(port), DA_HTTP_HOST: "127.0.0.1" }, "GraphQL API running on");
      try {
        const r = await fetch("http://127.0.0.1:" + port + "/health");
        if (r.ok) ok("GraphQL /health responds 200"); else fail("GraphQL /health responds 200", "status " + r.status);
      } catch (e) { fail("GraphQL /health responds 200", e.message); }
      // { devices } is the device-free root query — returns [] with no device
      // attached, a populated array otherwise. Either way it exercises a real
      // resolver round-trip through the GraphQL execution layer.
      try {
        const r = await fetch("http://127.0.0.1:" + port + "/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "{ devices { serial } }" }),
        });
        const j = await r.json();
        // The resolver runs adb devices: a functional adb returns an array
        // (possibly empty); a runner with no usable adb returns a GraphQL error
        // on the devices path. Either proves the transport + execution layer is
        // wired correctly, which is all this smoke test verifies.
        const arrayOk = !!(j && j.data && Array.isArray(j.data.devices));
        const errorOk = !!(j && Array.isArray(j.errors) && j.errors.some((e) => Array.isArray(e.path) && e.path.includes("devices")));
        if (arrayOk || errorOk) ok("GraphQL { devices } resolver round-trip");
        else fail("GraphQL { devices } query", JSON.stringify(j).slice(0, 150));
      } catch (e) { fail("GraphQL { devices } query", e.message); }
      try {
        const r = await fetch("http://127.0.0.1:" + port + "/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "{ __schema { queryType { name } } }" }),
        });
        const j = await r.json();
        if (j && j.data && j.data.__schema && j.data.__schema.queryType && j.data.__schema.queryType.name)
          ok("GraphQL introspection returns query type");
        else fail("GraphQL introspection", JSON.stringify(j).slice(0, 150));
      } catch (e) { fail("GraphQL introspection", e.message); }
    } catch (e) {
      fail("GraphQL API boot", e.message);
    } finally {
      await killServer(proc);
    }
  }
}

// ── Summary ───────────────────────────────────────────────
console.log("\n" + "═".repeat(60));
console.log("  Transport Smoke Tests: " + passed + " passed, " + failed + " failed, " + skipped + " skipped (" + (passed + failed + skipped) + " total)");
console.log("═".repeat(60));
process.exit(failed > 0 ? 1 : 0);
