// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Monitoring & Workflows Test Suite — Logcat watchers, snapshots, OTA, regression, workflows.
 * Tests lifecycle operations: start → interact → stop patterns.
 */
import { createHarness } from "./lib/harness.mjs";
import { parseMemoryKb, parseCpuPercent, parseFrameStats } from "../build/tools/regression.js";

const h = await createHarness("Monitoring & Workflows");

// ── AU7 Regression Parser Unit Tests ──────────────────────────
// Synthesized dumpsys output across Android version variants. The parsers
// must produce the expected values for each version, or the parser hardening
// regresses silently. These are pure unit tests — no device required.

h.section("AU7: Regression Parsers (Android version coverage)");

// parseMemoryKb fixtures — dumpsys meminfo "TOTAL" line variants
const memA11 = `** MEMINFO in pid 1234 [com.example.app] **
                   Pss  Private  Private     Swap      Rss     Heap     Heap     Heap
                 Total    Dirty    Clean    Dirty    Total     Size    Alloc     Free
                ------   ------   ------   ------   ------   ------   ------   ------
  Native Heap    12345    12000      0         0    24000    32000    20000    12000
                   ====
         TOTAL:   215644   TOTAL SWAP PSS:        0`;

const memA12 = `** MEMINFO in pid 1234 [com.example.app] **
                   Pss  Private  Private     Swap      Rss     Heap     Heap     Heap
                 Total    Dirty    Clean    Dirty    Total     Size    Alloc     Free
                ------   ------   ------   ------   ------   ------   ------   ------
  Native Heap    12345    12000      0         0    24000    32000    20000    12000
                   ====
         TOTAL PSS:   215644            TOTAL RSS:   281392     TOTAL SWAP PSS:       0`;

const memA13 = `** MEMINFO in pid 1234 [com.example.app] **
  Native Heap    12345    12000      0         0    24000    32000    20000    12000
                   ====
         TOTAL PSS:   194512            TOTAL RSS:   263460     TOTAL SWAP PSS:    1234`;

const memA14 = `** MEMINFO in pid 1234 [com.example.app] **
  Native Heap    12345    12000      0         0    24000    32000    20000    12000
                   ====
         TOTAL PSS:   178900            TOTAL RSS:   245112     TOTAL SWAP PSS:     876`;

h.assertEq("parseMemoryKb: A11 'TOTAL:' format", parseMemoryKb(memA11), 215644);
h.assertEq("parseMemoryKb: A12 'TOTAL PSS:' format", parseMemoryKb(memA12), 215644);
h.assertEq("parseMemoryKb: A13 'TOTAL PSS:' format", parseMemoryKb(memA13), 194512);
h.assertEq("parseMemoryKb: A14 'TOTAL PSS:' format", parseMemoryKb(memA14), 178900);
h.assertEq("parseMemoryKb: empty input returns null", parseMemoryKb(""), null);
h.assertEq("parseMemoryKb: no TOTAL line returns null", parseMemoryKb("garbage output\nno total here"), null);

// parseCpuPercent fixtures — dumpsys cpuinfo line variants
const cpuA11 = `Load: 1.23 / 0.97 / 0.85
CPU usage from 4567ms to 0ms ago (2024-01-15 10:30:45.123 to 2024-01-15 10:30:49.690):
  3.4% 12345/com.example.app: 2.1% user + 1.3% kernel / faults: 1234 minor 5 major
  1.8% 6789/system_server: 1.2% user + 0.6% kernel / faults: 567 minor`;

const cpuA12 = `CPU usage from 4567ms to 0ms ago:
  5.2% 12345/com.example.app: 3.4% user + 1.8% kernel
  2.1% 6789/system_server: 1.5% user + 0.6% kernel`;

const cpuA13 = `CPU usage from 4567ms to 0ms ago:
  4.7% 12345/com.example.app: 3.1% user + 1.6% kernel / faults: 234 minor
  1.9% 6789/system_server: 1.3% user + 0.6% kernel`;

h.assertEq("parseCpuPercent: A11 format", parseCpuPercent(cpuA11, "com.example.app"), 3.4);
h.assertEq("parseCpuPercent: A12 format", parseCpuPercent(cpuA12, "com.example.app"), 5.2);
h.assertEq("parseCpuPercent: A13 format", parseCpuPercent(cpuA13, "com.example.app"), 4.7);
h.assertEq("parseCpuPercent: package not present returns null", parseCpuPercent(cpuA13, "com.nonexistent"), null);
h.assertEq("parseCpuPercent: integer percentage parses correctly",
  parseCpuPercent("  7% 12345/com.test:", "com.test"), 7);
h.assertEq("parseCpuPercent: dotted package name escapes regex chars",
  parseCpuPercent("  2.5% 999/co.uk.example.app:", "co.uk.example.app"), 2.5);

// parseFrameStats fixtures — dumpsys gfxinfo format
const gfxA11 = `Stats since: 12345678901ns
Total frames rendered: 1234
Janky frames: 56 (4.54%)
50th percentile: 8ms
90th percentile: 15ms`;

const gfxA13 = `Stats since: 12345678901ns
Total frames rendered: 9999
Janky frames: 123 (1.23%)
50th percentile: 6ms
99th percentile: 33ms`;

const gfxEmpty = "Stats since: 12345ns\n(no frames data)";

const gfxA11Result = parseFrameStats(gfxA11);
h.assertEq("parseFrameStats: A11 total", gfxA11Result.total, 1234);
h.assertEq("parseFrameStats: A11 janky", gfxA11Result.janky, 56);

const gfxA13Result = parseFrameStats(gfxA13);
h.assertEq("parseFrameStats: A13 total", gfxA13Result.total, 9999);
h.assertEq("parseFrameStats: A13 janky", gfxA13Result.janky, 123);

const gfxEmptyResult = parseFrameStats(gfxEmpty);
h.assertEq("parseFrameStats: no frames data → total null", gfxEmptyResult.total, null);
h.assertEq("parseFrameStats: no frames data → janky null", gfxEmptyResult.janky, null);


// ── Logcat Snapshots ───────────────────────────────────────

h.section("Logcat Snapshots");
await h.test("Logcat Clear", "adb_logcat_clear");
await h.test("Logcat (100 lines)", "adb_logcat", { lines: 100 });
await h.test("Logcat (priority W+)", "adb_logcat", { lines: 50, priority: "W" });
await h.test("Logcat (crash buffer)", "adb_logcat_crash", { lines: 20 });

// ── Logcat Watcher Lifecycle ───────────────────────────────

h.section("Logcat Watcher Lifecycle");
const startRes = await h.testContains("Watcher Start", "adb_logcat_start", { bufferSize: 500 }, "Logcat watcher started");
const watcherId = h.getText(startRes)?.match(/watch_\d+/)?.[0] ?? "watch_1";

await h.testContains("Watcher Sessions", "adb_logcat_sessions", {}, watcherId);

// Generate some logcat activity then poll
await h.callTool("adb_shell", { command: "log -t DA_TEST 'DeepADB watcher test message'" });
// Brief wait for logcat to accumulate
await new Promise(r => setTimeout(r, 1500));

await h.test("Watcher Poll", "adb_logcat_poll", { session: watcherId, maxLines: 50 });
await h.testContains("Watcher Stop", "adb_logcat_stop", { session: watcherId }, "Stopped");
await h.testContains("Watcher Sessions (empty)", "adb_logcat_sessions", {}, "No active");

// ── Snapshot Capture ───────────────────────────────────────

h.section("Device Snapshots");
await h.testContains("Snapshot Capture", "adb_snapshot_capture", { name: "DA_test_snapshot" }, "Snapshot captured");

// ── OTA Fingerprint ────────────────────────────────────────

h.section("OTA Monitoring");
await h.testContains("OTA Fingerprint", "adb_ota_fingerprint", { label: "DA_test" }, "fingerprint captured");
await h.testContains("OTA Check", "adb_ota_check", {}, "OTA Update Check");
await h.testContains("OTA History", "adb_ota_history", {}, "fingerprint");

// ── Regression Baseline ────────────────────────────────────

h.section("Regression Detection");
await h.testContains("Regression Baseline (Magisk)", "adb_regression_baseline",
  { packageName: "com.topjohnwu.magisk", label: "DA_test" }, "Baseline captured");
await h.test("Regression History", "adb_regression_history", { packageName: "com.topjohnwu.magisk" });

// ── Firmware Analysis ──────────────────────────────────────

h.section("Firmware Analysis");
await h.testContains("Firmware Probe", "adb_firmware_probe", {}, "Firmware Analysis");
await h.test("Firmware History", "adb_firmware_history", {});

// ── Workflow Engine ────────────────────────────────────────

h.section("Workflow Engine");

const simpleWorkflow = JSON.stringify({
  name: "af-test-workflow",
  description: "Test workflow for validation",
  variables: {},
  steps: [
    { name: "echo_test", action: "shell", command: "echo workflow_success_12345", capture: "result" },
    { name: "pause", action: "sleep", ms: 500 },
    { name: "check_prop", action: "getprop", key: "ro.product.model", capture: "model" },
  ],
});

await h.testContains("Workflow Validate", "adb_workflow_validate", { workflow: simpleWorkflow }, "Validation PASSED");
await h.testContains("Workflow Dry Run", "adb_workflow_run", { workflow: simpleWorkflow, dryRun: true }, "DRY RUN");
await h.testContains("Workflow Execute", "adb_workflow_run", { workflow: simpleWorkflow }, "workflow_success_12345");
await h.test("Workflow List", "adb_workflow_list");

// ── Test invalid workflow ──────────────────────────────────
const badWorkflow = JSON.stringify({ name: "bad", steps: [{ name: "x", action: "invalid_action" }] });
await h.testRejects("Workflow Validate (bad action)", "adb_workflow_validate", { workflow: badWorkflow });

// ── Plugin System ──────────────────────────────────────────

h.section("Plugin System");
await h.testContains("Plugin List", "adb_plugin_list", {}, "No plugins");
await h.testContains("Plugin Info", "adb_plugin_info", {}, "Plugin System");

// ── CI Readiness ───────────────────────────────────────────

h.section("CI Integration");
await h.testContains("CI Device Ready", "adb_ci_device_ready", {}, "CI Readiness");

const exitCode = h.finish();
process.exit(exitCode);
