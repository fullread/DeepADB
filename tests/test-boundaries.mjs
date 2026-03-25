/**
 * Boundary & Error Handling Test Suite — Edge cases, Zod bounds enforcement,
 * input injection via adb_input, error paths, and tools with zero prior coverage.
 *
 * These tests validate defensive boundaries without requiring a connected device
 * for most checks (Zod rejection happens before device communication).
 */
import { createHarness } from "./lib/harness.mjs";

const h = await createHarness("Boundaries & Error Handling");

// ══════════════════════════════════════════════════════════
// Zod Parameter Boundary Enforcement
// Verify that values at/beyond .min()/.max() are rejected
// ══════════════════════════════════════════════════════════

h.section("Zod Boundary — Numeric Limits");

// adb_shell timeout: .min(1000).max(600000)
await h.testRejects("Shell timeout below min (100ms)",
  "adb_shell", { command: "echo test", timeout: 100 });

await h.testRejects("Shell timeout above max (999999ms)",
  "adb_shell", { command: "echo test", timeout: 999999 });

// adb_cat maxLines: .min(1).max(10000)
await h.testRejects("Cat maxLines below min (0)",
  "adb_cat", { path: "/dev/null", maxLines: 0 });

await h.testRejects("Cat maxLines above max (99999)",
  "adb_cat", { path: "/dev/null", maxLines: 99999 });

// adb_top count: .min(1).max(100)
await h.testRejects("Top count below min (0)",
  "adb_top", { count: 0 });

await h.testRejects("Top count above max (999)",
  "adb_top", { count: 999 });

// adb_battery_drain durationMs: .min(3000).max(60000)
await h.testRejects("Battery drain duration below min (100ms)",
  "adb_battery_drain", { durationMs: 100 });

await h.testRejects("Battery drain duration above max (999999ms)",
  "adb_battery_drain", { durationMs: 999999 });

// adb_logcat lines: .min(1).max(10000)
await h.testRejects("Logcat lines below min (0)",
  "adb_logcat", { lines: 0 });

await h.testRejects("Logcat lines above max (99999)",
  "adb_logcat", { lines: 99999 });

// adb_at_send timeout: .min(1000).max(30000)
await h.testRejects("AT timeout below min (100ms)",
  "adb_at_send", { command: "AT", timeout: 100 });

await h.testRejects("AT timeout above max (99999ms)",
  "adb_at_send", { command: "AT", timeout: 99999 });

// adb_at_batch commands: .min(1).max(50)
await h.testRejects("AT batch empty commands array",
  "adb_at_batch", { commands: [] });

h.section("Zod Boundary — Port Ranges");

// adb_network_scan ports: .min(1).max(65535) per element, .max(20) array
await h.testRejects("Network scan port below min (0)",
  "adb_network_scan", { ports: [0] });

await h.testRejects("Network scan port above max (99999)",
  "adb_network_scan", { ports: [99999] });

// ══════════════════════════════════════════════════════════
// Input Injection via adb_input
// The text type should be shell-escaped, not injected
// ══════════════════════════════════════════════════════════

h.section("Input Type Validation");

// tap/swipe: only numeric coordinates allowed
await h.testRejects("Input tap with injection",
  "adb_input", { type: "tap", args: "100 200; rm -rf /" });

await h.testRejects("Input swipe with injection",
  "adb_input", { type: "swipe", args: "100 200 300 400$(whoami)" });

// keyevent: only alphanumeric keycodes
await h.testRejects("Input keyevent with injection",
  "adb_input", { type: "keyevent", args: "KEYCODE_HOME;id" });

// ══════════════════════════════════════════════════════════
// Error Handling — Invalid Arguments
// ══════════════════════════════════════════════════════════

h.section("Error Paths");

// Invalid device serial
await h.testRejects("Invalid device serial",
  "adb_device_info", { device: "nonexistent_device_12345" });

// Package operations on nonexistent package — tool succeeds with empty dumpsys output
// (this is correct behavior; dumpsys returns empty, not an error)
await h.test("Package info for nonexistent package (graceful)",
  "adb_package_info", { packageName: "com.nonexistent.fake.package.xyz" });

// getprop with empty key
await h.testRejects("Settings get with empty key",
  "adb_settings_get", { namespace: "global", key: "" });

// ══════════════════════════════════════════════════════════
// Tools with Zero Prior Coverage (safe subset)
// ══════════════════════════════════════════════════════════

h.section("Previously Untested Tools");

// adb_clear_data — clear a known safe test package (if it existed, this is idempotent)
// We test that the tool runs without crashing, even if the package has no data
await h.test("Clear data (Magisk — safe, idempotent)", "adb_clear_data",
  { packageName: "com.topjohnwu.magisk" });

// adb_extract_apks — extract splits for a known package
await h.testContains("Extract APKs (Magisk)", "adb_extract_apks",
  { packageName: "com.topjohnwu.magisk" }, "base.apk");

// adb_snapshot_restore_settings — verify graceful error on nonexistent file
await h.testRejects("Snapshot restore (nonexistent file → graceful error)", "adb_snapshot_restore_settings",
  { snapshotPath: "nonexistent.json" });

// adb_workflow marketplace tools — verify graceful error on unreachable registry
await h.testRejects("Market search (registry 404 → graceful error)", "adb_market_search",
  { query: "test" });

// adb_registry_search — verify graceful error on unreachable registry
await h.testRejects("Registry search (registry 404 → graceful error)", "adb_registry_search",
  { query: "test" });

// ══════════════════════════════════════════════════════════
// Negative Content Assertions (testNotContains)
// ══════════════════════════════════════════════════════════

h.section("Sensitive Data Protection");

// IMEI value should NOT appear by default — the tool shows an opt-in message instead.
// Checking for "includeImei" confirms the IMEI was suppressed with an explanatory note.
await h.testContains("Baseband IMEI hidden by default", "adb_baseband_info",
  {}, "includeImei");

// Health check should not leak internal paths or stack traces
await h.testNotContains("Health check hides stack traces", "adb_health_check",
  {}, "stack trace");

const exitCode = h.finish();
process.exit(exitCode);
