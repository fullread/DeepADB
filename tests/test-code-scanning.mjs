// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Code-scanning regressions: bounded auth, public errors and shell data flow. */
import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnvironment, cleanupEnvironments, freePort, stopServer } from "./lib/isolated-server.mjs";

let passed = 0, failed = 0;
async function check(label, run) {
  try { await run(); passed++; console.log(`  ✓ ${label}`); }
  catch (error) { failed++; console.error(`  ✗ ${label}: ${error.stack}`); }
}
const fixture = isolatedEnvironment();
const token = "code-scanning-auth-0123456789abcdef";
Object.assign(process.env, fixture.env, { DA_AUTH_TOKEN: token });
const { hasValidToken } = await import("../build/middleware/auth.js");
const authorized = authorization => hasValidToken({ headers: { authorization } });
let graphql;
try {
  await check("Bearer scheme is case-insensitive and space/tab separators remain compatible", () => {
    for (const prefix of ["Bearer ", "bearer ", "BEARER ", "bEaReR\t", "Bearer \t  "]) assert.equal(authorized(prefix + token), true);
  });
  await check("Missing, malformed and wrong tokens are denied without normalization", () => {
    for (const header of [undefined, "", [], 123, "Basic " + token, " Bearer " + token, "Bearer" + token,
      "Bearer ", "Bearer\t\t", "Bearer wrong", "Bearer " + token + " ", "Bearer " + token + "x"]) {
      assert.equal(authorized(header), false, String(header));
    }
  });
  await check("Bearer parsing rejects folded headers, controls and line separators", () => {
    for (const separator of ["\r", "\n", "\r\n ", "\0", "\v", "\f", "\x1f", "\x7f", "\u2028", "\u2029"]) {
      assert.equal(authorized("Bearer" + separator + token), false);
      assert.equal(authorized("Bearer " + " ".repeat(8000) + "A" + separator + "!"), false);
    }
  });
  await check("Non-ASCII and embedded-space tokens still use exact UTF-8 comparison", async () => {
    process.env.DA_AUTH_TOKEN = "café token";
    const auth = await import("../build/middleware/auth.js?unicode-token");
    assert.equal(auth.hasValidToken({ headers: { authorization: "Bearer café token" } }), true);
    assert.equal(auth.hasValidToken({ headers: { authorization: "Bearer cafe token" } }), false);
    assert.equal(auth.hasValidToken({ headers: { authorization: "Bearer cafè token" } }), false);
    process.env.DA_AUTH_TOKEN = token;
  });
  await check("Authorization header size is bounded even for an otherwise valid token", () => {
    const boundary = "Bearer " + " ".repeat(16384 - 7 - token.length) + token;
    assert.equal(authorized(boundary), true);
    assert.equal(authorized("Bearer " + boundary.slice(6)), false);
  });
  await check("Auth remains optional when no token is configured", async () => {
    process.env.DA_AUTH_TOKEN = "";
    const auth = await import("../build/middleware/auth.js?no-token");
    assert.equal(auth.hasValidToken({ headers: {} }), true);
    process.env.DA_AUTH_TOKEN = token;
  });
  await check("Oversized pathological headers finish within a bounded subprocess deadline", () => {
    const moduleUrl = new URL("../build/middleware/auth.js", import.meta.url).href;
    const script = `import {hasValidToken} from ${JSON.stringify(moduleUrl)};
      const valid = hasValidToken({headers:{authorization:'Bearer '+' '.repeat(250000)+'A\\n!'}});
      if(valid)process.exit(1); console.log('bounded');`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...fixture.env, DA_AUTH_TOKEN: token }, encoding: "utf8", timeout: 4000, windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "bounded");
  });

  const port = await freePort();
  graphql = fork(fileURLToPath(new URL("./fixtures/code-scanning-graphql.mjs", import.meta.url)), [], {
    env: { ...fixture.env, DA_AUTH_TOKEN: token, AUDIT_PORT: String(port) }, silent: true, windowsHide: true,
  });
  let diagnostics = "";
  graphql.stderr.on("data", data => { diagnostics = (diagnostics + data).slice(-32000); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(diagnostics || "GraphQL fixture startup timeout")), 10000);
    graphql.once("message", () => { clearTimeout(timer); resolve(); });
    graphql.once("error", error => { clearTimeout(timer); reject(error); });
    graphql.once("exit", code => { clearTimeout(timer); reject(new Error(`GraphQL fixture exited ${code}: ${diagnostics}`)); });
  });
  const base = `http://127.0.0.1:${port}/graphql`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  async function request(body, options = {}) {
    const response = await fetch(base, { method: "POST", headers, body, signal: AbortSignal.timeout(5000), ...options });
    return { status: response.status, body: await response.json() };
  }
  const query = (query, extra = {}) => request(JSON.stringify({ query, ...extra }));
  function noPrivateDetails(body) {
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /CODE_SCANNING_PRIVATE_DETAIL|\/private\/fixture|\.mjs:|originalError|"stack"/);
  }
  await check("GraphQL authentication runs before request parsing", async () => {
    assert.equal((await request("null", { headers: { "Content-Type": "application/json" } })).status, 401);
    assert.equal((await request("null", { headers: { ...headers, Authorization: "Bearer wrong" } })).status, 401);
  });
  await check("Valid GraphQL POST and GET queries keep their response shape", async () => {
    const post = await query("{device{model}}", { variables: null, operationName: null });
    assert.equal(post.status, 200);
    assert.deepEqual(post.body, { data: { device: { model: "Fixture" } } });
    const response = await fetch(base + "?query=" + encodeURIComponent("{device{model}}"), { headers, signal: AbortSignal.timeout(5000) });
    assert.deepEqual(await response.json(), post.body);
  });
  await check("Malformed JSON returns a fixed message without reflecting the input", async () => {
    const r = await request('{"CODE_SCANNING_PRIVATE_DETAIL":');
    assert.equal(r.status, 400); noPrivateDetails(r.body);
    assert.equal(r.body.errors[0].extensions.code, "INVALID_JSON");
  });
  await check("Invalid request envelopes and field types return useful safe errors", async () => {
    for (const value of [null, [], "text", 42, { query: 3 }, { query: "{device{model}}", variables: [] },
      { query: "{device{model}}", operationName: { secret: "CODE_SCANNING_PRIVATE_DETAIL" } }]) {
      const r = await request(JSON.stringify(value));
      assert.equal(r.status, 400); noPrivateDetails(r.body);
      assert.equal(r.body.errors[0].extensions.code, "INVALID_REQUEST");
    }
  });
  await check("GET variable JSON failures use the same safe error boundary", async () => {
    const response = await fetch(base + "?query=" + encodeURIComponent("{device{model}}") + "&variables=%7Bprivate", { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).errors[0].extensions.code, "INVALID_JSON");
  });
  await check("Syntax errors keep locations and validation errors keep actionable messages", async () => {
    const syntax = await query("{device{");
    assert.equal(syntax.status, 400);
    assert.equal(syntax.body.errors[0].extensions.code, "INVALID_QUERY");
    assert.ok(syntax.body.errors[0].locations[0].line >= 1);
    const validation = await query("{device{notAField}}");
    assert.equal(validation.status, 400);
    assert.match(validation.body.errors[0].message, /Cannot query field "notAField"/);
  });
  await check("Pre-execution budgets keep their explicit public limit errors", async () => {
    const source = "{" + Array.from({ length: 17 }, (_, i) => `a${i}:device{model}`).join(" ") + "}";
    const r = await query(source);
    assert.equal(r.status, 400); assert.equal(r.body.errors[0].extensions.code, "FIELD_LIMIT");
    assert.match(r.body.errors[0].message, /alias \(16\) limit/);
  });
  await check("Variable coercion and unknown operations do not expose supplied values", async () => {
    for (const r of [
      await query("query($serial:String!){device(serial:$serial){model}}", { variables: { serial: { secret: "CODE_SCANNING_PRIVATE_DETAIL" } } }),
      await query("query Known {device{model}}", { operationName: "CODE_SCANNING_PRIVATE_DETAIL" }),
    ]) {
      assert.equal(r.status, 200); noPrivateDetails(r.body);
      assert.equal(r.body.errors[0].extensions.code, "BAD_USER_INPUT");
    }
  });
  for (const serial of ["internal", "non-error", "graphql-error", "spoofed", "unknown-code"]) {
    await check(`GraphQL masks ${serial} resolver errors and extensions`, async () => {
      const r = await query(`{device(serial:"${serial}"){model}}`);
      assert.equal(r.status, 200); noPrivateDetails(r.body);
      assert.equal(r.body.errors[0].message, "Internal GraphQL error");
      assert.deepEqual(r.body.errors[0].extensions, { code: "INTERNAL_SERVER_ERROR" });
      assert.deepEqual(r.body.errors[0].path, ["device"]);
      assert.deepEqual(r.body.data, null);
    });
  }
  await check("Nested resolver errors preserve the field path without backend details", async () => {
    const r = await query('{device(serial:"nested-error"){battery{level}}}');
    noPrivateDetails(r.body);
    assert.deepEqual(r.body.errors[0].path, ["device", "battery"]);
    assert.equal(r.body.errors[0].extensions.code, "INTERNAL_SERVER_ERROR");
  });
  await check("Known runtime limits use fixed messages rather than overwritten exception text", async () => {
    const r = await query('{device(serial:"known-limit"){model}}');
    noPrivateDetails(r.body);
    assert.equal(r.body.errors[0].extensions.code, "OPERATION_LIMIT");
    assert.match(r.body.errors[0].message, /budget exceeded \(64\)/);
  });
  await check("Unexpected request failures return 500 and keep diagnostics server-side", async () => {
    const r = await query('{device(serial:"catch-error"){model}}');
    assert.equal(r.status, 500); noPrivateDetails(r.body);
    assert.deepEqual(r.body, { errors: [{ message: "Internal GraphQL error", extensions: { code: "INTERNAL_SERVER_ERROR" } }] });
    for (let i = 0; i < 40 && !diagnostics.includes("GraphQL request failed"); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.match(diagnostics, /GraphQL request failed/);
    assert.match(diagnostics, /CODE_SCANNING_PRIVATE_DETAIL/);
  });
  await check("Response size limits still return a bounded public error", async () => {
    const r = await query('{device(serial:"large-response"){model}}');
    assert.equal(r.status, 400);
    assert.equal(r.body.errors[0].extensions.code, "RESPONSE_TOO_LARGE");
    assert.ok(JSON.stringify(r.body).length < 200);
  });

  // Alert #4 follows the split-APK arguments into infeasible dispatch branches.
  // Run the actual install-multiple branch against harmless shell functions.
  const { LocalBridge } = await import("../build/bridge/local-bridge.js");
  const bridge = new LocalBridge({ debug() {}, info() {}, warn() {}, error() {} });
  const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh";
  const paths = ["space name.apk", "quote' ; printf CODEQL_CANARY ; 'tail.apk", "$(printf CODEQL_CANARY).apk", "`printf CODEQL_CANARY`.apk", "line\nbreak.apk", "-x; printf CODEQL_CANARY"];
  for (const rooted of [false, true]) await check(`Split-APK shell operands survive quoting intact (root=${rooted})`, async () => {
    bridge.checkRootAvailable = async () => rooted;
    let command;
    bridge.execLocal = async value => { command = value; return { stdout: "Success", stderr: "", exitCode: 0 }; };
    await bridge.exec(["install-multiple", "-r", "-d", ...paths]);
    const result = spawnSync(shell, ["-c", 'su() { eval "$2"; }; pm() { printf "%s\\0" "$@"; }; ' + command], { encoding: "utf8", timeout: 3000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const argv = result.stdout.split("\0"); assert.equal(argv.pop(), "");
    assert.deepEqual(argv, ["install-multiple", "-r", "-d", ...paths.map(p => resolve(p))]);
  });
} finally {
  if (graphql) await stopServer(graphql);
  cleanupEnvironments();
}
console.log(`\nCode Scanning: ${passed} passed, ${failed} failed, 0 skipped (${passed + failed} total)`);
process.exitCode = failed ? 1 : 0;
