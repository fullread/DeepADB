// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Failure evidence must not touch hardware or weaken the fixture assertions. */
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { collectFixtureDiagnostics, DIAGNOSTIC_IMAGE_BYTES, DIAGNOSTIC_TEXT_BYTES, DIAGNOSTIC_TIMEOUT_MS, runDiagnosticProbe } from "../lib/fixture-diagnostics.mjs";
import { requireFixtureScreen as requirePixelFixtureScreen } from "../lib/test-profile.mjs";
import { FIXTURE_PACKAGE } from "../lib/test-profile.mjs";
import { withFixture } from "../run-emulator.mjs";

// Isolate the module's immutable profile without changing the regular test import.
const previousProfile = process.env.DA_TEST_PROFILE;
let requireEmulatorFixtureScreen;
try {
  process.env.DA_TEST_PROFILE = "emulator";
  ({ requireFixtureScreen: requireEmulatorFixtureScreen } = await import("../lib/test-profile.mjs?diagnostics-emulator"));
} finally {
  if (previousProfile === undefined) delete process.env.DA_TEST_PROFILE;
  else process.env.DA_TEST_PROFILE = previousProfile;
}

function fixture(t) {
  const root = resolve(tmpdir());
  const directory = mkdtempSync(join(root, "deepadb-fixture-diagnostics-"));
  t.after(() => {
    assert.equal(dirname(directory), root);
    assert.ok(basename(directory).startsWith("deepadb-fixture-diagnostics-"));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    env: { DA_TEST_PROFILE: "emulator", DA_DEVICE: "emulator-5554", ADB_PATH: "unused-adb",
      DA_TEMP_DIR: directory, DA_EMULATOR_DIAGNOSTICS_DIR: join(directory, "fixture-diagnostics"),
      SECRET_SENTINEL: "must-not-be-in-artifacts" },
  };
}

const probeSuccess = (stdout = "evidence") => ({ ok: true, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), timedOut: false, truncated: false, error: null });
function harness({ launch = { text: "Status: ok" }, ready = { text: "Found" }, thrown } = {}) {
  const calls = [];
  return { calls,
    async callTool(name, args) {
      calls.push([name, args]);
      if (thrown && name === "adb_wait_element") throw thrown;
      return name === "adb_shell" ? launch : ready;
    },
    getText: response => response.text,
    isError: response => !!response.error,
  };
}

test("successful fixture checks collect no diagnostics and keep their existing wait", async () => {
  const h = harness();
  await requireEmulatorFixtureScreen(h, "main", () => assert.fail("no failure evidence on success"));
  assert.deepEqual(h.calls.map(c => c[0]), ["adb_shell", "adb_wait_element"]);
  assert.deepEqual(h.calls[1][1], { text: "DeepADB Fixture", timeoutMs: 15000 });
});

test("fixture failure keeps the identical primary error even if diagnostics fail", async () => {
  const primary = new Error("original MCP timeout");
  const h = harness({ thrown: primary });
  let received;
  await assert.rejects(requireEmulatorFixtureScreen(h, "main", async evidence => {
    received = evidence;
    throw new Error("diagnostics disk failure");
  }), error => error === primary);
  assert.equal(received.error, primary);
  assert.equal(received.launchOutput, "Status: ok");
  assert.equal(received.waitOutput, "");
  assert.equal(h.calls.length, 2, "must not retry or relaunch");
});

test("launch and returned readiness errors both retain available tool output", async () => {
  for (const options of [
    { launch: { text: "launch stderr", error: true } },
    { ready: { text: "wait timeout", error: true } },
  ]) {
    const h = harness(options);
    let evidence;
    await assert.rejects(requireEmulatorFixtureScreen(h, "input", async info => {
      evidence = info; return { skipped: "unit test" };
    }), error => error === evidence.error);
    assert.equal(evidence.screen, "input");
    if (options.launch) {
      assert.equal(evidence.launchOutput, "launch stderr");
      assert.equal(h.calls.length, 1);
    } else {
      assert.equal(evidence.waitOutput, "wait timeout");
      assert.equal(h.calls.length, 2);
    }
  }
});

test("strict Pixel failure never invokes emulator diagnostic collection", async () => {
  const primary = new Error("Pixel failure");
  await assert.rejects(requirePixelFixtureScreen(harness({ thrown: primary }), "main",
    () => assert.fail("Pixel must not collect emulator evidence")), error => error === primary);
});

test("invalid profiles, serials and output paths perform no ADB or artifact writes", async t => {
  const f = fixture(t);
  for (const change of [
    { DA_TEST_PROFILE: "pixel" }, { DA_TEST_PROFILE: "unknown" },
    { DA_DEVICE: "Pixel6a" }, { DA_DEVICE: "" }, { DA_DEVICE: "emulator-5554;echo invalid" },
    { ADB_PATH: "" }, { DA_TEMP_DIR: "relative" },
    { DA_EMULATOR_DIAGNOSTICS_DIR: "" },
    { DA_EMULATOR_DIAGNOSTICS_DIR: join(f.directory, "outside") },
  ]) {
    const result = await collectFixtureDiagnostics({ env: { ...f.env, ...change }, error: new Error("fixture failed"),
      runProbe: () => assert.fail("invalid diagnostic target must not execute") });
    assert.ok(result.skipped);
    assert.deepEqual(readdirSync(f.directory), []);
  }
});

test("a linked diagnostic directory cannot run ADB or write outside its run", async t => {
  const f = fixture(t);
  const outside = fixture(t);
  const link = f.env.DA_EMULATOR_DIAGNOSTICS_DIR;
  const sentinel = join(outside.directory, "sentinel.txt");
  writeFileSync(sentinel, "preserve outside data");
  symlinkSync(outside.directory, link, process.platform === "win32" ? "junction" : "dir");
  try {
    assert.equal(dirname(link), f.directory);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(realpathSync(link), realpathSync(outside.directory));
    const result = await collectFixtureDiagnostics({ env: f.env, error: new Error("fixture failed"),
      runProbe: () => assert.fail("a linked output directory must not execute ADB") });
    assert.match(result.skipped, /not a private run directory/);
    assert.deepEqual(readdirSync(outside.directory), ["sentinel.txt"]);
    assert.equal(readFileSync(sentinel, "utf8"), "preserve outside data");
    assert.deepEqual(readdirSync(f.directory), ["fixture-diagnostics"]);
  } finally {
    // Remove only the link, never recurse through it into the other fixture.
    assert.equal(dirname(link), f.directory);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    unlinkSync(link);
  }
  assert.deepEqual(readdirSync(f.directory), []);
  assert.equal(readFileSync(sentinel, "utf8"), "preserve outside data");
});

test("partial evidence is serial-pinned, bounded and excludes the environment", async t => {
  const f = fixture(t);
  const calls = [];
  const result = await collectFixtureDiagnostics({ env: f.env, error: new Error("not ready"), screen: "main",
    launchOutput: "L".repeat(DIAGNOSTIC_TEXT_BYTES + 20), waitOutput: "wait timeout",
    async runProbe(binary, args, limits) {
      calls.push({ binary, args, limits });
      if (args.includes("window")) throw new Error("window probe failed");
      if (args.includes("uiautomator")) return { ...probeSuccess("partial XML"), ok: false, timedOut: true,
        stderr: Buffer.from("UI probe timeout"), error: { message: "timed out" } };
      return probeSuccess(args.includes("screencap") ? Buffer.from([137, 80, 78, 71]) : "other evidence");
    },
  });
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.equal(call.binary, "unused-adb");
    assert.deepEqual(call.args.slice(0, 2), ["-s", "emulator-5554"]);
    assert.equal(call.limits.timeoutMs, DIAGNOSTIC_TIMEOUT_MS);
    assert.equal(call.limits.maxBytes, call.args.includes("screencap") ? DIAGNOSTIC_IMAGE_BYTES : DIAGNOSTIC_TEXT_BYTES);
    assert.ok(!call.args.includes("su"));
  }
  const record = JSON.parse(readFileSync(join(result.directory, "failure.json"), "utf8"));
  assert.equal(record.failure.message, "not ready");
  assert.equal(record.probes.window.commandSucceeded, false);
  assert.equal(record.probes.ui.timedOut, true);
  assert.equal(record.probes.screenshot.commandSucceeded, true);
  assert.equal(readFileSync(join(result.directory, "ui.stdout.txt"), "utf8"), "partial XML");
  assert.equal(readFileSync(join(result.directory, "ui.stderr.txt"), "utf8"), "UI probe timeout");
  assert.equal(statSync(join(result.directory, "launch.txt")).size, DIAGNOSTIC_TEXT_BYTES);
  for (const file of readdirSync(result.directory)) {
    assert.ok(!readFileSync(join(result.directory, file)).includes(Buffer.from(f.env.SECRET_SENTINEL)));
  }
});

test("each failure uses a separate directory and collection has a per-run cap", async t => {
  const f = fixture(t);
  const directories = new Set();
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await collectFixtureDiagnostics({ env: f.env, error: new Error("failed"), runProbe: async () => probeSuccess() });
    assert.ok(result.directory);
    directories.add(result.directory);
  }
  assert.equal(directories.size, 8);
  const limited = await collectFixtureDiagnostics({ env: f.env, error: new Error("failed"),
    runProbe: () => assert.fail("capture cap must not execute another probe") });
  assert.match(limited.skipped, /limit/);
});

test("real subprocess timeout retains partial stdout and stderr", async () => {
  const started = Date.now();
  const result = await runDiagnosticProbe(process.execPath,
    ["-e", "process.stdout.write('partial stdout'); process.stderr.write('partial stderr'); setInterval(()=>{},1000)"],
    { timeoutMs: 1000, maxBytes: 4096 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.stdout.toString(), "partial stdout");
  assert.equal(result.stderr.toString(), "partial stderr");
  assert.ok(Date.now() - started < 10000);
});

test("real subprocess output overflow is capped and is not reported as success", async () => {
  const result = await runDiagnosticProbe(process.execPath,
    ["-e", "process.stdout.write('x'.repeat(1024*1024)); setInterval(()=>{},1000)"],
    { timeoutMs: 5000, maxBytes: 1024 });
  assert.equal(result.ok, false);
  assert.equal(result.truncated, true);
  assert.equal(result.error.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  assert.ok(result.stdout.length <= 1024);
});

test("failed diagnostic storage never prevents fixture uninstall", async t => {
  const f = fixture(t);
  writeFileSync(f.env.DA_EMULATOR_DIAGNOSTICS_DIR, "not a directory");
  const primary = new Error("fixture timeout");
  const calls = [];
  const adb = args => {
    const command = args.join(" "); calls.push(command);
    if (command.includes("getprop")) return "1";
    if (command.includes("pm list packages")) return "";
    if (command.includes("pm path")) return "package:/data/app/test/base.apk";
    return "Success";
  };
  await assert.rejects(withFixture(adb, "fixture.apk", () => requireEmulatorFixtureScreen(
    harness({ thrown: primary }), "main", evidence => collectFixtureDiagnostics({ ...evidence, env: f.env,
      runProbe: () => assert.fail("invalid storage cannot run probes") }))), error => error === primary);
  assert.equal(calls.at(-1), `uninstall ${FIXTURE_PACKAGE}`);
});
