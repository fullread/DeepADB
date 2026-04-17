/**
 * Monitoring & Workflows Test Suite — Logcat watchers, snapshots, OTA, regression, workflows.
 * Tests lifecycle operations: start → interact → stop patterns.
 */
import { createHarness } from "./lib/harness.mjs";

const h = await createHarness("Monitoring & Workflows");

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
