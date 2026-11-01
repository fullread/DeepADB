// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Real Chromium CORS checks. No browser security flags or device access. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { isolatedEnvironment, cleanupEnvironments, freePort, bootServer, stopServer } from "../lib/isolated-server.mjs";

const browserPath = process.env.DA_TEST_BROWSER ?? [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(existsSync);
if (!browserPath || !existsSync(browserPath)) throw new Error("Set DA_TEST_BROWSER to a Chrome/Edge/Chromium executable to run the browser test");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(get, description) {
  for (let i = 0; i < 200; i++) { const result = await get(); if (result) return result; await delay(100); }
  throw new Error(`Timed out waiting for ${description}`);
}
async function pageServer() {
  const server = createServer((_, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>DeepADB CORS test</title>"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
async function connectCdp(url) {
  const socket = new WebSocket(url), pending = new Map(); let id = 0;
  socket.on("message", data => {
    const result = JSON.parse(String(data)), entry = pending.get(result.id);
    if (!entry) return;
    pending.delete(result.id); clearTimeout(entry.timer);
    if (result.error) entry.reject(new Error(result.error.message)); else entry.resolve(result.result);
  });
  socket.on("close", () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Browser closed")); }
    pending.clear();
  });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return {
    socket,
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP ${method} timed out`)); }, 15000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method, params, sessionId }));
      });
    },
  };
}
async function browserRoundTrip(base, token) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const headers = { Authorization: `Bearer ${token}`, "MCP-Protocol-Version": "2025-11-25" };
    const stream = await fetch(base + "/sse", { headers, signal: controller.signal });
    const reader = stream.body.getReader(), decoder = new TextDecoder(); let buffered = "";
    async function event(type) {
      while (true) {
        let end;
        while ((end = buffered.indexOf("\n\n")) >= 0) {
          const block = buffered.slice(0, end); buffered = buffered.slice(end + 2);
          if (block.includes(`event: ${type}\n`)) return block.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
        }
        const next = await reader.read();
        if (next.done) throw new Error("SSE stream ended before the response");
        buffered += decoder.decode(next.value, { stream: true });
      }
    }
    const endpoint = await event("endpoint");
    const post = await fetch(new URL(endpoint, base), {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "real-browser-test", version: "1" },
      } }),
    });
    const initialized = JSON.parse(await event("message"));
    return { streamStatus: stream.status, postStatus: post.status, server: initialized.result?.serverInfo?.name };
  } finally { clearTimeout(timer); controller.abort(); }
}

async function browserHttp(base, token, keepSession = false) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25" };
  async function rpc(message) {
    const response = await fetch(base + "/mcp", { method: "POST", headers, body: JSON.stringify(message), signal: AbortSignal.timeout(10000) });
    if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    const text = await response.text();
    const data = response.headers.get("content-type")?.includes("text/event-stream")
      ? JSON.parse(text.split("\n").find(line => line.startsWith("data: ")).slice(6)) : JSON.parse(text);
    return { response, data };
  }
  const initialized = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "real-browser-http", version: "1" },
  } });
  const session = initialized.response.headers.get("mcp-session-id");
  if (!session) throw new Error("Browser cannot read the exposed Mcp-Session-Id");
  headers["Mcp-Session-Id"] = session;
  try {
    const notified = await fetch(base + "/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    const tools = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const denied = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "adb_shell", arguments: { command: "echo SHOULD_NOT_RUN" } } });
    if (keepSession) {
      const stream = await fetch(base + "/mcp", { headers });
      if (stream.status !== 200) throw new Error(`Notification stream HTTP ${stream.status}`);
      window.deepadbReader = stream.body.getReader();
      window.deepadbReader.read().catch(() => {});
      return { session, tools: tools.data.result.tools.map(t => t.name).sort(), denied: Boolean(denied.data.error || denied.data.result?.isError) };
    }
    const removed = await fetch(base + "/mcp", { method: "DELETE", headers });
    const stale = await fetch(base + "/mcp", { headers });
    return { sessionExposed: true, notified: notified.status, tools: tools.data.result.tools.map(t => t.name).sort(),
      denied: Boolean(denied.data.error || denied.data.result?.isError), deleted: removed.status, stale: stale.status };
  } finally { if (!keepSession) await fetch(base + "/mcp", { method: "DELETE", headers }); }
}

const allowedPage = await pageServer(), deniedPage = await pageServer();
const { root, env } = isolatedEnvironment(), port = await freePort();
const base = `http://127.0.0.1:${port}`, token = "real-browser-test-0123456789abcdef";
let server, browser, cdp, passed = 0;
try {
  server = await bootServer({ ...env, DA_HTTP_PORT: String(port), DA_HTTP_CORS_ORIGIN: allowedPage.origin, DA_AUTH_TOKEN: token, DA_TOOL_PROFILE: "inspect" }, "HTTP/SSE transport running on");
  const profile = join(root, "browser-profile");
  browser = spawn(browserPath, ["--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-background-mode", "--disable-extensions",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { windowsHide: true, stdio: "ignore" });
  let launchError;
  browser.once("error", error => { launchError = error; });
  const portFile = join(profile, "DevToolsActivePort");
  await until(() => { if (launchError) throw launchError; return existsSync(portFile); }, "browser startup");
  const [debugPort, socketPath] = readFileSync(portFile, "utf8").trim().split(/\r?\n/);
  cdp = await connectCdp(`ws://127.0.0.1:${debugPort}${socketPath}`);
  async function page(origin) {
    const { targetId } = await cdp.send("Target.createTarget", { url: origin });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await until(async () => (await evaluate(sessionId, "location.origin")) === origin, "page origin");
    return sessionId;
  }
  async function evaluate(sessionId, expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  const allowed = await page(allowedPage.origin), denied = await page(deniedPage.origin);
  assert.deepEqual(await evaluate(allowed, `(${browserRoundTrip})(${JSON.stringify(base)},${JSON.stringify(token)})`),
    { streamStatus: 200, postStatus: 202, server: "deepadb" });
  console.log("  ✓ real browser preflights and initializes authenticated SSE with MCP-Protocol-Version"); passed++;
  const fetchResult = (origin, headers) => `fetch(${JSON.stringify(origin + "/sse")}, {headers:${JSON.stringify(headers)},signal:AbortSignal.timeout(5000)}).then(r=>r.status).catch(e=>e.name)`;
  assert.equal(await evaluate(allowed, fetchResult(base, { "MCP-Protocol-Version": "2025-11-25" })), 401);
  console.log("  ✓ browser can read the 401 response without weakening authentication"); passed++;
  assert.equal(await evaluate(allowed, fetchResult(base, { Authorization: `Bearer ${token}`, "X-Unapproved": "no" })), "TypeError");
  console.log("  ✓ real browser rejects an unapproved preflight header"); passed++;
  assert.equal(await evaluate(denied, fetchResult(base, { Authorization: `Bearer ${token}` })), "TypeError");
  console.log("  ✓ real browser rejects a non-allowlisted page origin"); passed++;
  const http = await evaluate(allowed, `(${browserHttp})(${JSON.stringify(base)},${JSON.stringify(token)})`);
  assert.equal(http.sessionExposed, true); assert.equal(http.notified, 202);
  console.log("  ✓ real browser reads the session ID and preflights authenticated Streamable HTTP"); passed++;
  assert.deepEqual(http.tools, ["adb_device_info", "adb_devices", "adb_getprop"]); assert.equal(http.denied, true);
  console.log("  ✓ browser sees the inspect catalog and cannot directly invoke an excluded tool"); passed++;
  assert.equal(http.deleted, 200); assert.equal(http.stale, 404);
  console.log("  ✓ browser can terminate its session with an authenticated DELETE"); passed++;
  let previous;
  for (let reload = 0; reload < 3; reload++) {
    const connected = await evaluate(allowed, `(${browserHttp})(${JSON.stringify(base)},${JSON.stringify(token)},true)`);
    assert.deepEqual(connected.tools, ["adb_device_info", "adb_devices", "adb_getprop"]);
    assert.equal(connected.denied, true);
    if (previous) {
      assert.notEqual(connected.session, previous);
      assert.equal((await fetch(base + "/mcp", { headers: { Authorization: `Bearer ${token}`, Origin: allowedPage.origin,
        "Mcp-Session-Id": previous, Accept: "text/event-stream" } })).status, 404);
    }
    previous = connected.session;
    const timeOrigin = await evaluate(allowed, "performance.timeOrigin");
    await cdp.send("Page.reload", {}, allowed);
    await until(async () => {
      try { return await evaluate(allowed, `performance.timeOrigin !== ${timeOrigin} && document.readyState === 'complete' && typeof window.deepadbReader === 'undefined'`); }
      catch { return false; } // Navigation destroys the previous execution context.
    }, "page reload with lost session state");
  }
  assert.equal((await evaluate(allowed, `(${browserHttp})(${JSON.stringify(base)},${JSON.stringify(token)})`)).deleted, 200);
  console.log("  ✓ repeated real page reloads recover HTTP sessions without DELETE or retained IDs; inspect restrictions survive"); passed++;
  console.log(`\nBrowser CORS: ${passed} passed, 0 failed, 0 skipped (${passed} total)`);
} finally {
  if (cdp) { await cdp.send("Browser.close").catch(() => {}); cdp.socket.close(); }
  if (browser) { for (let i = 0; i < 30 && browser.exitCode === null; i++) await delay(100); await stopServer(browser); }
  if (server) await stopServer(server);
  await Promise.all([allowedPage.server, deniedPage.server].map(s => new Promise(resolve => s.close(resolve))));
  cleanupEnvironments();
}
