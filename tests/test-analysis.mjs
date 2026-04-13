/**
 * Analysis Test Suite — Comparative analysis, screenshot diffing, test generation,
 * RIL interception, and AT detection.
 * Tests tools that capture baselines then compare against them.
 */
import { createHarness } from "./lib/harness.mjs";

const h = await createHarness("Analysis & Comparison");

// ── Thermal Comparison ─────────────────────────────────────

h.section("Thermal Comparison");

// Capture a baseline first
await h.testContains("Thermal baseline (save)", "adb_thermal_snapshot",
  { save: true, label: "DA_test_baseline" }, "Saved");

await new Promise(r => setTimeout(r, 2000));

await h.testContains("Thermal compare", "adb_thermal_compare", {}, "Thermal Comparison");

// ── Snapshot Comparison ────────────────────────────────────

h.section("Snapshot Comparison");

// Capture a fresh snapshot for comparison
const snapRes = await h.testContains("Snapshot capture (for compare)", "adb_snapshot_capture",
  { name: "DA_compare_test" }, "Snapshot captured");

// Extract path from result
const snapText = h.getText(snapRes);
const snapPath = snapText?.match(/Snapshot captured:\s*(.+\.json)/)?.[1];

if (snapPath) {
  await h.testContains("Snapshot compare", "adb_snapshot_compare",
    { snapshotPath: snapPath }, "Comparing against");
} else {
  h.skip("Snapshot compare (no path extracted)");
}

// ── Regression Check ───────────────────────────────────────

h.section("Regression Check");

// Capture a baseline then immediately check against it
const regRes = await h.testContains("Regression baseline (for check)", "adb_regression_baseline",
  { packageName: "com.topjohnwu.magisk", label: "DA_check_test" }, "Saved");

const regText = h.getText(regRes);
const regPath = regText?.match(/Saved:\s*(.+\.json)/)?.[1];

if (regPath) {
  await h.testContains("Regression check", "adb_regression_check",
    { baselinePath: regPath, packageName: undefined }, "Comparing against");
} else {
  h.skip("Regression check (no path extracted)");
}

// ── Firmware Diff ──────────────────────────────────────────

h.section("Firmware Diff");

// Diff current against current — should be IDENTICAL
await h.testContains("Firmware diff (current vs current)", "adb_firmware_diff",
  { from: "current", to: "current" }, "IDENTICAL");

// ── Screenshot Diff Lifecycle ──────────────────────────────

h.section("Screenshot Diff Lifecycle");

await h.testContains("Screenshot baseline capture", "adb_screenshot_baseline",
  { name: "DA_test_baseline" }, "baseline saved");

// Immediate diff — screen may have minor dynamic element changes (clock, notifications, etc.)
// Use 5% pixel tolerance to absorb nav bar clock (~0.5%), notification badges, signal icon
// updates, and charging indicator changes that are more frequent on-device than ADB mode
await h.testContains("Screenshot diff (immediate)", "adb_screenshot_diff",
  { baseline: "DA_test_baseline", tolerancePercent: 5 }, "IDENTICAL");

await h.testContains("Screenshot history", "adb_screenshot_history", {}, "DA_test_baseline");

// ── Test Generation ────────────────────────────────────────

h.section("Test Generation");

// Ensure we're on the home screen for a predictable UI
await h.callTool("adb_shell", { command: "input keyevent KEYCODE_HOME" });
await new Promise(r => setTimeout(r, 1000));

await h.testContains("Test gen from UI", "adb_test_gen_from_ui",
  { packageName: "com.google.android.apps.nexuslauncher" }, "Generated test workflow");

await h.testContains("Test gen from intents (Magisk)", "adb_test_gen_from_intents",
  { packageName: "com.topjohnwu.magisk" }, "Generated intent test");

// Save a generated workflow
const simpleWf = JSON.stringify({
  name: "DA_save_test",
  description: "Test workflow save",
  steps: [{ name: "echo", action: "shell", command: "echo saved_ok" }],
});
await h.testContains("Test gen save", "adb_test_gen_save",
  { name: "DA_save_test", workflow: simpleWf }, "Workflow saved");

// ── RIL Intercept Lifecycle ────────────────────────────────

h.section("RIL Intercept Lifecycle");

const rilRes = await h.testContains("RIL start", "adb_ril_start",
  { bufferSize: 1000 }, "RIL capture started");

const rilId = h.getText(rilRes)?.match(/ril_\d+/)?.[0] ?? "ril_1";

// Let it accumulate for a few seconds
await new Promise(r => setTimeout(r, 3000));

await h.test("RIL poll", "adb_ril_poll",
  { session: rilId, maxMessages: 50 });

await h.testContains("RIL stop", "adb_ril_stop",
  { session: rilId }, "Stopped");

// ── AT Modem Detection ─────────────────────────────────────

h.section("AT Modem Detection");

await h.testContains("AT detect (Shannon)", "adb_at_detect", {}, "shannon");
await h.testContains("AT cross-validate", "adb_at_cross_validate", { timeout: 8000 }, "Cross-Validation", 60000);

// ── Permission Management ─────────────────────────────────

h.section("Permission Management");

// Grant a runtime permission to Magisk (safe, idempotent)
await h.test("Grant permission (Magisk)", "adb_grant_permission",
  { packageName: "com.topjohnwu.magisk", permission: "android.permission.POST_NOTIFICATIONS" });

// List permissions — verify output contains the summary header
await h.testContains("List permissions (Magisk)", "adb_list_permissions",
  { packageName: "com.topjohnwu.magisk", filter: "all" }, "permissions granted");

// List granted only — verify the filter param works
await h.testContains("List permissions → granted filter", "adb_list_permissions",
  { packageName: "com.topjohnwu.magisk", filter: "granted" }, "permissions granted");

// Revoke the permission we just granted (idempotent — Magisk works without it)
await h.test("Revoke permission (Magisk)", "adb_revoke_permission",
  { packageName: "com.topjohnwu.magisk", permission: "android.permission.POST_NOTIFICATIONS" });

// Re-grant to leave Magisk in original state
await h.test("Re-grant permission (cleanup)", "adb_grant_permission",
  { packageName: "com.topjohnwu.magisk", permission: "android.permission.POST_NOTIFICATIONS" });

const exitCode = h.finish();
process.exit(exitCode);
