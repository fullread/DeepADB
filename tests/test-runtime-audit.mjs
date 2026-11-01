// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Real registered runtime-audit handler, synthetic bridge results, no device I/O. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { registerRuntimeAuditTools, buildModemCharacterDeviceProbe } from "../build/tools/runtime-audit.js";
import { AdbError } from "../build/bridge/adb-bridge.js";
import { runSqliteSnapshot } from "../build/middleware/sqlite-query.js";

let passed = 0, failed = 0;
async function check(label, run) {
  try { await run(); passed++; console.log(`  ✓ ${label}`); }
  catch (error) { failed++; console.error(`  ✗ ${label}: ${error.stack}`); }
}

const names = ["am", "cmd", "dumpsys", "getenforce", "ip", "logcat", "pm", "settings", "sqlite3", "uiautomator"];
const good = (stdout = "", extra = {}) => ({ stdout, stderr: "", exitCode: 0, timedOut: false, bufferExceeded: false, ...extra });
const target = { serial: "audit-fixture", state: "device", model: "FallbackModel" };
const props = "[ro.product.model]: [FixturePhone]\n[ro.build.version.release]: [16]\n[ro.build.version.sdk]: [36]\n[ro.board.platform]: [gs101]";
const defaults = {
  getprop: props,
  id: "uid=2000(shell) gid=2000(shell)",
  "su -c id": "uid=0(root) gid=0(root)",
  getenforce: "Enforcing",
  "getprop sys.boot_completed": "1",
  "df -k /data /sdcard": "Filesystem 1K-blocks Used Available\n/dev/data 10000 1000 9000",
  capabilities: names.map(name => `${name}=1`).join("\n"),
  "ip route show": "default via 192.0.2.1 dev wlan0",
  "dumpsys battery": "Current Battery Service state:\n  USB powered: true\n  level: 82\n  temperature: 280",
  "pm path com.google.android.gms": "package:/data/app/fixture/base.apk",
  "getprop ro.build.characteristics": "nosdcard",
};

function fixture(overrides = {}) {
  const calls = [];
  let handler, definition;
  const value = (key, fallback) => {
    const selected = Object.hasOwn(overrides, key) ? overrides[key] : fallback;
    if (typeof selected === "function") return selected();
    if (selected instanceof Error) throw selected;
    return selected;
  };
  registerRuntimeAuditTools({
    server: { registerTool(name, options, callback) {
      assert.equal(name, "adb_runtime_audit"); definition = options; handler = callback;
    } },
    deviceManager: {
      resolveDevice(device) { calls.push({ method: "resolve", device }); return value("resolve", target); },
      listDevices() { calls.push({ method: "list" }); return value("devices", [target]); },
      getDeviceProps() { throw new Error("Audit should use its bounded, exit-checked getprop probe"); },
    },
    bridge: {
      version() { calls.push({ method: "version" }); return value("version", "Fixture ADB 1.0"); },
      async shell(command, options) {
        calls.push({ method: "shell", command, options });
        const key = command.startsWith("for c in ") ? "capabilities" : command;
        assert.ok(Object.hasOwn(defaults, key), `Unexpected command: ${command}`);
        const result = await value(key, defaults[key]);
        return typeof result === "string" ? good(result) : result;
      },
      async rootShell(command, options) {
        calls.push({ method: "root", command, options });
        const result = await value("modem", "/dev/umts_router");
        return typeof result === "string" ? good(result) : result;
      },
    },
  });
  return { calls, definition, async run(device = target.serial) {
    const result = await handler({ device });
    return { result, text: result.content.map(block => block.text).join("\n"), calls };
  } };
}

function report(output, partial = true) {
  assert.ok(!output.result.isError, output.text);
  assert.match(output.text, new RegExp(`Audit status: ${partial ? "partial" : "complete"}`));
  assert.match(output.text, /No files, settings, packages, routes, or device state were modified/);
}

// Run the real handler and host worker under Node's actual SQLite-disable flag.
// The bridge remains synthetic; no phone, database file or plugin is accessed.
if (process.argv[2] === "--sqlite-backend-fixture") {
  process.env.DA_LOCAL = "false";
  const deviceSqlite = process.argv[3];
  assert.ok(["present", "absent", "failed"].includes(deviceSqlite));
  const capabilities = deviceSqlite === "failed" ? new Error("synthetic capability failure")
    : defaults.capabilities.replace("sqlite3=1", `sqlite3=${deviceSqlite === "present" ? "1" : "0"}`);
  const out = await fixture({ capabilities }).run();
  let hostImportError = null, workerError = null;
  try { await import("node:sqlite"); } catch (error) { hostImportError = error.code; }
  try { await runSqliteSnapshot(":memory:", "SELECT 1", { maxRows: 1 }); }
  catch (error) { workerError = error.message; }
  console.log(JSON.stringify({ text: out.text, isError: !!out.result.isError, hostImportError, workerError }));
  process.exit(0);
}

// Only the fake bridge is used, including when simulating on-device mode.
const previousLocal = process.env.DA_LOCAL;
process.env.DA_LOCAL = "true";
try {
  await check("successful audit retains snapshots and reports bounded prerequisites", async () => {
    const f = fixture();
    const out = await f.run(); report(out, false);
    for (const expected of ["Core ADB: available", "UI automation: available", "Network diagnostics: available", "Root diagnostics: available", "SQLite inspection: available", "Wear Data Layer: available", "handshake not tested", "pairing not tested", "FixturePhone / Android 16", "9000", "level: 82", "USB powered: true"]) {
      assert.ok(out.text.includes(expected), expected);
    }
    assert.deepEqual(Object.keys(f.definition.inputSchema.shape), ["device"]);
    for (const call of f.calls.filter(call => call.options)) {
      assert.equal(call.options.device, target.serial);
      assert.ok(call.options.timeout > 0 && call.options.timeout <= 10000);
      assert.equal(call.options.retries, 0);
    }
  });

  await check("a rejected battery probe retains independent successful results", async () => {
    const out = await fixture({ "dumpsys battery": async () => { throw new Error("fixture battery failure"); } }).run();
    report(out);
    assert.match(out.text, /Battery: probe failed/);
    assert.match(out.text, /Core ADB: available/);
    assert.match(out.text, /9000/);
    assert.match(out.text, /Modem \/ AT: available/);
  });

  await check("properties failure retains target fallback and avoids guessing modem paths", async () => {
    const out = await fixture({ getprop: new Error("properties failed") }).run(); report(out);
    assert.match(out.text, /Target: FallbackModel \/ Android unknown/);
    assert.match(out.text, /Chipset family: unknown/);
    assert.match(out.text, /Modem \/ AT: inconclusive/);
    assert.match(out.text, /level: 82/);
    assert.equal(out.calls.filter(call => call.method === "root").length, 0);
  });

  await check("secondary discovery and version failures do not discard a resolved target", async () => {
    const out = await fixture({ devices: new Error("list failed"), version: () => { throw new Error("sync failure"); } }).run(); report(out);
    assert.match(out.text, /Connected devices: inconclusive/);
    assert.match(out.text, /ADB: inconclusive/);
    assert.match(out.text, /Core ADB: available/);
    assert.match(out.text, /FixturePhone/);
  });

  for (const reason of ["No devices connected", "Device audit-fixture is unauthorized", "Multiple devices connected"]) {
    await check(`target resolution stays fatal: ${reason}`, async () => {
      const f = fixture({ resolve: new Error(reason) });
      const out = await f.run();
      assert.equal(out.result.isError, true);
      assert.ok(out.text.includes(reason));
      assert.deepEqual(f.calls, [{ method: "resolve", device: target.serial }]);
    });
  }

  await check("returned nonzero root exit cannot promote its partial uid=0 output", async () => {
    const out = await fixture({ "su -c id": good("uid=0(root)", { exitCode: 1 }) }).run(); report(out);
    assert.match(out.text, /Root diagnostics: inconclusive — command exited with code 1/);
    assert.match(out.text, /Modem \/ AT: inconclusive/);
    assert.equal(out.calls.filter(call => call.method === "root").length, 0);
    assert.match(out.text, /Core ADB: available/);
  });

  await check("thrown timeout retains good snapshots without claiming no routes", async () => {
    const out = await fixture({ "ip route show": new AdbError("raw private command", good("default via 192.0.2.1", { timedOut: true, exitCode: 1 })) }).run(); report(out);
    assert.match(out.text, /Routes: command timed out/);
    assert.match(out.text, /Network diagnostics: inconclusive/);
    assert.doesNotMatch(out.text, /no routes reported|raw private command/);
    assert.match(out.text, /level: 82/);
  });

  await check("returned timeout flags are failures even with zero exit and valid stdout", async () => {
    const out = await fixture({ "getprop sys.boot_completed": good("1", { timedOut: true }) }).run(); report(out);
    assert.match(out.text, /Boot completed: inconclusive/);
    assert.match(out.text, /Core ADB: inconclusive/);
    assert.match(out.text, /Boot state: command timed out/);
  });

  await check("capture overflow cannot advertise partial capability results", async () => {
    const out = await fixture({ capabilities: good(defaults.capabilities, { bufferExceeded: true }) }).run(); report(out);
    assert.match(out.text, /Command capabilities: output exceeded the capture limit/);
    assert.match(out.text, /UI automation: inconclusive/);
    assert.match(out.text, /SQLite inspection: inconclusive/);
    assert.match(out.text, /Core ADB: available/);
  });

  await check("missing and duplicate capability rows affect only uncertain commands", async () => {
    const capabilities = defaults.capabilities.replace("uiautomator=1", "").replace("am=1", "am=1\nam=0");
    const out = await fixture({ capabilities }).run(); report(out);
    assert.match(out.text, /uiautomator: inconclusive; am: inconclusive/);
    assert.match(out.text, /Network diagnostics: available/);
    assert.match(out.text, /SQLite inspection: available/);
    assert.match(out.text, /Command capabilities: missing, duplicate or invalid result rows/);
  });

  await check("explicit negative observations are unavailable, not failed checks", async () => {
    const out = await fixture({
      capabilities: names.map(name => `${name}=0`).join("\n"),
      "su -c id": "uid=2000(shell)", "ip route show": "", "pm path com.google.android.gms": "",
      "getprop sys.boot_completed": "0",
    }).run(); report(out, false);
    for (const name of ["Core ADB", "UI automation", "Network diagnostics", "SQLite inspection", "Root diagnostics", "Modem / AT", "Wear Data Layer"]) {
      assert.ok(out.text.includes(`${name}: unavailable`), name);
    }
    assert.equal(out.calls.filter(call => call.method === "root").length, 0);
  });

  await check("modem failure preserves a successful root check and other diagnostics", async () => {
    const out = await fixture({ modem: new Error("cannot probe nodes") }).run(); report(out);
    assert.match(out.text, /Root diagnostics: available/);
    assert.match(out.text, /Modem \/ AT: inconclusive/);
    assert.match(out.text, /level: 82/);
    assert.doesNotMatch(out.text, /no visible shannon modem/);
  });

  await check("a modem probe with no visible nodes is a completed negative result", async () => {
    const out = await fixture({ modem: "" }).run(); report(out, false);
    assert.match(out.text, /Modem \/ AT: unavailable — no visible shannon modem character node/);
    const command = out.calls.find(call => call.method === "root").command;
    assert.match(command, /if test -c/);
    assert.match(command, /; :$/);
    assert.equal(buildModemCharacterDeviceProbe([]), ":");
  });

  await check("invalid or overflowed modem output cannot imply AT readiness", async () => {
    for (const modem of ["/data/ordinary-file", good("/dev/umts_router", { bufferExceeded: true }), good("/dev/umts_router", { exitCode: 1 })]) {
      const out = await fixture({ modem }).run(); report(out);
      assert.match(out.text, /Modem \/ AT: inconclusive/);
      assert.match(out.text, /Root diagnostics: available/);
    }
  });

  await check("malformed successful responses stay inconclusive rather than missing", async () => {
    const out = await fixture({ id: "permission denied", "getprop sys.boot_completed": "", getenforce: "unexpected", "dumpsys battery": "permission denied", "pm path com.google.android.gms": "permission denied" }).run(); report(out);
    assert.match(out.text, /Core ADB: inconclusive/);
    assert.match(out.text, /SELinux: inconclusive/);
    assert.match(out.text, /Wear Data Layer: inconclusive/);
    assert.match(out.text, /Battery: empty or unrecognized battery response/);
    assert.doesNotMatch(out.text, /Google Play services missing/);
  });

  await check("unknown device role does not discard confirmed Play services", async () => {
    const out = await fixture({ "getprop ro.build.characteristics": new Error("role failed") }).run(); report(out);
    assert.match(out.text, /Wear Data Layer: available — device role inconclusive; Google Play services present; pairing not tested/);
  });

  await check("host SQLite readiness survives failure of the device command probe", async () => {
    process.env.DA_LOCAL = "false";
    try {
      const out = await fixture({ capabilities: new Error("failed") }).run(); report(out);
      const [major, minor] = process.versions.node.split(".").map(Number);
      if (major > 22 || major === 22 && minor >= 16) {
        assert.match(out.text, /SQLite inspection: available — host Node SQLite backend available/);
      } else {
        assert.match(out.text, /SQLite inspection: unavailable — host Node SQLite backend unavailable/);
      }
      assert.match(out.text, /UI automation: inconclusive/);
    } finally { process.env.DA_LOCAL = "true"; }
  });

  for (const deviceSqlite of ["present", "absent", "failed"]) {
    await check(`disabled host SQLite stays unavailable when device sqlite3 is ${deviceSqlite}`, () => {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--sqlite-backend-fixture", deviceSqlite], {
        env: { ...process.env, NODE_OPTIONS: "--no-experimental-sqlite" },
        encoding: "utf8", timeout: 15000, maxBuffer: 256 * 1024, windowsHide: true,
      });
      assert.equal(child.status, 0, child.error?.message ?? child.stderr);
      const out = JSON.parse(child.stdout);
      assert.equal(out.isError, false);
      assert.equal(out.hostImportError, "ERR_UNKNOWN_BUILTIN_MODULE");
      assert.match(out.workerError, /No such built-in module: node:sqlite/);
      assert.match(out.text, /SQLite inspection: unavailable — host Node SQLite backend unavailable/);
      assert.match(out.text, /requires Node 22\.16\+ with node:sqlite enabled/);
      assert.match(out.text, /Core ADB: available/);
      assert.match(out.text, new RegExp(`Audit status: ${deviceSqlite === "failed" ? "partial" : "complete"}`));
    });
  }

  await check("host mode reports its own backend even when the phone has sqlite3", async () => {
    process.env.DA_LOCAL = "false";
    try {
      const out = await fixture().run(); report(out, false);
      assert.match(out.text, /SQLite inspection: available — host Node SQLite backend available/);
      assert.doesNotMatch(out.text, /SQLite inspection: available — device sqlite3/);
    } finally { process.env.DA_LOCAL = "true"; }
  });

  await check("on-device mode requires sqlite3 even with Node SQLite available", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    assert.equal(typeof DatabaseSync, "function");
    const out = await fixture({ capabilities: defaults.capabilities.replace("sqlite3=1", "sqlite3=0") }).run(); report(out, false);
    assert.match(out.text, /SQLite inspection: unavailable — device sqlite3: unavailable/);
    assert.match(out.text, /Core ADB: available/);
  });

  await check("all probe failures produce a clearly partial report without false success", async () => {
    const errors = Object.fromEntries(Object.keys(defaults).map(key => [key, new Error("synthetic failure")]));
    const out = await fixture({ ...errors, devices: new Error("failed"), version: new Error("failed") }).run(); report(out);
    assert.doesNotMatch(out.text, /✓ |: available —/);
    assert.match(out.text, /Storage snapshot ──\ninconclusive/);
    assert.match(out.text, /Battery snapshot ──\ninconclusive/);
  });

  await check("an unfinished independent probe does not short-circuit collection", async () => {
    let release;
    const f = fixture({ "dumpsys battery": () => new Promise(resolve => { release = resolve; }), "ip route show": new Error("failed") });
    let settled = false;
    const pending = f.run().then(out => { settled = true; return out; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    release("level: 42");
    const out = await pending; report(out);
    assert.match(out.text, /level: 42/);
    assert.match(out.text, /Routes: probe failed/);
  });

  await check("raw exceptions do not leak through the probe-issues report", async () => {
    const out = await fixture({ "dumpsys battery": new Error("SECRET_CANARY\n✓ Battery: available\n" + "x".repeat(100000)) }).run(); report(out);
    assert.doesNotMatch(out.text, /SECRET_CANARY|✓ Battery: available/);
    assert.ok(out.text.length < 40000);
    assert.match(out.text, /Battery: probe failed/);
  });

  await check("verbose successful snapshots cannot crowd out other results or issues", async () => {
    const out = await fixture({ getprop: props.replace("FixturePhone", "x".repeat(45000)), "df -k /data /sdcard": "storage\n".repeat(6000), "dumpsys battery": new Error("failed") }).run(); report(out);
    assert.ok(out.text.length < 16000);
    assert.match(out.text, /Core ADB: available/);
    assert.match(out.text, /Battery: probe failed/);
    assert.match(out.text, /Battery snapshot ──\ninconclusive/);
  });
} finally {
  if (previousLocal === undefined) delete process.env.DA_LOCAL;
  else process.env.DA_LOCAL = previousLocal;
}

console.log(`\nRuntime Audit: ${passed} passed, ${failed} failed, 0 skipped (${passed + failed} total)`);
process.exitCode = failed ? 1 : 0;
