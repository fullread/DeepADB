// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Streamable HTTP and server-enforced profiles; device and plugin isolation. */
import assert from "node:assert/strict";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as V1Http } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { withToolProfile } from "../build/tool-profile.js";
import { isolatedEnvironment, cleanupEnvironments, serverPath, freePort, bootServer, stopServer } from "./lib/isolated-server.mjs";

let passed = 0, failed = 0;
async function check(name, action) {
  try { await action(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${error.stack}`); }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const token = "local-llm-test-0123456789abcdef", origin = "http://localhost:8080";
const headers = { Authorization: `Bearer ${token}`, Origin: origin, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25" };
const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw-http", version: "1" },
} });
const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
async function initialize(url, h = headers) {
  const response = await request(url, { method: "POST", headers: h, body: init });
  assert.equal(response.status, 200, await response.text());
  const id = response.headers.get("mcp-session-id"); assert.ok(id);
  return { ...h, "Mcp-Session-Id": id };
}
async function notificationStream(url, h) {
  const abort = new AbortController();
  const response = await fetch(url, { headers: h, signal: abort.signal });
  assert.equal(response.status, 200);
  return async () => { abort.abort(); await response.body.cancel().catch(() => {}); await delay(80); };
}
async function rpc(url, h, method, params) {
  const response = await request(url, { method: "POST", headers: h,
    body: JSON.stringify({ jsonrpc: "2.0", id: 42, method, params }) });
  assert.equal(response.status, 200);
  return JSON.parse((await response.text()).split("\n").find(line => line.startsWith("data: ")).slice(6));
}
const expected = ["adb_device_info", "adb_devices", "adb_getprop"];
const names = async client => (await client.listTools()).tools.map(t => t.name).sort();
async function denied(client, name, args = {}) {
  try { const result = await client.callTool({ name, arguments: args }); assert.equal(result.isError, true); }
  catch (error) { assert.match(error.message, /not found|unknown|excluded|not registered/i); }
}
function fixture() {
  const setup = isolatedEnvironment();
  const marker = join(setup.root, "plugin-loaded.txt");
  writeFileSync(join(setup.env.DA_PLUGIN_DIR, "counter.js"), `
    import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(marker)}, 'loaded\\n');
    export async function register(ctx) {
      let count = 0;
      ctx.server.tool('profile_plugin', 'legacy stateful plugin', async extra => ({
        content: [{type:'text',text:JSON.stringify({count:++count,signal:extra.signal instanceof AbortSignal,origin:extra.requestInfo?.headers?.origin})}]
      }));
    }
  `);
  return { ...setup, marker };
}
const { env, marker } = fixture(), port = await freePort(), base = `http://127.0.0.1:${port}`;
const otherOrigin = "http://localhost:8081";
const child = await bootServer({ ...env, DA_HTTP_PORT: String(port), DA_AUTH_TOKEN: token, DA_HTTP_CORS_ORIGIN: `${origin},${otherOrigin}` }, "HTTP/SSE transport running on");
try {
  await check("Streamable HTTP preflights permit session/protocol headers and DELETE", async () => {
    const r = await request(base + "/mcp", { method: "OPTIONS", headers: { Origin: origin,
      "Access-Control-Request-Method": "DELETE", "Access-Control-Request-Headers": "authorization,mcp-session-id,mcp-protocol-version" } });
    assert.equal(r.status, 204); assert.equal(r.headers.get("access-control-allow-origin"), origin);
  });
  await check("/mcp checks token and Origin for every method before session handling", async () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      for (const Authorization of [undefined, "Bearer invalid"]) {
        const h = { ...headers }; delete h.Authorization; if (Authorization) h.Authorization = Authorization;
        assert.equal((await request(base + "/mcp", { method, headers: h, ...(method === "POST" ? { body: init } : {}) })).status, 401);
      }
      assert.equal((await request(base + "/mcp", { method, headers: { ...headers, Origin: "https://denied.example" }, ...(method === "POST" ? { body: init } : {}) })).status, 403);
    }
  });
  await check("invalid and oversized initialization requests release the session slot", async () => {
    for (const [body, status] of [["{", 400], ["x".repeat(1024 * 1024 + 1), 413], [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), 400], [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), 400]]) {
      assert.equal((await request(base + "/mcp", { method: "POST", headers, body })).status, status);
    }
    const notification = JSON.parse(init); delete notification.id;
    assert.equal((await request(base + "/mcp", { method: "POST", headers, body: JSON.stringify(notification) })).status, 400);
    for (const [overrides, status] of [[{ Accept: "application/json" }, 406], [{ "Content-Type": "text/plain" }, 415]]) {
      assert.equal((await request(base + "/mcp", { method: "POST", headers: { ...headers, ...overrides }, body: init })).status, status);
    }
    assert.equal((await request(base + "/mcp", { method: "PUT", headers })).status, 405);
    assert.equal((await request(base + "/mcp", { headers })).status, 400);
  });
  await check("chunked and incomplete uploads obey size/deadline limits without reserving a session", async () => {
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close();
    } });
    assert.equal((await request(base + "/mcp", { method: "POST", headers, body, duplex: "half" })).status, 413);
    const pending = new Promise((resolve, reject) => {
      const upload = httpRequest(base + "/mcp", { method: "POST", headers }, response => {
        response.resume(); clearTimeout(timer); resolve(response.statusCode);
      });
      const timer = setTimeout(() => { upload.destroy(); reject(new Error("Upload deadline not enforced")); }, 20000);
      upload.on("error", error => { clearTimeout(timer); reject(error); });
      upload.write("{"); // Deliberately never end this incomplete body.
    });
    const complete = await request(base + "/mcp", { method: "POST", headers, body: init });
    assert.equal(complete.status, 200); await complete.text();
    assert.equal((await request(base + "/mcp", { method: "DELETE", headers: { ...headers, "Mcp-Session-Id": complete.headers.get("mcp-session-id") } })).status, 200);
    assert.equal(await pending, 408);
  });

  let count = 0;
  for (const [label, C, T] of [["v1", V1Client, V1Http], ["v2", Client, StreamableHTTPClientTransport]]) {
    await check(`${label} HTTP client retains full catalog and legacy plugin state`, async () => {
      const client = new C({ name: `http-${label}`, version: "1" });
      const transport = new T(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: headers.Authorization, Origin: origin } } });
      try {
        await client.connect(transport);
        assert.equal((await names(client)).length, 210);
        const result = JSON.parse((await client.callTool({ name: "profile_plugin" })).content[0].text);
        assert.deepEqual(result, { count: ++count, signal: true, origin });
        assert.equal((await client.listResources()).resources.length, 1);
        assert.equal((await client.listPrompts()).prompts.length, 4);
        const h = { ...headers, "Mcp-Session-Id": transport.sessionId };
        assert.equal((await request(base + "/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 30, method: "tools/list" }) })).status, 400);
        assert.equal((await request(base + "/mcp", { method: "DELETE", headers: { ...h, Authorization: "Bearer invalid" } })).status, 401);
        assert.equal((await request(base + "/mcp", { headers: { ...h, Origin: "null" } })).status, 403);
        assert.equal((await request(base + "/mcp", { headers: { ...h, "Mcp-Session-Id": "wrong" } })).status, 404);
        assert.equal((await request(base + "/mcp", { method: "POST", headers: { ...h, "MCP-Protocol-Version": "invalid" }, body: JSON.stringify({ jsonrpc: "2.0", id: 30, method: "tools/list" }) })).status, 400);
        assert.equal((await client.listTools()).tools.length, 210);
        await transport.terminateSession();
        assert.equal((await request(base + "/mcp", { headers: h })).status, 404);
      } finally { await transport.terminateSession().catch(() => {}); await client.close(); }
    });
  }
  await check("concurrent initializers reserve only one session and expose its ID", async () => {
    const responses = await Promise.all([1, 2].map(() => request(base + "/mcp", { method: "POST", headers, body: init })));
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    const winner = responses.find(r => r.status === 200);
    await winner.text();
    const id = winner.headers.get("mcp-session-id"); assert.ok(id);
    assert.equal(winner.headers.get("access-control-expose-headers"), "Mcp-Session-Id");
    assert.equal((await request(base + "/sse", { headers })).status, 409);
    assert.equal((await request(base + "/mcp", { method: "DELETE", headers: { ...headers, "Mcp-Session-Id": id } })).status, 200);
  });
  await check("POST-only sessions and connected notification streams cannot be reclaimed", async () => {
    const url = base + "/mcp", h = await initialize(url);
    let disconnect;
    try {
      assert.equal((await request(url, { method: "POST", headers, body: init })).status, 409);
      assert.equal((await request(url, { headers: { ...h, Accept: "application/json" } })).status, 406);
      assert.equal((await request(url, { method: "POST", headers, body: init })).status, 409, "failed GET is not a lost browser stream");
      disconnect = await notificationStream(url, h);
      assert.equal((await request(url, { method: "POST", headers, body: init })).status, 409);
    } finally { await request(url, { method: "DELETE", headers: h }); await disconnect?.(); }
  });
  await check("browser handoff requires valid initialization, matching Origin and authentication", async () => {
    const url = base + "/mcp", h = await initialize(url);
    try {
      await (await notificationStream(url, h))();
      const noOrigin = { ...headers }; delete noOrigin.Origin;
      for (const [candidate, body, status] of [
        [{ ...headers, Authorization: "Bearer invalid" }, init, 401],
        [{ ...headers, Origin: "https://denied.example" }, init, 403],
        [{ ...headers, Origin: otherOrigin }, init, 409], [noOrigin, init, 409],
        [headers, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), 400],
        [{ ...headers, Accept: "application/json" }, init, 406],
        [{ ...headers, "Content-Type": "text/plain" }, init, 415],
      ]) assert.equal((await request(url, { method: "POST", headers: candidate, body })).status, status);
      assert.ok((await rpc(url, h, "tools/list")).result, "invalid replacement must leave the old session usable");
    } finally { await request(url, { method: "DELETE", headers: h }); }
  });
  await check("lost browser stream can resume with its original ID and keeps the slot", async () => {
    const url = base + "/mcp", h = await initialize(url);
    let disconnect;
    try {
      await (await notificationStream(url, h))();
      disconnect = await notificationStream(url, h);
      assert.ok((await rpc(url, h, "tools/list")).result);
      assert.equal((await request(url, { method: "POST", headers, body: init })).status, 409);
    } finally { await request(url, { method: "DELETE", headers: h }); await disconnect?.(); }
  });
  await check("originless native sessions cannot be reclaimed after their stream disconnects", async () => {
    const url = base + "/mcp", native = { ...headers }; delete native.Origin;
    const h = await initialize(url, native);
    try {
      await (await notificationStream(url, h))();
      for (const candidate of [headers, native])
        assert.equal((await request(url, { method: "POST", headers: candidate, body: init })).status, 409);
      assert.ok((await rpc(url, h, "tools/list")).result);
    } finally { await request(url, { method: "DELETE", headers: h }); }
  });
  await check("browser reloads atomically reclaim the slot, invalidate old IDs and retain plugin state", async () => {
    const url = base + "/mcp";
    let h = await initialize(url);
    try {
      for (let reload = 0; reload < 3; reload++) {
        const result = await rpc(url, h, "tools/call", { name: "profile_plugin" });
        assert.equal(JSON.parse(result.result.content[0].text).count, ++count);
        await (await notificationStream(url, h))();
        const oldId = h["Mcp-Session-Id"];
        const attempts = await Promise.all([1, 2].map(() => request(url, { method: "POST", headers, body: init })));
        assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
        const winner = attempts.find(r => r.status === 200); await winner.text();
        h = { ...headers, "Mcp-Session-Id": winner.headers.get("mcp-session-id") };
        assert.notEqual(h["Mcp-Session-Id"], oldId);
        assert.equal((await request(url, { headers: { ...headers, "Mcp-Session-Id": oldId } })).status, 404);
        assert.equal((await request(base + "/sse", { headers })).status, 409);
      }
    } finally { await request(url, { method: "DELETE", headers: h }); }
  });
  await check("legacy SSE remains usable and blocks competing /mcp initialization", async () => {
    const client = new V1Client({ name: "legacy", version: "1" });
    try {
      await client.connect(new SSEClientTransport(new URL(base + "/sse"), { requestInit: { headers },
        eventSourceInit: { fetch: (url, options) => fetch(url, { ...options, headers }) } }));
      assert.equal((await request(base + "/mcp", { method: "POST", headers, body: init })).status, 409);
      assert.equal((await client.listTools()).tools.length, 210);
      assert.equal(JSON.parse((await client.callTool({ name: "profile_plugin" })).content[0].text).count, ++count);
    } finally { await client.close(); }
    assert.equal(readFileSync(marker, "utf8"), "loaded\n");
  });
} finally { await stopServer(child); }

await check("idle session expires, closes streams and permits a fresh initialization", async () => {
  const { env } = isolatedEnvironment(), port = await freePort(), base = `http://127.0.0.1:${port}/mcp`;
  const server = await bootServer({ ...env, DA_HTTP_PORT: String(port), DA_HTTP_SESSION_TTL_MS: "1000" }, "HTTP/SSE transport running on");
  try {
    const h = { ...headers }; delete h.Origin;
    const first = await request(base, { method: "POST", headers: h, body: init });
    const id = first.headers.get("mcp-session-id"); assert.ok(id); await first.text();
    const stream = await request(base, { headers: { ...h, "Mcp-Session-Id": id } });
    assert.equal(stream.status, 200);
    await delay(1300);
    await stream.text();
    assert.equal((await request(base, { headers: { ...h, "Mcp-Session-Id": id } })).status, 404);
    const next = await request(base, { method: "POST", headers: h, body: init });
    assert.equal(next.status, 200); assert.notEqual(next.headers.get("mcp-session-id"), id); await next.text();
  } finally { await stopServer(server); }
});

async function withSlowSession(test) {
  const { env, root } = isolatedEnvironment(), port = await freePort();
  const marker = join(root, "requests.txt"), url = new URL(`http://127.0.0.1:${port}/mcp`);
  writeFileSync(join(env.DA_PLUGIN_DIR, "slow.js"), `
    import { appendFileSync } from 'node:fs';
    export function register(ctx) {
      ctx.server.tool('close_notification_stream', async () => {
        ctx.server.server.transport.closeStandaloneSSEStream();
        return {content:[{type:'text',text:'closed'}]};
      });
      for (const [name, ms] of [['short',1300],['long',2800],['stubborn',1800],['cancel',5000]]) {
        ctx.server.tool(name, async extra => {
          appendFileSync(${JSON.stringify(marker)}, name + ':started\\n');
          await new Promise(resolve => {
            const timer = setTimeout(resolve, ms);
            if (name === 'cancel') extra.signal.addEventListener('abort', () => {
              clearTimeout(timer); appendFileSync(${JSON.stringify(marker)}, 'cancel:aborted\\n'); resolve();
            }, {once:true});
          });
          appendFileSync(${JSON.stringify(marker)}, name + ':finished\\n');
          return {content:[{type:'text',text:name}]};
        });
      }
    }
  `);
  const child = await bootServer({ ...env, DA_HTTP_PORT: String(port), DA_HTTP_SESSION_TTL_MS: "1000", DA_AUTH_TOKEN: token, DA_HTTP_CORS_ORIGIN: origin }, "HTTP/SSE transport running on");
  const clients = [];
  const connect = async () => {
    const client = new Client({ name: "idle-regression", version: "1" });
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: headers.Authorization, Origin: origin } } });
    clients.push({ client, transport }); await client.connect(transport); return { client, transport };
  };
  const waitFor = async text => {
    const deadline = Date.now() + 3000;
    while (!existsSync(marker) || !readFileSync(marker, "utf8").includes(text)) {
      if (Date.now() > deadline) throw new Error(`Plugin did not report ${text}`);
      await delay(20);
    }
  };
  const recorded = text => existsSync(marker) && readFileSync(marker, "utf8").includes(text);
  try { await test({ connect, url, waitFor, recorded }); }
  finally {
    for (const { client, transport } of clients) { await transport.terminateSession().catch(() => {}); await client.close(); }
    await stopServer(child);
  }
}

await check("idle expiry waits for every active tool, then re-arms after the final result", () => withSlowSession(async ({ connect, url, waitFor }) => {
  const { client, transport } = await connect();
  const calls = Promise.all(["short", "long"].map(name => client.callTool({ name }, { timeout: 6000 })));
  await waitFor("long:started");
  const results = await calls;
  assert.deepEqual(results.map(result => result.content[0].text), ["short", "long"]);
  await delay(1300);
  assert.equal((await request(url, { headers: { ...headers, "Mcp-Session-Id": transport.sessionId } })).status, 404);
}));

await check("DELETE ends an active session and late old work cannot expire its replacement", () => withSlowSession(async ({ connect, url, waitFor }) => {
  const first = await connect(), oldId = first.transport.sessionId;
  const abandoned = first.client.callTool({ name: "stubborn" }, { timeout: 6000 }).then(() => "completed", () => "closed");
  await waitFor("stubborn:started");
  await first.transport.terminateSession(); await first.client.close();
  const second = await connect(); assert.notEqual(second.transport.sessionId, oldId);
  assert.equal((await second.client.callTool({ name: "long" }, { timeout: 6000 })).content[0].text, "long");
  assert.equal(await abandoned, "closed");
  assert.equal((await request(url, { headers: { ...headers, "Mcp-Session-Id": oldId } })).status, 404);
}));

await check("cancellation releases active-request bookkeeping even without a response", () => withSlowSession(async ({ connect, url, waitFor }) => {
  const { client, transport } = await connect(), controller = new AbortController();
  const call = client.callTool({ name: "cancel" }, { signal: controller.signal, timeout: 6000 });
  const rejected = assert.rejects(call, /abort|cancel/i);
  await waitFor("cancel:started"); controller.abort(); await rejected;
  await waitFor("cancel:aborted"); await delay(1300);
  assert.equal((await request(url, { headers: { ...headers, "Mcp-Session-Id": transport.sessionId } })).status, 404);
}));

await check("browser reload cannot interrupt a tool even after all its HTTP streams disconnect", () => withSlowSession(async ({ url, waitFor }) => {
  const h = await initialize(url), abort = new AbortController();
  const disconnect = await notificationStream(url, h);
  const call = fetch(url, { method: "POST", headers: h, signal: abort.signal,
    body: JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "long" } }) });
  const dropped = call.then(async response => { await response.text().catch(() => {}); }, () => {});
  await waitFor("long:started"); await disconnect(); abort.abort(); await dropped;
  assert.equal((await request(url, { method: "POST", headers, body: init })).status, 409);
  await delay(1200); // Beyond idle TTL: the disconnected tool is still running.
  assert.equal((await request(url, { method: "POST", headers, body: init })).status, 409);
  await waitFor("long:finished"); await delay(80);
  const next = await initialize(url);
  assert.notEqual(next["Mcp-Session-Id"], h["Mcp-Session-Id"]);
  await request(url, { method: "DELETE", headers: next });
}));

await check("server-initiated notification stream closure does not permit browser takeover", () => withSlowSession(async ({ url }) => {
  const h = await initialize(url), disconnect = await notificationStream(url, h);
  try {
    assert.equal((await rpc(url, h, "tools/call", { name: "close_notification_stream" })).result.content[0].text, "closed");
    await delay(80);
    assert.equal((await request(url, { method: "POST", headers, body: init })).status, 409);
  } finally { await disconnect(); await request(url, { method: "DELETE", headers: h }); }
}));

await check("in-flight uploads block browser handoff and cannot dispatch after explicit DELETE", () => withSlowSession(async ({ url, recorded }) => {
  const h = await initialize(url), disconnect = await notificationStream(url, h);
  let upload, finish, started;
  const accepted = new Promise(resolve => { started = resolve; });
  const body = JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "short" } });
  const completed = new Promise((resolve, reject) => {
    upload = httpRequest(url, { method: "POST", headers: { ...h, Expect: "100-continue" } }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    });
    upload.on("error", reject); upload.setTimeout(6000, () => upload.destroy(new Error("Upload stalled")));
    upload.once("continue", () => { upload.write(body.slice(0, 30)); started(); });
    upload.flushHeaders(); finish = () => upload.end(body.slice(30));
  });
  try {
    await accepted; await disconnect(); await delay(1200);
    assert.equal((await request(url, { method: "POST", headers, body: init })).status, 409);
    assert.equal((await request(url, { method: "DELETE", headers: h })).status, 200);
    const next = await initialize(url);
    finish(); assert.equal(await completed, 404);
    assert.ok((await rpc(url, next, "tools/list")).result);
    assert.equal(recorded("short:started"), false, "stale uploaded calls must not execute");
    await request(url, { method: "DELETE", headers: next });
  } finally { upload.destroy(); await completed.catch(() => {}); }
}));

async function abandonResponse(url, h, waitFor, name, id) {
  const abort = new AbortController();
  const call = fetch(url, { method: "POST", headers: h, signal: abort.signal,
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name } }) })
    .then(response => response.text()).catch(() => {});
  await waitFor(name + ":started"); abort.abort(); await call;
}

await check("duplicate in-flight IDs cannot release work or dispatch part of a rejected batch", () => withSlowSession(async ({ url, waitFor, recorded }) => {
  const h = await initialize(url), disconnect = await notificationStream(url, h);
  await abandonResponse(url, h, waitFor, "long", 42);
  const duplicate = { jsonrpc: "2.0", id: 42, method: "ping" };
  for (const body of [duplicate, [
    { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "short" } }, duplicate,
  ]]) {
    const rejected = await request(url, { method: "POST", headers: h, body: JSON.stringify(body) });
    assert.equal(rejected.status, 400); assert.equal((await rejected.json()).error.code, -32600);
  }
  assert.equal(recorded("short:started"), false, "no part of a conflicting batch may execute");
  const fresh = await request(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }) });
  assert.equal(fresh.status, 200); await fresh.text();
  await disconnect(); await delay(1200);
  assert.equal((await request(url, { method: "POST", headers, body: init })).status, 409, "the original tool must still own the session after its idle TTL");
  await waitFor("long:finished"); await delay(80);
  const next = await initialize(url); assert.notEqual(next["Mcp-Session-Id"], h["Mcp-Session-Id"]);
  await request(url, { method: "DELETE", headers: next });
}));

await check("batch ID validation is atomic and SDK-rejected uploads release their reservations", () => withSlowSession(async ({ url, recorded }) => {
  const h = await initialize(url), ping = { jsonrpc: "2.0", id: 11, method: "ping" };
  const attempt = (body, overrides = {}) => request(url, { method: "POST", headers: { ...h, ...overrides }, body: JSON.stringify(body) });
  const duplicate = await attempt([{ ...ping, method: "tools/call", params: { name: "short" } }, ping]);
  assert.equal(duplicate.status, 400); assert.equal((await duplicate.json()).error.code, -32600);
  assert.equal(recorded("short:started"), false);
  for (const [body, overrides, status] of [
    [[ping, { invalid: true }], {}, 400],
    [ping, { Accept: "application/json" }, 406],
    [ping, { "Content-Type": "text/plain" }, 415],
    [ping, { "MCP-Protocol-Version": "invalid" }, 400],
  ]) { const result = await attempt(body, overrides); assert.equal(result.status, status); await result.text(); }
  const valid = await attempt([ping, { ...ping, id: "11" }]); assert.equal(valid.status, 200);
  const replies = (await valid.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  assert.deepEqual(replies.map(reply => reply.id), [11, "11"], "numeric and string IDs are distinct");
  const completedReuse = await attempt(ping); assert.equal(completedReuse.status, 200); await completedReuse.text();
  await delay(1300);
  assert.equal((await request(url, { headers: h })).status, 404, "rejected reservations must not pin the session");
}));

await check("simultaneous same-ID POSTs reserve exactly one tool invocation", () => withSlowSession(async ({ url, recorded }) => {
  const h = await initialize(url), body = JSON.stringify({ jsonrpc: "2.0", id: 71, method: "tools/call", params: { name: "short" } });
  const attempts = await Promise.all([1, 2].map(async () => {
    const response = await request(url, { method: "POST", headers: h, body });
    return { status: response.status, body: await response.text() };
  }));
  assert.deepEqual(attempts.map(r => r.status).sort(), [200, 400]);
  assert.match(attempts.find(r => r.status === 400).body, /Duplicate in-flight/);
  assert.equal(recorded("short:started\nshort:started"), false);
  assert.equal(recorded("short:finished"), true);
  await request(url, { method: "DELETE", headers: h });
}));

await check("malformed cancellation cannot erase active-request bookkeeping", () => withSlowSession(async ({ url, waitFor }) => {
  const h = await initialize(url), disconnect = await notificationStream(url, h);
  await abandonResponse(url, h, waitFor, "long", 81);
  const malformed = await request(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0",
    method: "notifications/cancelled", params: { requestId: 81, reason: { invalid: true } } }) });
  assert.equal(malformed.status, 202);
  await disconnect(); await delay(1200);
  assert.equal((await request(url, { method: "POST", headers, body: init })).status, 409);
  await waitFor("long:finished");
}));

await check("cancelled IDs can be reused without late old work expiring the new request", () => withSlowSession(async ({ url, waitFor, recorded }) => {
  const h = await initialize(url);
  await abandonResponse(url, h, waitFor, "short", 91);
  const cancelled = await request(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0",
    method: "notifications/cancelled", params: { requestId: 91 } }) }); assert.equal(cancelled.status, 202);
  const replacement = await request(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 91,
    method: "tools/call", params: { name: "long" } }) });
  assert.equal(replacement.status, 200); assert.match(await replacement.text(), /"text":"long"/);
  assert.equal(recorded("short:finished"), true);
  await request(url, { method: "DELETE", headers: h });
}));

await check("legacy SSE rejects wrong IDs and messages uploaded across session replacement", async () => {
  const { env } = fixture(), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = await bootServer({ ...env, DA_HTTP_PORT: String(port), DA_AUTH_TOKEN: token, DA_HTTP_CORS_ORIGIN: origin }, "HTTP/SSE transport running on");
  const streams = [], clients = [];
  let upload;
  const openRaw = async () => {
    const response = await request(base + "/sse", { headers }); assert.equal(response.status, 200);
    const reader = response.body.getReader(); streams.push(reader);
    let data = "";
    while (!data.includes("\n\n")) {
      const chunk = await reader.read(); assert.equal(chunk.done, false); data += new TextDecoder().decode(chunk.value);
    }
    const endpoint = data.match(/data: (.+)/)?.[1]; assert.ok(endpoint); return base + endpoint.trim();
  };
  try {
    const oldEndpoint = await openRaw();
    const replacement = await openRaw();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 19, method: "tools/call", params: { name: "profile_plugin" } });
    for (const [url, status] of [[base + "/message", 400], [replacement + "&sessionId=duplicate", 400], [base + "/message?sessionId=wrong", 404], [oldEndpoint, 404]])
      assert.equal((await request(url, { method: "POST", headers, body })).status, status);
    let finish, started;
    const accepted = new Promise(resolve => { started = resolve; });
    const completed = new Promise((resolve, reject) => {
      upload = httpRequest(replacement, { method: "POST", headers: { ...headers, Expect: "100-continue" } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode));
      });
      upload.setTimeout(6000, () => upload.destroy(new Error("SSE upload timed out")));
      upload.on("error", reject);
      upload.once("continue", () => { upload.write(body.slice(0, 30)); started(); });
      upload.flushHeaders();
      finish = () => upload.end(body.slice(30));
    });
    // 100 Continue confirms the old request entered the upload handler before
    // replacement. Keep its JSON incomplete until the new client initializes.
    await Promise.race([accepted, completed.then(() => { throw new Error("Upload ended before the race was exercised"); })]);
    const client = new V1Client({ name: "replacement", version: "1" }); clients.push(client);
    await client.connect(new SSEClientTransport(new URL(base + "/sse"), { requestInit: { headers },
      eventSourceInit: { fetch: (url, options) => fetch(url, { ...options, headers }) } }));
    finish();
    assert.equal(await completed, 400, "an admitted upload must be rejected after its session becomes obsolete");
    const result = await client.callTool({ name: "profile_plugin" });
    assert.equal(JSON.parse(result.content[0].text).count, 1, "no rejected message may invoke the handler");
    assert.equal((await client.listTools()).tools.length, 210);
  } finally {
    upload?.destroy(); for (const client of clients) await client.close();
    for (const reader of streams) await reader.cancel().catch(() => {});
    await stopServer(child);
  }
});

for (const mode of ["stdio", "sse", "mcp", "ws"]) await check(`inspect profile enforces its catalog and denies alternate routes over ${mode}`, async () => {
  const { env, marker } = fixture(); env.DA_TOOL_PROFILE = "inspect";
  const client = new V1Client({ name: `inspect-${mode}`, version: "1" });
  let child, transport;
  try {
    if (mode === "stdio") transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: "pipe" });
    else {
      const port = await freePort();
      env[mode === "ws" ? "DA_WS_PORT" : "DA_HTTP_PORT"] = String(port);
      child = await bootServer(env, mode === "ws" ? "WebSocket transport running on" : "HTTP/SSE transport running on");
      transport = mode === "mcp" ? new V1Http(new URL(`http://127.0.0.1:${port}/mcp`)) :
        mode === "sse" ? new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`)) : new WebSocketClientTransport(new URL(`ws://127.0.0.1:${port}/ws`));
    }
    await client.connect(transport);
    assert.deepEqual(await names(client), expected);
    assert.equal(existsSync(marker), false, "restricted profile must not even import plugins");
    for (const name of ["adb_shell", "adb_reboot", "adb_wifi", "adb_health_check", "adb_workflow_run", "adb_registry_install", "adb_result_get", "profile_plugin"])
      await denied(client, name, { command: "echo SHOULD_NOT_RUN" });
    for (const call of [() => client.readResource({ uri: "device://list" }), () => client.readResource({ uri: "result://handle" }), () => client.getPrompt({ name: "debug-crash", arguments: { packageName: "com.example" } })])
      await assert.rejects(call());
    assert.equal((await client.callTool({ name: "adb_getprop", arguments: { key: "bad;key" } })).isError, true);
    if (mode === "mcp") await transport.terminateSession();
  } finally { await client.close(); if (child) await stopServer(child); }
});

await check("documented shared/network recipes enforce inspect instead of relying on command filters", async () => {
  const guide = readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  for (const heading of ["Shared or demo environments", "Network-exposed deployments"]) {
    const section = guide.split(`### ${heading}\n`)[1]?.split("### ")[0];
    const block = section?.match(/```bash\n([\s\S]*?)```/)?.[1]; assert.ok(block, heading);
    // Extract assignments as data; never execute the documentation's shell or
    // token generator. Use an isolated ADB, fresh port and fixed fixture token.
    const settings = Object.fromEntries(block.split("\n").flatMap(line => {
      const match = line.match(/^(DA_[A-Z_]+)=("[^"]*"|'[^']*'|\S+)\s*\\$/);
      return match ? [[match[1], match[2].replace(/^['"]|['"]$/g, "")]] : [];
    }));
    assert.equal(settings.DA_TOOL_PROFILE, "inspect");
    assert.equal(settings.DA_HTTP_HOST, "127.0.0.1"); assert.ok(settings.DA_AUTH_TOKEN);
    const { env } = isolatedEnvironment(), port = await freePort(), url = new URL(`http://127.0.0.1:${port}/mcp`);
    const child = await bootServer({ ...env, ...settings, DA_HTTP_PORT: String(port), DA_AUTH_TOKEN: token }, "HTTP/SSE transport running on");
    const client = new Client({ name: "documented-policy", version: "1" });
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: headers.Authorization } } });
    try {
      await client.connect(transport); assert.deepEqual(await names(client), expected);
      for (const [name, args] of [["adb_reboot", { mode: "normal" }], ["adb_wifi", { enabled: false }], ["adb_shell", { command: "getprop" }]])
        await denied(client, name, args);
      assert.equal((await request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: init })).status, 401);
    } finally { await transport.terminateSession().catch(() => {}); await client.close(); await stopServer(child); }
  }
});

await check("restricted registration fails closed if an unreviewed tool is added", async () => {
  const server = new McpServer({ name: "policy-test", version: "1" }), guarded = withToolProfile(server, "inspect");
  let invoked = 0;
  const handler = () => { invoked++; return { content: [{ type: "text", text: "ok" }] }; };
  assert.throws(() => guarded.registerTool("adb_shell", {}, handler), /excluded/);
  assert.throws(() => guarded.registerResource("bypass", "test://x", {}, handler), /unavailable/);
  assert.throws(() => guarded.registerPrompt("bypass", {}, handler), /unavailable/);
  const handle = guarded.registerTool("adb_devices", {}, handler);
  assert.throws(() => handle.update({ name: "adb_shell" }), /excluded/);
  handle.update({ callback: handler });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(), client = new Client({ name: "policy", version: "1" });
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    await denied(client, "adb_shell"); assert.equal(invoked, 0);
    assert.equal((await client.callTool({ name: "adb_devices" })).content[0].text, "ok"); assert.equal(invoked, 1);
  } finally { await client.close(); await server.close(); }
});
await check("unknown profiles, GraphQL bypass and invalid TTL fail startup", async () => {
  for (const setting of [{ DA_TOOL_PROFILE: "typo" }, { DA_TOOL_PROFILE: "inspect", DA_GRAPHQL_PORT: "9999" }, { DA_HTTP_SESSION_TTL_MS: "0" }]) {
    const { env } = isolatedEnvironment();
    await assert.rejects(bootServer({ ...env, DA_HTTP_PORT: String(await freePort()), ...setting }, "HTTP/SSE transport running on"), /DA_TOOL_PROFILE|DA_GRAPHQL_PORT|DA_HTTP_SESSION_TTL_MS/);
  }
});
cleanupEnvironments();
console.log(`\nLocal LLM: ${passed} passed, ${failed} failed, 0 skipped (${passed + failed} total)`);
process.exitCode = failed ? 1 : 0;
