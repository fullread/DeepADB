// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** V1 client/plugin compatibility and native v2 registration regressions. No ADB. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { z as z3 } from "zod/v3";
import { Client, SSEClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport as V1SSE } from "@modelcontextprotocol/sdk/client/sse.js";
import { WebSocketClientTransport as V1WebSocket } from "@modelcontextprotocol/sdk/client/websocket.js";
import { ResourceTemplate as V1Template } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { ListRootsRequestSchema, ListRootsResultSchema, ProgressNotificationSchema, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { McpServer, InMemoryTransport, ResourceTemplate, SdkErrorCode } from "@modelcontextprotocol/server";
import { createPluginServer } from "../build/plugin-compat.js";
import { isolatedEnvironment, cleanupEnvironments, serverPath, freePort, bootServer, stopServer } from "./lib/isolated-server.mjs";

let passed = 0, failed = 0;
async function check(label, test) {
  try { await test(); console.log(`  ✓ ${label}`); passed++; }
  catch (error) { console.error(`  ✗ ${label}: ${error.stack}`); failed++; }
}
const text = value => ({ content: [{ type: "text", text: String(value) }] });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

async function withPlugin(setup, test, ClientType = Client) {
  const server = new McpServer({ name: "plugin-compat-test", version: "1.0.0" });
  const plugin = createPluginServer(server);
  await setup(plugin);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new ClientType({ name: "compat-test", version: "1.0.0" }, { capabilities: { roots: {} } });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await test(client, plugin);
  } finally { await client.close(); await server.close(); }
}

await check("all 209 built-in tool contracts, resources and prompts preserve the v1 catalog", async () => {
  const { env } = isolatedEnvironment();
  const client = new Client({ name: "v2-catalog", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: "pipe" }));
    const tools = (await client.listTools()).tools;
    const expected = JSON.parse(readFileSync(new URL("./fixtures/v1-catalog-hashes.json", import.meta.url), "utf8"));
    const actual = Object.fromEntries(tools.map(tool => {
      const copy = structuredClone(tool);
      // v2 advertises draft 2020-12 and removes the experimental tasks marker.
      delete copy.inputSchema.$schema;
      delete copy.execution;
      return [tool.name, digest(copy)];
    }));
    // Reviewed security change: SQLite's description now explains private
    // snapshots. Retain the original v1 fixture and explicitly pin this one
    // intentional catalog change; all input fields/defaults remain identical.
    assert.deepEqual(actual, { ...expected.tools,
      adb_sqlite_inspect: "65bac7e10510da388e34d94ac979b1e2226f2e1d04465c572a39e84d4c4b310a",
    });
    assert.equal(digest(await client.listResources()), expected.resources);
    assert.equal(digest(await client.listResourceTemplates()), expected.templates);
    assert.equal(digest(await client.listPrompts()), expected.prompts);
    const prompt = await client.getPrompt({ name: "debug-crash", arguments: { packageName: "com.example.app" } });
    assert.match(prompt.messages[0].content.text, /com\.example\.app/);
    const invalid = await client.callTool({ name: "adb_logcat", arguments: { lines: -1 } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); }
});

for (const revision of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
  await check(`stdio negotiates existing protocol ${revision}`, async () => {
    const { env } = isolatedEnvironment();
    const client = new Client({ name: "pinned-client", version: "1.0.0" }, { supportedProtocolVersions: [revision] });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: "pipe" }));
      assert.equal((await client.listTools()).tools.length, 209);
    } finally { await client.close(); }
  });
}

await check("legacy tools retain argument validation, defaults, annotations and flat callback context", () => withPlugin(plugin => {
  plugin.tool("legacy", "description", { n: z.number().min(1).max(5).default(2) }, { readOnlyHint: true }, (args, extra) => {
    assert.ok(extra.signal instanceof AbortSignal);
    assert.equal(extra.requestId, extra.mcpReq.id);
    assert.equal(extra._meta.marker, "preserved");
    return text(args.n);
  });
}, async client => {
  const tools = (await client.listTools()).tools;
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal((await client.callTool({ name: "legacy", arguments: {}, _meta: { marker: "preserved" } })).content[0].text, "2");
  assert.equal((await client.callTool({ name: "legacy", arguments: { n: 100 } })).isError, true);
}, V1Client));

for (const [label, register] of [
  ["callback only", (p, cb) => p.tool("zero", cb)],
  ["description", (p, cb) => p.tool("zero", "zero args", cb)],
  ["annotations", (p, cb) => p.tool("zero", { readOnlyHint: true }, cb)],
  ["description and annotations", (p, cb) => p.tool("zero", "zero args", { readOnlyHint: true }, cb)],
]) await check(`legacy no-schema tool: ${label}`, () => withPlugin(p => register(p, extra => text(extra.signal instanceof AbortSignal)), async c => {
  assert.equal((await c.callTool({ name: "zero" })).content[0].text, "true");
}));

await check("empty raw shape still passes args before extra", () => withPlugin(p => {
  p.tool("empty", {}, (args, extra) => { assert.deepEqual(args, {}); return text(extra.requestId !== undefined); });
}, async c => { assert.equal((await c.callTool({ name: "empty", arguments: {} })).content[0].text, "true"); }));

await check("legacy registration handles update schemas and callbacks, disable, enable and remove", () => withPlugin(p => {
  const h = p.tool("mutable", { n: z.number() }, () => text("old"));
  h.update({ paramsSchema: { n: z.number().min(3) }, callback: (args, extra) => text(`${args.n}:${extra.signal instanceof AbortSignal}`) });
  p.tool("toggle", {}, () => { h.disable(); return text("disabled"); });
  p.tool("enable", {}, () => { h.enable(); return text("enabled"); });
  p.tool("remove", {}, () => { h.remove(); return text("removed"); });
}, async c => {
  assert.equal((await c.callTool({ name: "mutable", arguments: { n: 4 } })).content[0].text, "4:true");
  assert.equal((await c.callTool({ name: "mutable", arguments: { n: 1 } })).isError, true);
  await c.callTool({ name: "toggle" });
  assert.equal((await c.listTools()).tools.some(t => t.name === "mutable"), false);
  await assert.rejects(c.callTool({ name: "mutable", arguments: { n: 4 } }), /disabled/i);
  await c.callTool({ name: "enable" });
  assert.equal((await c.listTools()).tools.some(t => t.name === "mutable"), true);
  await c.callTool({ name: "remove" });
  assert.equal((await c.listTools()).tools.some(t => t.name === "mutable"), false);
}));

await check("registerTool accepts raw and native schemas with old and new callback fields", () => withPlugin(p => {
  p.registerTool("raw", { inputSchema: { value: z.string() } }, (args, extra) => text(`${args.value}:${extra.signal === extra.mcpReq.signal}`));
  p.registerTool("native", { inputSchema: z.object({ value: z.string() }) }, (args, ctx) => text(`${args.value}:${ctx.mcpReq.id === ctx.requestId}`));
}, async c => {
  for (const name of ["raw", "native"]) assert.equal((await c.callTool({ name, arguments: { value: "hello" } })).content[0].text, "hello:true");
}));

for (const [label, zz] of [["Zod 3", z3], ["Zod 4", z]]) {
  await check(`${label} public handle schemas and callbacks survive inspection, wrapping and updates`, async () => {
    let tool, prompt;
    const toolCallback = (args, extra) => {
      assert.ok(extra.signal instanceof AbortSignal);
      return { ...text(args.value), structuredContent: { value: args.value } };
    };
    const promptCallback = (args, extra) => {
      assert.ok(extra.signal instanceof AbortSignal);
      return { messages: [{ role: "user", content: { type: "text", text: args.value } }] };
    };
    const inputSchema = zz.object({ value: zz.string().min(2) });
    const outputSchema = zz.object({ value: zz.string() });
    await withPlugin(p => {
      tool = p.registerTool("handle_tool", { inputSchema, outputSchema }, toolCallback);
      prompt = p.prompt("handle_prompt", { value: zz.string().min(2) }, promptCallback);
      assert.equal(tool.inputSchema, inputSchema);
      assert.equal(tool.outputSchema, outputSchema);
      assert.equal(tool.handler, toolCallback);
      assert.equal(prompt.callback, promptCallback);
      assert.equal("callback" in prompt, true);
      assert.equal(Object.hasOwn(prompt, "callback"), true);
      assert.ok(Object.keys(prompt).includes("callback"));
      assert.equal(prompt.argsSchema.safeParse({ value: "x" }).success, false);
      assert.equal(tool.inputSchema.safeParse({ value: "ok" }).success, true);
      assert.equal(tool.outputSchema.safeParse({ value: 3 }).success, false);
      const extra = { signal: new AbortController().signal };
      assert.equal(prompt.callback({ value: "direct" }, extra).messages[0].content.text, "direct");
      assert.equal(tool.handler({ value: "direct" }, extra).content[0].text, "direct");
    }, async c => {
      // Plugin wrappers commonly capture the public callback before updating it.
      const oldTool = tool.handler, oldPrompt = prompt.callback;
      const toolWrapper = (args, extra) => oldTool({ value: args.value.toUpperCase() }, extra);
      const promptWrapper = (args, extra) => oldPrompt({ value: args.value.toUpperCase() }, extra);
      tool.update({ paramsSchema: { value: zz.string().min(3) }, callback: toolWrapper });
      prompt.update({ argsSchema: { value: zz.string().min(3) }, callback: promptWrapper });
      assert.equal(tool.handler, toolWrapper); assert.equal(prompt.callback, promptWrapper);
      assert.equal(tool.inputSchema.safeParse({ value: "ok" }).success, false);
      assert.equal(prompt.argsSchema.safeParse({ value: "ok" }).success, false);
      assert.equal((await c.callTool({ name: "handle_tool", arguments: { value: "word" } })).content[0].text, "WORD");
      assert.equal((await c.callTool({ name: "handle_tool", arguments: { value: "ok" } })).isError, true);
      assert.equal((await c.getPrompt({ name: "handle_prompt", arguments: { value: "word" } })).messages[0].content.text, "WORD");
      await assert.rejects(c.getPrompt({ name: "handle_prompt", arguments: { value: "ok" } }), /Invalid arguments/);
      assert.throws(() => tool.update({ paramsSchema: { invalid: true } }), /Plugin schema/);
      assert.equal(tool.inputSchema.safeParse({ value: "ok" }).success, false, "failed updates preserve the public view");
      tool.handler = oldTool; prompt.callback = oldPrompt;
      assert.equal((await c.callTool({ name: "handle_tool", arguments: { value: "word" } })).content[0].text, "word");
      assert.equal((await c.getPrompt({ name: "handle_prompt", arguments: { value: "word" } })).messages[0].content.text, "word");
    }, V1Client);
  });
}

await check("resource handles expose original read callbacks and templates after updates", async () => {
  let fixed, dynamic;
  const first = new V1Template("handle://first/{name}", { list: undefined });
  const second = new V1Template("handle://second/{name}", { list: undefined });
  const read = (uri, ...args) => {
    assert.ok(args.at(-1).signal instanceof AbortSignal);
    return { contents: [{ uri: uri.href, text: "original" }] };
  };
  await withPlugin(p => {
    fixed = p.resource("fixed_handle", "handle://fixed", read);
    dynamic = p.resource("dynamic_handle", first, read);
    assert.equal(fixed.readCallback, read); assert.equal(dynamic.readCallback, read);
    assert.equal(dynamic.resourceTemplate, first);
    assert.equal(fixed.readCallback(new URL("handle://fixed"), { signal: new AbortController().signal }).contents[0].text, "original");
  }, async c => {
    const wrapped = (uri, ...args) => {
      const result = read(uri, ...args); result.contents[0].text += "-wrapped"; return result;
    };
    fixed.update({ callback: wrapped }); dynamic.update({ template: second, callback: wrapped });
    assert.equal(fixed.readCallback, wrapped); assert.equal(dynamic.readCallback, wrapped);
    assert.equal(dynamic.resourceTemplate, second);
    for (const uri of ["handle://fixed", "handle://second/value"])
      assert.equal((await c.readResource({ uri })).contents[0].text, "original-wrapped");
    await assert.rejects(c.readResource({ uri: "handle://first/value" }), /not found/i);
  }, V1Client);
});

await check("Zod 3 plugins preserve descriptions, bounds, defaults, refinements and transforms", () => withPlugin(p => {
  p.tool("zod3", { n: z3.number().min(1).max(5).default(2).describe("Legacy number") }, args => text(args.n));
  p.registerTool("refined", {
    inputSchema: z3.object({ value: z3.string().refine(value => value === "allowed").transform(value => value.toUpperCase()) }),
  }, args => text(args.value));
}, async c => {
  const tool = (await c.listTools()).tools.find(t => t.name === "zod3");
  assert.equal(tool.inputSchema.properties.n.description, "Legacy number");
  assert.equal(tool.inputSchema.properties.n.minimum, 1);
  assert.equal((await c.callTool({ name: "zod3", arguments: {} })).content[0].text, "2");
  assert.equal((await c.callTool({ name: "zod3", arguments: { n: 100 } })).isError, true);
  assert.equal((await c.callTool({ name: "refined", arguments: { value: "denied" } })).isError, true);
  assert.equal((await c.callTool({ name: "refined", arguments: { value: "allowed" } })).content[0].text, "ALLOWED");
}));

await check("legacy prompts retain argument schemas and no-argument context", () => withPlugin(p => {
  p.prompt("greet", "description", { name: z.string() }, (args, extra) => ({ messages: [{ role: "user", content: { type: "text", text: `${args.name}:${extra.signal instanceof AbortSignal}` } }] }));
  p.prompt("empty", extra => ({ messages: [{ role: "user", content: { type: "text", text: String(extra.requestId !== undefined) } }] }));
}, async c => {
  assert.equal((await c.getPrompt({ name: "greet", arguments: { name: "world" } })).messages[0].content.text, "world:true");
  assert.equal((await c.getPrompt({ name: "empty" })).messages[0].content.text, "true");
}));

for (const [version, zz] of [["Zod 3", z3], ["Zod 4", z]]) {
  for (const method of ["prompt", "registerPrompt"]) {
    await check(`${version} ${method} preserves argument completion and schema updates`, async () => {
      const cases = [V1Client, Client].flatMap(ClientType =>
        (method === "registerPrompt" ? [false, true] : [false]).map(objectSchema => ({ ClientType, objectSchema })));
      for (const { ClientType, objectSchema } of cases) {
        let handle;
        const callback = (args, extra) => {
          assert.ok(extra.signal instanceof AbortSignal);
          return { messages: [{ role: "user", content: { type: "text", text: args.required } }] };
        };
        const args = suffix => ({
          required: completable(zz.string().min(2), (value, context) => [value + suffix + context?.arguments?.scope]),
          optional: completable(zz.string(), async value => [value + suffix]).optional(),
        });
        const argsSchema = suffix => objectSchema ? zz.object(args(suffix)) : args(suffix);
        await withPlugin(p => {
          const initial = argsSchema("-initial-");
          handle = method === "prompt" ? p.prompt("complete", initial, callback)
            : p.registerPrompt("complete", { argsSchema: initial }, callback);
        }, async c => {
          assert.ok(c.getServerCapabilities().completions);
          const listed = (await c.listPrompts()).prompts.find(p => p.name === "complete");
          assert.equal(listed.arguments.find(a => a.name === "required").required, true);
          assert.equal(listed.arguments.find(a => a.name === "optional").required, false);
          for (const suffix of ["-initial-", "-updated-"]) {
            if (suffix === "-updated-") handle.update({ argsSchema: argsSchema(suffix), callback });
            for (const name of ["required", "optional"]) {
              const result = await c.complete({ ref: { type: "ref/prompt", name: "complete" },
                argument: { name, value: "value" }, context: { arguments: { scope: "scope" } } });
              assert.deepEqual(result.completion.values, ["value" + suffix + (name === "required" ? "scope" : "")]);
            }
            assert.equal((await c.getPrompt({ name: "complete", arguments: { required: "valid" } })).messages[0].content.text, "valid");
            await assert.rejects(c.getPrompt({ name: "complete", arguments: { required: "x" } }), /Invalid arguments/);
          }
        }, ClientType);
      }
    });
  }
}

await check("legacy callbacks can notify and send schema-validated requests to a v1 client", () => withPlugin(p => {
  p.tool("request", {}, async (_, extra) => {
    await extra.sendNotification({ method: "notifications/progress", params: { progressToken: "compat", progress: 1 } });
    const roots = await extra.sendRequest({ method: "roots/list" }, ListRootsResultSchema);
    return text(roots.roots[0].name);
  });
}, async c => {
  let progress;
  c.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: "file:///fixture", name: "fixture" }] }));
  c.setNotificationHandler(ProgressNotificationSchema, notification => { progress = notification.params.progress; });
  assert.equal((await c.callTool({ name: "request" })).content[0].text, "fixture");
  assert.equal(progress, 1);
}, V1Client));

await check("legacy cancellation signals reach the plugin handler", async () => {
  let started, cancelled;
  const begin = new Promise(resolve => { started = resolve; });
  const aborted = new Promise(resolve => { cancelled = resolve; });
  await withPlugin(p => {
    p.tool("wait", extra => new Promise(resolve => {
      extra.signal.addEventListener("abort", () => { cancelled(); resolve(text("cancelled")); }, { once: true });
      started();
    }));
  }, async c => {
    const controller = new AbortController();
    const call = c.callTool({ name: "wait" }, { signal: controller.signal });
    const rejection = assert.rejects(call);
    await begin;
    controller.abort();
    await rejection;
    const timer = setTimeout(() => cancelled("timed out"), 3000);
    try { assert.equal(await aborted, undefined); } finally { clearTimeout(timer); }
  });
});

for (const termination of ["cancellation", "disconnect"]) await check(`${termination} prevents retained legacy/native plugin helpers from reaching any client`, async () => {
  const server = new McpServer({ name: "retained-context", version: "1" }, { capabilities: { logging: {} } });
  const plugin = createPluginServer(server), clients = [];
  let context, started, release, aborted, notifications = 0, requests = 0;
  const begun = new Promise(resolve => { started = resolve; });
  const finished = new Promise(resolve => { release = resolve; });
  const cancelled = new Promise(resolve => { aborted = resolve; });
  plugin.tool("retain", async extra => {
    context = extra; extra.signal.addEventListener("abort", aborted, { once: true });
    started(); await finished; return text("finished");
  });
  plugin.tool("healthy", async extra => {
    await extra.sendNotification({ method: "notifications/progress", params: { progressToken: "healthy", progress: 1 } });
    const result = await extra.mcpReq.send({ method: "roots/list" });
    return text(result.roots[0].name);
  });
  const connect = async name => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name, version: "1" }, { capabilities: { roots: {} } }); clients.push(client);
    client.setNotificationHandler("notifications/progress", () => { notifications++; });
    client.setNotificationHandler("notifications/message", () => { notifications++; });
    client.setRequestHandler("roots/list", () => { requests++; return { roots: [{ uri: "file:///fixture", name: "healthy" }] }; });
    await server.connect(serverTransport); await client.connect(clientTransport); return client;
  };
  const blocked = async () => {
    assert.equal(context.signal.aborted, true);
    const notice = { method: "notifications/progress", params: { progressToken: "obsolete", progress: 1 } };
    await context.sendNotification(notice); await context.mcpReq.notify(notice);
    await context.mcpReq.log("info", "obsolete");
    await assert.rejects(context.sendRequest({ method: "roots/list" }, ListRootsResultSchema), e => e.code === ErrorCode.ConnectionClosed);
    const schema = { "~standard": { version: 1, vendor: "test", validate: value => ({ value }) } };
    for (const call of [
      () => context.mcpReq.send({ method: "roots/list" }),
      () => context.mcpReq.send({ method: "roots/list" }, schema),
      () => context.mcpReq.requestSampling({ messages: [], maxTokens: 1 }),
      () => context.mcpReq.elicitInput({ message: "obsolete", requestedSchema: { type: "object", properties: {} } }),
    ]) await assert.rejects(call(), e => e.code === SdkErrorCode.ConnectionClosed);
    assert.equal(notifications, 0); assert.equal(requests, 0);
  };
  try {
    const first = await connect("first"), controller = new AbortController();
    const work = first.callTool({ name: "retain" }, { signal: controller.signal });
    const rejection = assert.rejects(work);
    await begun;
    if (termination === "cancellation") controller.abort(); else await first.close();
    await rejection; await cancelled;
    await blocked(); await first.close();
    const second = await connect("replacement");
    await blocked();
    assert.equal((await second.callTool({ name: "healthy" })).content[0].text, "healthy");
    assert.equal(notifications, 1); assert.equal(requests, 1);
  } finally { release(); for (const client of clients) await client.close(); await server.close(); }
});

await check("prompt and resource handle updates preserve legacy callback contexts", () => withPlugin(p => {
  const prompt = p.prompt("update-prompt", { value: z.string() }, () => ({ messages: [] }));
  prompt.update({ argsSchema: { value: z.string().min(2) }, callback: (args, extra) => ({ messages: [{ role: "user", content: { type: "text", text: `${args.value}:${extra.signal instanceof AbortSignal}` } }] }) });
  const resource = p.resource("update-resource", "fixture://update", () => ({ contents: [] }));
  resource.update({ callback: (uri, extra) => ({ contents: [{ uri: uri.href, text: String(extra.signal instanceof AbortSignal) }] }) });
}, async c => {
  assert.equal((await c.getPrompt({ name: "update-prompt", arguments: { value: "ok" } })).messages[0].content.text, "ok:true");
  await assert.rejects(c.getPrompt({ name: "update-prompt", arguments: { value: "x" } }));
  assert.equal((await c.readResource({ uri: "fixture://update" })).contents[0].text, "true");
}));

for (const [label, Template] of [["v1", V1Template], ["v2", ResourceTemplate]]) {
  await check(`${label} resource templates retain list, read and completion callbacks`, () => withPlugin(p => {
    p.resource("static", "fixture://static", { mimeType: "text/plain" }, (uri, extra) => ({ contents: [{ uri: uri.href, text: String(extra.signal instanceof AbortSignal) }] }));
    p.resource("template", new Template("fixture://item/{id}", {
      list: extra => { assert.ok(extra.signal instanceof AbortSignal); return { resources: [{ name: "one", uri: "fixture://item/one" }] }; },
      complete: { id: value => [value + "-completion"] },
    }), (uri, variables, extra) => ({ contents: [{ uri: uri.href, text: `${variables.id}:${extra.requestId !== undefined}` }] }));
  }, async c => {
    assert.equal((await c.listResources()).resources.length, 2);
    assert.equal((await c.readResource({ uri: "fixture://static" })).contents[0].text, "true");
    assert.equal((await c.readResource({ uri: "fixture://item/one" })).contents[0].text, "one:true");
    assert.deepEqual((await c.complete({ ref: { type: "ref/resource", uri: "fixture://item/{id}" }, argument: { name: "id", value: "x" } })).completion.values, ["x-completion"]);
  }));
}

await check("invalid plugin schemas fail registration instead of disabling validation", () => {
  const p = createPluginServer(new McpServer({ name: "invalid", version: "1" }));
  assert.throws(() => p.tool("bad", { n: { fake: true } }, () => text("unsafe")), TypeError);
  assert.throws(() => p.registerTool("bad2", { inputSchema: { n: "string" } }, () => text("unsafe")), TypeError);
});

await check("existing typed plugins compile with ToolContext and legacy registration handles", () => {
  execFileSync(process.execPath, [
    fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
    "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--types", "node", "--target", "ES2024", "--module", "NodeNext",
    fileURLToPath(new URL("./fixtures/legacy-plugin.ts", import.meta.url)),
  ], { timeout: 30000, windowsHide: true, stdio: "pipe" });
});

await check("async disk plugins load once and retain the documented tool API", async () => {
  const { env } = isolatedEnvironment();
  // No package imports: this is exactly the documented legacy plugin shape.
  writeFileSync(join(env.DA_PLUGIN_DIR, "package.json"), '{"type":"module"}');
  writeFileSync(join(env.DA_PLUGIN_DIR, "legacy.js"), `
    let registrations = 0;
    export async function register(ctx) {
      await new Promise(resolve => setTimeout(resolve, 20));
      registrations++;
      ctx.server.tool("disk_plugin", "Legacy plugin", {}, async (_, extra) => ({ content: [{ type: "text", text: String(registrations) + ":" + (extra.signal instanceof AbortSignal) }] }));
    }
  `);
  const client = new Client({ name: "disk-plugin", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: "pipe" }));
    for (let i = 0; i < 2; i++) assert.equal((await client.callTool({ name: "disk_plugin" })).content[0].text, "1:true");
    assert.equal((await client.listTools()).tools.length, 210);
  } finally { await client.close(); }
});

await check("authenticated legacy SSE rejects invalid tokens and permits sequential reconnects", async () => {
  const { env } = isolatedEnvironment();
  const port = await freePort(), token = "sdk-compat-test-token-0123456789abcdef";
  const url = new URL(`http://127.0.0.1:${port}/sse`);
  const child = await bootServer({ ...env, DA_HTTP_PORT: String(port), DA_AUTH_TOKEN: token }, "HTTP/SSE transport running on");
  try {
    for (const auth of [undefined, "Bearer incorrect"]) {
      const r = await fetch(url, { headers: auth ? { Authorization: auth } : {}, signal: AbortSignal.timeout(5000) });
      assert.equal(r.status, 401);
    }
    for (let i = 0; i < 2; i++) {
      const client = new V1Client({ name: "sse-v1", version: "1.0.0" });
      const headers = { Authorization: `Bearer ${token}` };
      try {
        await client.connect(new V1SSE(url, { requestInit: { headers }, eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers: { ...init?.headers, ...headers } }) } }));
        assert.equal((await client.listTools()).tools.length, 209);
      } finally { await client.close(); }
    }
    const client = new Client({ name: "sse-v2", version: "1.0.0" });
    const headers = { Authorization: `Bearer ${token}` };
    try {
      await client.connect(new SSEClientTransport(url, { requestInit: { headers }, eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers: { ...init?.headers, ...headers } }) } }));
      assert.equal((await client.listTools()).tools.length, 209);
    } finally { await client.close(); }
  } finally { await stopServer(child); }
});

await check("legacy WebSocket clients reconnect without recreating the server", async () => {
  const { env } = isolatedEnvironment();
  const port = await freePort();
  const child = await bootServer({ ...env, DA_WS_PORT: String(port) }, "WebSocket transport running on");
  try {
    for (let i = 0; i < 2; i++) {
      const client = new V1Client({ name: "ws-v1", version: "1.0.0" });
      try {
        await client.connect(new V1WebSocket(new URL(`ws://127.0.0.1:${port}/ws`)));
        assert.equal((await client.listTools()).tools.length, 209);
      } finally {
        // SDK v1 close() initiates the handshake but does not await it. A new
        // connection before the actual close event is still a competing client
        // and correctly receives 409, especially on Node 22 under coverage.
        let timer;
        const closed = new Promise((resolve, reject) => {
          client.onclose = resolve;
          timer = setTimeout(() => reject(new Error("WebSocket close handshake timed out")), 5000);
        });
        try { await client.close(); await closed; }
        finally { clearTimeout(timer); }
      }
    }
  } finally { await stopServer(child); }
});

await check("SSE plugins retain request headers, URL and session identity", async () => {
  const { env } = isolatedEnvironment();
  writeFileSync(join(env.DA_PLUGIN_DIR, "package.json"), '{"type":"module"}');
  writeFileSync(join(env.DA_PLUGIN_DIR, "http-context.js"), `
    export function register(ctx) {
      ctx.server.tool("http_context", {}, (_, extra) => ({ content: [{ type: "text", text: JSON.stringify({
        header: extra.requestInfo?.headers["x-compat-test"], path: extra.requestInfo?.url.pathname,
        session: typeof extra.sessionId, signal: extra.signal instanceof AbortSignal
      }) }] }));
    }
  `);
  const port = await freePort();
  const child = await bootServer({ ...env, DA_HTTP_PORT: String(port) }, "HTTP/SSE transport running on");
  const client = new V1Client({ name: "http-context", version: "1" });
  try {
    await client.connect(new V1SSE(new URL(`http://127.0.0.1:${port}/sse`), { requestInit: { headers: { "x-compat-test": "preserved" } } }));
    const result = JSON.parse((await client.callTool({ name: "http_context" })).content[0].text);
    assert.deepEqual(result, { header: "preserved", path: "/message", session: "string", signal: true });
  } finally { await client.close(); await stopServer(child); }
});

await check("WebSocket token enforcement survives the SDK migration", async () => {
  const { env } = isolatedEnvironment();
  const port = await freePort(), token = "sdk-websocket-token-0123456789abcdef";
  const child = await bootServer({ ...env, DA_WS_PORT: String(port), DA_AUTH_TOKEN: token }, "WebSocket transport running on");
  const url = `ws://127.0.0.1:${port}/ws`;
  try {
    for (const headers of [{}, { Authorization: "Bearer incorrect" }]) {
      await new Promise((resolve, reject) => {
        const socket = new WebSocket(url, { headers });
        const timer = setTimeout(() => { socket.terminate(); reject(new Error("WS rejection timed out")); }, 5000);
        socket.once("error", error => { clearTimeout(timer); reject(error); });
        socket.once("open", () => { clearTimeout(timer); socket.terminate(); reject(new Error("Unauthorized WebSocket was upgraded")); });
        socket.once("unexpected-response", (request, response) => {
          clearTimeout(timer);
          response.resume();
          request.destroy();
          try { assert.equal(response.statusCode, 401); resolve(); } catch (e) { reject(e); }
        });
      });
    }
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
      const timer = setTimeout(() => { socket.terminate(); reject(new Error("WS initialize timed out")); }, 5000);
      socket.once("error", error => { clearTimeout(timer); reject(error); });
      socket.once("open", () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "auth-test", version: "1" } } })));
      socket.once("message", data => {
        clearTimeout(timer);
        try { assert.equal(JSON.parse(String(data)).result.serverInfo.name, "deepadb"); resolve(); } catch (e) { reject(e); }
        finally { socket.close(); }
      });
    });
  } finally { await stopServer(child); }
});

try { cleanupEnvironments(); } catch (error) { console.error(error); failed++; }
console.log(`\nSDK Compatibility: ${passed} passed, ${failed} failed, 0 skipped (${passed + failed} total)`);
process.exitCode = failed ? 1 : 0;
