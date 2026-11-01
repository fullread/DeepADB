// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Origin, CORS and upgrade authorization regressions. No device access. */
import assert from "node:assert/strict";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { isolatedEnvironment, cleanupEnvironments, freePort, bootServer, stopServer } from "./lib/isolated-server.mjs";

let passed = 0, failed = 0;
async function check(label, test) {
  try { await test(); passed++; console.log(`  ✓ ${label}`); }
  catch (error) { failed++; console.error(`  ✗ ${label}: ${error.stack}`); }
}
const origin = "http://localhost:8080", other = "http://127.0.0.1:8080";
const token = "browser-access-regression-0123456789abcdef";
const headers = { Origin: origin, Authorization: `Bearer ${token}`, "MCP-Protocol-Version": "2025-11-25" };
const get = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) });

function rejectedUpgrade(url, headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("Upgrade response timed out")); }, 5000);
    socket.once("error", error => { clearTimeout(timer); reject(error); });
    socket.once("open", () => { clearTimeout(timer); socket.terminate(); reject(new Error("Rejected connection was upgraded")); });
    socket.once("unexpected-response", (request, response) => {
      clearTimeout(timer); response.resume(); request.destroy(); resolve(response.statusCode);
    });
  });
}
async function openSocket(url, headers) {
  const socket = new WebSocket(url, { headers });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return socket;
}
function rpc(socket, id, method, params) {
  return new Promise((resolve, reject) => {
    const receive = data => {
      const message = JSON.parse(String(data));
      if (message.id !== id) return;
      clearTimeout(timer); socket.off("message", receive); resolve(message);
    };
    const timer = setTimeout(() => { socket.off("message", receive); reject(new Error(`${method} timed out`)); }, 5000);
    socket.on("message", receive); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

const httpEnv = isolatedEnvironment().env;
const httpPort = await freePort(), base = `http://127.0.0.1:${httpPort}`;
const http = await bootServer({ ...httpEnv, DA_HTTP_PORT: String(httpPort), DA_AUTH_TOKEN: token,
  DA_HTTP_CORS_ORIGIN: `${origin}, ${other}` }, "HTTP/SSE transport running on");
const client = new Client({ name: "origin-tests", version: "1" });
try {
  await check("SSE preflight permits MCP protocol headers without a bearer token", async () => {
    const response = await get(base + "/message", { method: "OPTIONS", headers: {
      Origin: origin, "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,authorization,mcp-protocol-version,last-event-id",
    } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.match(response.headers.get("access-control-allow-headers"), /MCP-Protocol-Version/);
    assert.match(response.headers.get("vary"), /Origin/);
  });
  await check("CORS reflects only the matching allowlisted origin", async () => {
    const response = await get(base + "/health", { headers: { Origin: other } });
    assert.equal(response.status, 200); assert.equal(response.headers.get("access-control-allow-origin"), other);
  });
  await check("CORS rejects unknown headers and methods", async () => {
    for (const extra of [{ "Access-Control-Request-Headers": "x-unapproved" }, { "Access-Control-Request-Method": "DELETE" }]) {
      assert.equal((await get(base + "/sse", { method: "OPTIONS", headers: { Origin: origin, ...extra } })).status, 403);
    }
  });
  await check("SSE still authenticates allowed-origin requests", async () => {
    for (const Authorization of [undefined, "Bearer invalid"]) {
      const response = await get(base + "/sse", { headers: { Origin: origin, ...(Authorization ? { Authorization } : {}) } });
      assert.equal(response.status, 401); assert.equal(response.headers.get("access-control-allow-origin"), origin);
    }
  });
  await check("allowed browser-style SSE headers initialize and list tools", async () => {
    await client.connect(new SSEClientTransport(new URL(base + "/sse"), {
      requestInit: { headers }, eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...init?.headers, ...headers } }) },
    }));
    assert.equal((await client.listTools()).tools.length, 209);
  });
  await check("unlisted and null Origins are rejected without replacing the live session", async () => {
    for (const Origin of ["https://untrusted.example", "null", origin + ".untrusted.example"]) {
      for (const [path, method] of [["/sse", "GET"], ["/message", "POST"], ["/sse", "OPTIONS"]]) {
        const response = await get(base + path, { method, headers: { ...headers, Origin } });
        assert.equal(response.status, 403); assert.equal(response.headers.get("access-control-allow-origin"), null);
      }
    }
    assert.equal((await client.listTools()).tools.length, 209);
  });
} finally { await client.close(); await stopServer(http); }

const defaultPort = await freePort(), defaultEnv = isolatedEnvironment().env;
const defaults = await bootServer({ ...defaultEnv, DA_HTTP_PORT: String(defaultPort) }, "HTTP/SSE transport running on");
try {
  await check("default HTTP policy allows native clients and denies browser Origins", async () => {
    const base = `http://127.0.0.1:${defaultPort}`;
    assert.equal((await get(base + "/health")).status, 200);
    assert.equal((await get(base + "/sse", { headers: { Origin: origin } })).status, 403);
  });
} finally { await stopServer(defaults); }

const wsPort = await freePort(), wsEnv = isolatedEnvironment().env, wsUrl = `ws://127.0.0.1:${wsPort}/ws`;
const wsServer = await bootServer({ ...wsEnv, DA_WS_PORT: String(wsPort), DA_AUTH_TOKEN: token,
  DA_WS_CORS_ORIGIN: `${origin}, ${other}` }, "WebSocket transport running on");
let socket;
try {
  await check("WebSocket rejects invalid Origins before upgrading", async () => {
    for (const Origin of ["https://untrusted.example", "null"]) assert.equal(await rejectedUpgrade(wsUrl, { ...headers, Origin }), 403);
  });
  await check("WebSocket rejects missing and invalid tokens before upgrading", async () => {
    for (const auth of [{ Origin: origin }, { Origin: origin, Authorization: "Bearer wrong" }]) assert.equal(await rejectedUpgrade(wsUrl, auth), 401);
  });
  await check("WebSocket rejects upgrades on unknown paths", async () => {
    assert.equal(await rejectedUpgrade(wsUrl + "-other", headers), 404);
  });
  await check("allowlisted WebSocket initializes with authentication", async () => {
    socket = await openSocket(wsUrl, headers);
    const response = await rpc(socket, 1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "browser-access", version: "1" } });
    assert.equal(response.result.serverInfo.name, "deepadb");
    socket.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  });
  await check("a second WebSocket receives 409 without disrupting the first client", async () => {
    assert.equal(await rejectedUpgrade(wsUrl, headers), 409);
    assert.equal((await rpc(socket, 2, "tools/list")).result.tools.length, 209);
  });
} finally { socket?.terminate(); await stopServer(wsServer); }

for (const [variable, portVariable, marker] of [
  ["DA_HTTP_CORS_ORIGIN", "DA_HTTP_PORT", "HTTP/SSE transport running on"],
  ["DA_WS_CORS_ORIGIN", "DA_WS_PORT", "WebSocket transport running on"],
]) await check(`${variable} fails closed on wildcard configuration`, async () => {
  const { env } = isolatedEnvironment();
  await assert.rejects(bootServer({ ...env, [variable]: "*", [portVariable]: String(await freePort()) }, marker), /exact http\(s\) origins/);
});

cleanupEnvironments();
console.log(`\nBrowser Access: ${passed} passed, ${failed} failed, 0 skipped (${passed + failed} total)`);
process.exitCode = failed ? 1 : 0;
