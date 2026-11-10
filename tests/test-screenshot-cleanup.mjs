// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/** Screenshot ownership, failure cleanup and registered-tool integration. No ADB. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { AdbBridge } from "../build/bridge/adb-bridge.js";
import { LocalBridge } from "../build/bridge/local-bridge.js";
import { registerUiTools } from "../build/tools/ui.js";
import { registerTestingTools } from "../build/tools/testing.js";
import { registerInputGestureTools } from "../build/tools/input-gestures.js";
import { registerScreenshotDiffTools } from "../build/tools/screenshot-diff.js";
import { registerWorkflowTools } from "../build/tools/workflow.js";
import { encodePng } from "../build/middleware/png-utils.js";

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${label}`); }
  catch (error) { failed++; console.error(`  ✗ ${label}: ${error.stack}`); }
}
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const ok = (extra = {}) => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, bufferExceeded: false, ...extra });
const directoryPattern = /^\/data\/local\/tmp\/DA_screenshot_[a-f0-9]{32}$/;
const unquote = s => s.slice(1, -1).replaceAll("'\\''", "'");

// Enforce identity-based directory access, rather than merely counting rm calls.
// Inject below the real bridge's routing/elevation logic so mismatched privilege
// contexts fail just as they do when Termux tries to remove a root-owned file.
function device(mode = "adb", faults = {}) {
  const directories = new Map(), calls = [], captures = [], pulls = [];
  const bridge = mode === "adb" ? new AdbBridge(logger) : new LocalBridge(logger);
  if (mode !== "adb") bridge.rootAvailable = mode !== "unprivileged";
  async function execute(command, identity, options) {
    calls.push({ command, identity, options });
    if (command.startsWith("mkdir ")) {
      const directory = command.match(/'([^']+)'/)[1];
      assert.match(directory, directoryPattern);
      assert.match(command, /^mkdir -m 700 -- /);
      if (faults.allocate) throw new Error("File exists (unowned directory/symlink)");
      assert.ok(!directories.has(directory));
      directories.set(directory, { identity, file: false });
      return ok();
    }
    if (command.includes("screencap -p ")) {
      const path = command.match(/'([^']+)'/)[1];
      const entry = directories.get(path.slice(0, path.lastIndexOf("/")));
      assert.equal(entry?.identity, identity, "capture must use the allocating identity");
      assert.equal(entry.file, false, "never overwrite an old file");
      entry.file = true; captures.push(path);
      if (faults.capture) throw new Error("capture permission denied");
      return ok(faults.captureResult);
    }
    if (command.startsWith("rm ")) {
      const [, path, directory] = command.match(/^rm -f -- '([^']+)' && rmdir -- '([^']+)'$/) ?? [];
      assert.match(directory, directoryPattern);
      assert.equal(path, `${directory}/capture.png`);
      assert.equal(directories.get(directory)?.identity, identity, "cleanup permission denied");
      if (faults.cleanup) throw new Error("cleanup permission denied");
      if (faults.cleanupResult) return ok(faults.cleanupResult);
      directories.delete(directory);
      return ok();
    }
    throw new Error(`Unexpected shell command: ${command}`);
  }
  async function pull(args, options) {
    assert.equal(args[0], "pull");
    assert.equal(directories.get(args[1].slice(0, args[1].lastIndexOf("/")))?.file, true);
    pulls.push({ args, options });
    if (faults.pull) throw new Error("pull transport failed");
    return ok(faults.pullResult);
  }
  if (mode === "adb") bridge.exec = (args, options) => args[0] === "shell" ? execute(args[1], "shell", options) : pull(args, options);
  else {
    bridge.execLocal = (command, options) => {
      if (command.startsWith("su -c 'cat ")) {
        assert.match(command, /' > '/, "pull redirect stays outside su, preserving Termux ownership");
        const [, path, destination] = command.match(/^su -c 'cat ([^']+)' > '([^']+)'$/);
        return pull(["pull", path, destination], options);
      }
      if (command.startsWith("cp -f ")) {
        const [, path, destination] = command.match(/^cp -f '([^']+)' '([^']+)'$/);
        return pull(["pull", path, destination], options);
      }
      return command.startsWith("su -c ")
        ? execute(unquote(command.slice(6)), "root", options)
        : execute(command, "termux", options);
    };
    bridge.execViaAdb = (args, options) => args[0] === "shell" ? execute(args[1], "guest-shell", options) : pull(args, options);
  }
  return { bridge, directories, calls, captures, pulls };
}

for (const [mode, identity] of [["adb", "shell"], ["local", "root"], ["unprivileged", "termux"], ["guest", "guest-shell"]]) {
  await check(`${mode}: capture and cleanup share identity and preserve the destination`, async () => {
    const f = device(mode), serial = mode === "guest" ? "localhost:5557" : "fixture";
    if (mode === "guest") LocalBridge.registerGuestDevice(serial);
    try {
      await f.bridge.captureScreenshot("saved.png", { device: serial });
      assert.equal(f.directories.size, 0);
      assert.deepEqual(f.calls.map(c => c.identity), [identity, identity, identity]);
      assert.equal(f.pulls[0].args[2], "saved.png");
      for (const c of [...f.calls, ...f.pulls]) {
        assert.equal(c.options.device, serial);
        assert.equal(c.options.retries, 0);
        assert.ok(c.options.timeout > 0 && c.options.timeout <= 30000);
        assert.ok(!c.options.ignoreExitCode);
      }
    } finally { if (mode === "guest") LocalBridge.unregisterGuestDevice(serial); }
  });
}
await check("Concurrent captures and separate bridges never share device paths", async () => {
  const a = device(), b = device("local");
  const clock = Date.now; Date.now = () => 42;
  try {
    await Promise.all(Array.from({ length: 32 }, (_, i) => (i % 2 ? a : b).bridge.captureScreenshot("DA_test_screenshot.png")));
    const paths = [...a.captures, ...b.captures];
    assert.equal(new Set(paths).size, 32);
    assert.ok(paths.every(p => !p.includes("DA_test_screenshot") && !p.includes("DA_test_001")));
    assert.equal(a.directories.size + b.directories.size, 0);
  } finally { Date.now = clock; }
});
await check("Allocation failure never captures, pulls, or removes someone else's directory", async () => {
  const f = device("local", { allocate: true });
  await assert.rejects(f.bridge.captureScreenshot("saved.png"), /File exists/);
  assert.equal(f.calls.length, 1); assert.equal(f.pulls.length, 0);
});
for (const mode of ["adb", "local"]) {
  for (const failure of ["capture", "pull"]) {
    await check(`${mode}: ${failure} failure still removes its private scratch files`, async () => {
      const f = device(mode, { [failure]: true });
      await assert.rejects(f.bridge.captureScreenshot("saved.png"), new RegExp(failure));
      assert.equal(f.directories.size, 0);
      assert.equal(f.calls.at(-1).identity, mode === "adb" ? "shell" : "root");
    });
  }
}
for (const [stage, result] of [["captureResult", { timedOut: true }], ["pullResult", { bufferExceeded: true }], ["pullResult", { exitCode: 1, stderr: "copy failed" }]]) {
  await check(`Incomplete ${stage} (${Object.keys(result)[0]}) cannot report success`, async () => {
    const f = device("local", { [stage]: result });
    await assert.rejects(f.bridge.captureScreenshot("saved.png"), /Screenshot .* failed/);
    assert.equal(f.directories.size, 0);
  });
}
await check("Cleanup failure is visible even after a successful pull", async () => {
  const f = device("local", { cleanupResult: { exitCode: 1, stderr: "permission denied" } });
  await assert.rejects(f.bridge.captureScreenshot("saved.png"), /Screenshot cleanup failed for \/data\/local\/tmp\/DA_screenshot_.*permission denied/);
  assert.equal(f.pulls.length, 1);
});
await check("Capture and cleanup failures are both retained", async () => {
  const f = device("local", { capture: true, cleanup: true });
  await assert.rejects(f.bridge.captureScreenshot("saved.png"), error => {
    assert.match(error.message, /capture permission denied; Screenshot cleanup failed/);
    assert.match(error.message, /cleanup permission denied/);
    assert.match(error.errors[0].message, /capture permission denied/);
    assert.match(error.cause.message, /cleanup permission denied/);
    return true;
  });
});
await check("Ordinary rm commands do not acquire root privileges", async () => {
  const bridge = new LocalBridge(logger); bridge.rootAvailable = true;
  let observed;
  bridge.execLocal = async command => { observed = command; return ok(); };
  await bridge.shell("rm -f /data/local/tmp/user-owned.png");
  assert.equal(observed, "rm -f /data/local/tmp/user-owned.png");
});

const root = mkdtempSync(join(tmpdir(), "deepadb-screenshot-test-"));
try {
  const handlers = new Map(), captures = [];
  let failCapture = false;
  const png = encodePng(2, 2, Buffer.alloc(12, 100), 3);
  const ctx = {
    server: { registerTool(name, options, handler) { handlers.set(name, { options, handler }); } },
    config: { tempDir: root }, logger, security: { checkCommand() { return null; } },
    deviceManager: { async resolveDevice() { return { serial: "fixture" }; } },
    bridge: {
      async captureScreenshot(path, options) {
        captures.push({ path, options });
        if (failCapture) throw new Error("Screenshot cleanup failed for test scratch directory");
        writeFileSync(path, png);
      },
      async shell(command) {
        if (command === "wm size") return ok({ stdout: "Physical size: 2x2" });
        if (command.startsWith("cat ")) return ok({ stdout: '<hierarchy><node text="Target" clickable="true" bounds="[0,0][1,1]" /></hierarchy>' });
        if (/^(uiautomator dump |rm |logcat )/.test(command)) return ok();
        throw new Error(`Unexpected shell command: ${command}`);
      },
    },
  };
  for (const register of [registerUiTools, registerTestingTools, registerInputGestureTools, registerScreenshotDiffTools, registerWorkflowTools]) register(ctx);
  async function run(name, args = {}) {
    const { options, handler } = handlers.get(name);
    return handler(options.inputSchema.parse(args));
  }
  assert.ok(!(await run("adb_test_session_start", { name: "scratch" })).isError);
  const cases = [
    ["adb_screencap", { filename: "my-shot.png" }, /Screenshot saved:/],
    ["adb_screencap_annotated", { filename: "annotated.png" }, /Annotated screenshot:/],
    ["adb_test_step", { description: "step", captureLogcat: false }, /Screenshot: 001_step.png/],
    ["adb_screenshot_compressed", { filename: "compressed.jpg" }, /2x2.*KB PNG/],
    ["adb_screenshot_baseline", { name: "stable" }, /Screenshot baseline saved:/],
    ["adb_screenshot_diff", { baseline: "stable" }, /IDENTICAL/],
    ["adb_workflow_run", { workflow: JSON.stringify({ name: "shot", steps: [{ name: "capture", action: "screenshot" }] }) }, /1 steps run, 0 failed/],
  ];
  for (const [name, args, expected] of cases) {
    await check(`${name} uses checked capture and preserves its result contract`, async () => {
      const before = captures.length, response = await run(name, args);
      assert.ok(!response.isError, JSON.stringify(response));
      assert.match(response.content.map(c => c.text).join("\n"), expected);
      assert.equal(captures.length, before + 1);
      assert.equal(captures.at(-1).options.device, "fixture");
      if (name === "adb_screenshot_diff") assert.equal(existsSync(captures.at(-1).path), false, "diff also removes its host scratch file");
      else assert.ok(readFileSync(captures.at(-1).path).length > 0);
    });
  }
  failCapture = true;
  for (const [name, args] of cases) {
    await check(`${name} surfaces cleanup errors instead of claiming screenshot success`, async () => {
      const response = await run(name, args);
      const text = response.content.map(c => c.text).join("\n");
      // Workflows preserve per-step failure reporting in their aggregate result.
      if (name === "adb_workflow_run") assert.match(text, /1 steps run, 1 failed/);
      else assert.equal(response.isError, true);
      assert.match(text, /Screenshot cleanup failed/);
    });
  }
  assert.ok(!(await run("adb_test_session_end")).isError);
} finally {
  const target = resolve(root);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith("deepadb-screenshot-test-"));
  rmSync(target, { recursive: true, force: true });
}
console.log(`Screenshot cleanup: ${passed} passed, ${failed} failed, 0 skipped (${passed + failed} total)`);
process.exitCode = failed ? 1 : 0;
