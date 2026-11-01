// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Seven audit findings: real handlers/transports, synthetic data, no ADB. */
import assert from "node:assert/strict";
import { fork, spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, symlinkSync, linkSync, unlinkSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isolatedEnvironment, cleanupEnvironments, freePort, bootServer, stopServer } from "./lib/isolated-server.mjs";

const fixture = isolatedEnvironment();
Object.assign(process.env, fixture.env);
const [{ LocalBridge }, { config }, { registerSplitApkTools }, { registerDatabaseInspectorTools }, { runSqliteSnapshot }, { packageDirectoryGuard, packageFileRead }, { DatabaseSync }] = await Promise.all([
  import("../build/bridge/local-bridge.js"), import("../build/config/config.js"), import("../build/tools/split-apk.js"),
  import("../build/tools/database-inspector.js"), import("../build/middleware/sqlite-query.js"), import("../build/middleware/sqlite-path.js"), import("node:sqlite"),
]);
let passed = 0, failed = 0, skipped = 0;
async function check(label, run) {
  try { await run(); passed++; console.log(`  ✓ ${label}`); }
  catch (error) { failed++; console.error(`  ✗ ${label}: ${error.stack}`); }
}
function skip(label, reason) { skipped++; console.log(`  - ${label}: ${reason}`); }
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const tools = new Map();
const server = { registerTool(name, options, handler) { tools.set(name, { options, handler }); } };
const deviceManager = { resolveDevice: async () => ({ serial: "fixture" }) };
const bridge = new LocalBridge(config, logger);
bridge.checkRootAvailable = async () => true;
let commands = [];
bridge.execLocal = async command => { commands.push(command); return { stdout: "Success", stderr: "", exitCode: 0 }; };
registerSplitApkTools({ server, bridge, deviceManager, logger, config });
const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh";
const runShell = (script, cwd) => spawnSync(shell, ["-c", script], { encoding: "utf8", cwd, timeout: 5000, windowsHide: true });
const toPosix = p => process.platform === "win32" ? execFileSync(shell, ["-c", 'cygpath -u "$1"', "fixture", p], { encoding: "utf8" }).trim() : p;

try {
  const apkDir = join(fixture.root, "apks"); mkdirSync(apkDir);
  await check("Bundle handler quotes dash-leading APK operands instead of executing them", async () => {
    const cwd = process.cwd();
    try {
      process.chdir(apkDir);
      for (const filename of ["-r", "-audit; printf AUDIT_MARKER", "normal split.apk"]) writeFileSync(filename, "fixture");
      const tool = tools.get("adb_install_bundle");
      commands = [];
      const result = await tool.handler(tool.options.inputSchema.parse({ apkPaths: ["-r", "-audit; printf AUDIT_MARKER", "normal split.apk"] }));
      assert.equal(result.isError, false);
      assert.equal(commands.length, 1);
      assert.ok(commands[0].includes(resolve("-audit; printf AUDIT_MARKER")));
      // Run only through harmless fake su/pm functions: any escaped semicolon
      // would execute printf and add text outside the JSON argv record.
      const script = `su() { eval "$2"; }; pm() { printf 'ARG:%s\\n' "$@"; }; ${commands[0]}`;
      const executed = runShell(script);
      assert.equal(executed.status, 0, executed.stderr);
      assert.equal(executed.stdout.split("\n").filter(Boolean).length, 5);
      assert.ok(executed.stdout.includes("ARG:" + resolve("-audit; printf AUDIT_MARKER")));
    } finally { process.chdir(cwd); }
  });
  await check("LocalBridge also quotes non-allowlisted flags from direct callers", async () => {
    commands = [];
    await bridge.exec(["install-multiple", "-r", "-x; printf AUDIT_MARKER"]);
    const output = runShell(`su() { eval "$2"; }; pm() { printf 'ARG:%s\\n' "$@"; }; ${commands[0]}`);
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stdout.split("\n").filter(Boolean).length, 3);
  });

  const userRoot = join(fixture.root, "users");
  const appDir = join(userRoot, "com.example.app"); const dbDir = join(appDir, "databases");
  const outside = join(fixture.root, "outside");
  mkdirSync(dbDir, { recursive: true }); mkdirSync(outside);
  writeFileSync(join(dbDir, "main.db"), "SAFE"); writeFileSync(join(outside, "main.db"), "OUTSIDE");
  const posixRoot = toPosix(userRoot);
  await check("Normal package directory passes canonical containment", () => {
    const r = runShell(packageDirectoryGuard("com.example.app", posixRoot)); assert.equal(r.status, 0, r.stderr);
  });
  await check("Database parent link is rejected", () => {
    symlinkSync(outside, join(appDir, "linked"), process.platform === "win32" ? "junction" : "dir");
    const linkedApp = join(userRoot, "com.example.linked"); mkdirSync(linkedApp);
    symlinkSync(outside, join(linkedApp, "databases"), process.platform === "win32" ? "junction" : "dir");
    assert.notEqual(runShell(packageDirectoryGuard("com.example.linked", posixRoot)).status, 0);
  });
  await check("Package directory link is rejected", () => {
    symlinkSync(appDir, join(userRoot, "com.example.alias"), process.platform === "win32" ? "junction" : "dir");
    assert.notEqual(runShell(packageDirectoryGuard("com.example.alias", posixRoot)).status, 0);
  });
  await check("Verified descriptor reads a regular package database", () => {
    const r = runShell(packageFileRead("com.example.app", "main.db", false, posixRoot));
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, "SAFE");
  });
  await check("Hard-linked databases are refused before reading", () => {
    linkSync(join(outside, "main.db"), join(dbDir, "hard.db"));
    const r = runShell(packageFileRead("com.example.app", "hard.db", false, posixRoot));
    assert.notEqual(r.status, 0); assert.equal(r.stdout, ""); assert.match(r.stderr, /Hard-linked/);
  });
  let fileLinks = true;
  try { symlinkSync(join(outside, "main.db"), join(dbDir, "link-probe")); unlinkSync(join(dbDir, "link-probe")); }
  catch (error) { if (error.code !== "EPERM") throw error; fileLinks = false; }
  if (!fileLinks) skip("File/WAL symlink and descriptor-race cases", "Windows account cannot create file symlinks; Linux CI runs these cases");
  else {
    await check("Database and WAL symlinks emit no bytes", () => {
      for (const name of ["linked.db", "main.db-wal"]) {
        symlinkSync(join(outside, "main.db"), join(dbDir, name));
        const r = runShell(packageFileRead("com.example.app", name, true, posixRoot));
        assert.notEqual(r.status, 0); assert.equal(r.stdout, "");
      }
    });
    await check("Path replacement between checks and open is rejected by fd validation", () => {
      const script = packageFileRead("com.example.app", "main.db", false, posixRoot).replace("exec 3<", `mv ./main.db ./original.db; ln -s '${toPosix(join(outside, "main.db"))}' ./main.db\nexec 3<`);
      const r = runShell(script); assert.notEqual(r.status, 0); assert.equal(r.stdout, "");
    });
  }

  const dbPath = join(fixture.root, "query.db");
  const db = new DatabaseSync(dbPath); db.exec("CREATE TABLE items(id INTEGER); INSERT INTO items VALUES (1),(2),(3)"); db.close();
  const costly = "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n";
  await check("Private SQLite worker supports ordinary read-only queries", async () => {
    assert.match(await runSqliteSnapshot(dbPath, "SELECT * FROM items", { maxRows: 10 }), /id\n1\n2\n3/);
  });
  await check("SQLite enforces a deadline without blocking the MCP event loop", async () => {
    let responsive = false; const timer = setTimeout(() => { responsive = true; }, 50);
    try { await assert.rejects(runSqliteSnapshot(dbPath, costly, { maxRows: 1, timeoutMs: 250 }), /deadline/); assert.ok(responsive); }
    finally { clearTimeout(timer); }
  });
  await check("SQLite query cancellation kills the child and permits subsequent queries", async () => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 100);
    try { await assert.rejects(runSqliteSnapshot(dbPath, costly, { maxRows: 1, signal: controller.signal }), /cancelled/); }
    finally { clearTimeout(timer); }
    assert.match(await runSqliteSnapshot(dbPath, "SELECT 42 AS answer", { maxRows: 1 }), /42/);
  });
  await check("An already-cancelled SQLite request never starts a child", async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runSqliteSnapshot(dbPath, "SELECT 1", { maxRows: 1, signal: controller.signal }), /cancelled/);
  });
  await check("SQLite native allocation is bounded independently of V8", async () => {
    try {
      const result = await runSqliteSnapshot(dbPath, "SELECT zeroblob(200000000)", { maxRows: 1 });
      assert.match(result, /<BLOB 200000000 bytes>/); assert.ok(result.length < 200);
    } catch (error) { assert.match(error.message, /memory|allocation|large|too big/i); }
  });
  await check("SQLite rows and text output are bounded", async () => {
    const result = await runSqliteSnapshot(dbPath, "SELECT * FROM items", { maxRows: 1 });
    assert.match(result, /row limit/); assert.ok(!result.includes("\n2"));
    assert.ok((await runSqliteSnapshot(dbPath, "SELECT printf('%500000s','x')", { maxRows: 1 })).length < 2000);
  });
  await check("SQLite child read-only mode rejects writes", async () => {
    await assert.rejects(runSqliteSnapshot(dbPath, "DELETE FROM items", { maxRows: 1 }), /readonly|read-only/i);
  });
  await check("SQLite rejects excess concurrent work", async () => {
    const tasks = [1, 2].map(() => runSqliteSnapshot(dbPath, costly, { maxRows: 1, timeoutMs: 500 }).catch(e => e));
    await assert.rejects(runSqliteSnapshot(dbPath, "SELECT 1", { maxRows: 1 }), /busy/);
    await Promise.all(tasks);
  });
  await check("Server exit kills an active SQLite query child", async () => {
    const runner = join(fixture.root, "query-exit.mjs");
    writeFileSync(runner, `
      import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
      const original=cp.spawn; cp.spawn=(...args)=>{const child=original(...args);console.log(child.pid);return child;};syncBuiltinESMExports();
      const {runSqliteSnapshot}=await import(${JSON.stringify(new URL("../build/middleware/sqlite-query.js", import.meta.url).href)});
      runSqliteSnapshot(${JSON.stringify(dbPath)},${JSON.stringify(costly)},{maxRows:1}).catch(()=>{});
      setTimeout(()=>process.exit(0),75);
    `);
    const result = spawnSync(process.execPath, [runner], { encoding: "utf8", timeout: 5000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const pid = Number(result.stdout.trim()); assert.ok(Number.isInteger(pid) && pid > 0);
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); }
      catch (error) { if (error.code !== "ESRCH") throw error; alive = false; }
    }
    assert.equal(alive, false, `SQLite child ${pid} survived server exit`);
  });
  await check("Real SQLite handler cleans snapshots after success and rejected WAL", async () => {
    let rejectWal = false;
    const fakeBridge = {
      shell: async command => ({ stdout: command.startsWith("pm path") ? "package:fixture" : "uid=0", stderr: "", exitCode: 0 }),
      spawnStreaming: args => {
        const wal = args.at(-1).includes("./main.db-wal");
        return spawn(process.execPath, ["-e", wal ? (rejectWal ? "process.stderr.write('Linked WAL refused');process.exit(1)" : "") : "process.stdout.write(require('fs').readFileSync(process.argv[1]))", dbPath], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      },
    };
    registerDatabaseInspectorTools({ server, bridge: fakeBridge, deviceManager, logger, config });
    const tool = tools.get("adb_sqlite_inspect");
    const args = tool.options.inputSchema.parse({ packageName: "com.example.app", action: "query", database: "main.db", query: "SELECT * FROM items", access: "root" });
    assert.ok(!(await tool.handler(args)).isError);
    assert.deepEqual(readdirSync(join(config.tempDir, "sqlite-readonly")), []);
    rejectWal = true; const result = await tool.handler(args); assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /Linked WAL refused/);
    assert.deepEqual(readdirSync(join(config.tempDir, "sqlite-readonly")), []);
  });

  const runnerDir = join(fixture.root, "runner"); mkdirSync(runnerDir);
  copyFileSync(fileURLToPath(new URL("./run-all.mjs", import.meta.url)), join(runnerDir, "run-all.mjs"));
  for (const [label, text, exitCode, expected] of [
    ["normal summary", "Fixture: 1 passed, 0 failed, 0 skipped (1 total)", 0, 0],
    ["nonzero exit with passing counts", "Fixture: 1 passed, 0 failed, 0 skipped (1 total)", 1, 1],
    ["missing summary", "No summary", 0, 1],
    ["contradictory total", "Fixture: 1 passed, 0 failed, 0 skipped (9 total)", 0, 1],
    ["duplicate summaries", "Fixture: 1 passed, 0 failed, 0 skipped\nFixture: 1 passed, 0 failed, 0 skipped", 0, 1],
    ["failed assertions", "Fixture: 1 passed, 1 failed, 0 skipped (2 total)", 0, 1],
  ]) await check(`Aggregate runner: ${label}`, () => {
    writeFileSync(join(runnerDir, "test-fixture.mjs"), `console.log(${JSON.stringify(text)});process.exit(${exitCode})`);
    const r = spawnSync(process.execPath, [join(runnerDir, "run-all.mjs")], { encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.equal(r.status, expected, r.stdout + r.stderr);
  });
  await check("Aggregate runner rejects an empty suite selection", () => {
    unlinkSync(join(runnerDir, "test-fixture.mjs"));
    assert.equal(spawnSync(process.execPath, [join(runnerDir, "run-all.mjs")], { windowsHide: true }).status, 1);
  });

  const token = "audit-regression-token-0123456789abcdef", origin = "http://localhost:8080";
  const port = await freePort();
  const graphql = fork(fileURLToPath(new URL("./fixtures/audit-graphql.mjs", import.meta.url)), [], {
    env: { ...fixture.env, DA_AUTH_TOKEN: token, DA_GRAPHQL_CORS_ORIGIN: origin, AUDIT_PORT: String(port), AUDIT_HOST: "::1" },
    silent: true, windowsHide: true,
  });
  let diagnostics = ""; graphql.stderr.on("data", d => { diagnostics += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(diagnostics || "GraphQL fixture startup timeout")), 10000);
    graphql.once("message", () => { clearTimeout(timer); resolve(); });
    graphql.once("exit", code => { clearTimeout(timer); reject(new Error(`GraphQL fixture exited ${code}: ${diagnostics}`)); });
  });
  let requestId = 0;
  const stats = () => new Promise(resolve => { const id = ++requestId; const receive = data => { if (data.id === id) { graphql.off("message", receive); resolve(data); } }; graphql.on("message", receive); graphql.send(id); });
  const base = `http://[::1]:${port}/graphql`;
  const headers = { Authorization: `Bearer ${token}`, Origin: origin, "Content-Type": "application/json" };
  const query = (source, variables, extra = {}) => fetch(base, { method: "POST", headers, body: JSON.stringify({ query: source, variables }), signal: AbortSignal.timeout(10000), ...extra });
  try {
    await check("GraphQL rejects denied Origins before resolver execution", async () => {
      const before = await stats();
      for (const Origin of ["https://denied.example", "null"]) {
        const r = await query("{device{battery{level}}}", {}, { headers: { ...headers, Origin } });
        assert.equal(r.status, 403); assert.equal((await stats()).calls, before.calls);
      }
    });
    await check("GraphQL requires tokens for allowed-Origin requests", async () => {
      for (const auth of ["", "Bearer wrong"]) assert.equal((await query("{device{model}}", {}, { headers: { ...headers, Authorization: auth } })).status, 401);
    });
    await check("GraphQL preflight is exact and native requests remain compatible", async () => {
      const r = await fetch(base, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" } });
      assert.equal(r.status, 204); assert.equal(r.headers.get("Access-Control-Allow-Origin"), origin);
      const native = await query("{device{model}}", {}, { headers: { Authorization: headers.Authorization, "Content-Type": "application/json" } });
      assert.equal((await native.json()).data.device.model, "Fixture");
    });
    await check("GraphQL GET works on IPv6 loopback", async () => {
      const r = await fetch(base + "?query=" + encodeURIComponent("{device{model}}"), { headers });
      assert.equal(r.status, 200); assert.equal((await r.json()).data.device.model, "Fixture");
    });
    const aliased = "{" + Array.from({ length: 40 }, (_, i) => `a${i}:device{battery{level}}`).join(" ") + "}";
    for (const [label, source, variables] of [
      ["alias amplification", aliased, {}],
      ["fragment amplification", "{device{...F ...F ...F}} fragment F on Device{" + Array.from({ length: 10 }, (_, i) => `a${i}:battery{level}`).join(" ") + "}", {}],
      ["cyclic fragments", "{device{...F}} fragment F on Device{...F}", {}],
      ["oversized variable arrays", "query($keys:[String!]){device{properties(keys:$keys){key value}}}", { keys: Array(101).fill("x") }],
      ["oversized literal arrays", "{device{properties(keys:[" + Array(101).fill('"x"').join(",") + "]){key}}}", {}],
      ["oversized default arrays", "query($keys:[String!]=[" + Array(101).fill('"x"').join(",") + "]){device{properties(keys:$keys){key}}}", {}],
      ["deep introspection", '{__type(name:"Device"){' + 'ofType{'.repeat(10) + 'name' + '}'.repeat(12), {}],
    ]) await check(`GraphQL rejects ${label} before device I/O`, async () => {
      const before = await stats(); const r = await query(source, variables);
      assert.equal(r.status, 400, await r.text()); assert.equal((await stats()).calls, before.calls);
    });
    await check("GraphQL bounds cross-request resolver concurrency", async () => {
      const source = "{" + Array.from({ length: 8 }, (_, i) => `a${i}:device{battery{level}}`).join(" ") + "}";
      const responses = await Promise.all([query(source), query(source)]);
      for (const r of responses) assert.equal(r.status, 200);
      assert.ok((await stats()).maximum <= 4);
    });
    await check("GraphQL caps expanded device-list work at runtime", async () => {
      const before = await stats();
      const r = await query("{devices{" + Array.from({ length: 16 }, (_, i) => `b${i}:battery{level}`).join(" ") + "}}");
      assert.match(JSON.stringify(await r.json()), /budget exceeded|cancelled/);
      assert.ok((await stats()).calls - before.calls <= 64);
    });
    await check("GraphQL rejects excess simultaneous HTTP queries", async () => {
      const responses = await Promise.all(Array.from({ length: 12 }, () => query("{devices{model}}")));
      assert.ok(responses.some(r => r.status === 429));
      assert.ok(responses.every(r => [200, 429].includes(r.status)));
      await Promise.all(responses.map(r => r.arrayBuffer()));
      assert.ok((await stats()).maximum <= 4);
    });
  } finally { await stopServer(graphql); }

  const httpPort = await freePort();
  const http = await bootServer({ ...fixture.env, DA_HTTP_HOST: "::1", DA_HTTP_PORT: String(httpPort), DA_TOOL_PROFILE: "inspect", DA_AUTH_TOKEN: token }, "HTTP/SSE transport running on");
  const httpBase = `http://[::1]:${httpPort}`;
  try {
    await check("HTTP health succeeds on IPv6 loopback", async () => { assert.equal((await fetch(httpBase + "/health")).status, 200); });
    for (const [name, Transport, endpoint] of [["Streamable HTTP", StreamableHTTPClientTransport, "/mcp"], ["legacy SSE", SSEClientTransport, "/sse"]]) {
      await check(`${name} completes IPv6 initialization and tool discovery`, async () => {
        const client = new Client({ name: "audit-ipv6", version: "1" });
        const transport = new Transport(new URL(httpBase + endpoint), { requestInit: { headers: { Authorization: headers.Authorization } } });
        try { await client.connect(transport); assert.equal((await client.listTools()).tools.length, 3); if (transport.terminateSession) await transport.terminateSession(); }
        finally { await client.close(); }
      });
    }
  } finally { await stopServer(http); }
} finally { cleanupEnvironments(); }
console.log(`\nAudit hardening: ${passed} passed, ${failed} failed, ${skipped} skipped (${passed + failed + skipped} total)`);
process.exitCode = failed ? 1 : 0;
