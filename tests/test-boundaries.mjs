/**
 * Boundary & Error Handling Test Suite — Edge cases, Zod bounds enforcement,
 * input injection via adb_input, error paths, and tools with zero prior coverage.
 *
 * These tests validate defensive boundaries without requiring a connected device
 * for most checks (Zod rejection happens before device communication).
 */
import { createHarness } from "./lib/harness.mjs";
import { existsSync } from "fs";

const h = await createHarness("Boundaries & Error Handling");

// Mode detection: wireless ADB tools and multi-device whoami behave
// differently in on-device mode (LocalBridge stubs wireless ops; shell
// commands run as root rather than the shell user).
const onDevice = existsSync("/data/data/com.termux");

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

h.section("Zod Boundary — Pinch Gesture");

// adb_input_pinch startRadius: .min(10).max(2000)
await h.testRejects("Pinch startRadius below min (5)",
  "adb_input_pinch", { cx: 540, cy: 1200, startRadius: 5, endRadius: 100 });

// adb_input_pinch durationMs: .min(100).max(5000)
await h.testRejects("Pinch durationMs above max (6000)",
  "adb_input_pinch", { cx: 540, cy: 1200, startRadius: 300, endRadius: 100, durationMs: 6000 });

// adb_input_pinch steps: .min(5).max(60)
await h.testRejects("Pinch steps above max (100)",
  "adb_input_pinch", { cx: 540, cy: 1200, startRadius: 300, endRadius: 100, steps: 100 });

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

// ══════════════════════════════════════════════════════════
// Wireless ADB Tools — Zod & Error-Path Coverage
// wireless.ts has no sanitization layer (argv is passed directly to
// `adb connect/pair/disconnect` via spawn, so shell interp doesn't
// apply), but we still verify that malformed input produces graceful
// errors rather than crashes, and that Zod bounds hold.
// ══════════════════════════════════════════════════════════

h.section("Wireless ADB — Input Handling");

// adb_tcpip port: Zod .min(1).max(65535)
await h.testRejects("tcpip port below min (0)",
  "adb_tcpip", { port: 0 });

await h.testRejects("tcpip port above max (99999)",
  "adb_tcpip", { port: 99999 });

// adb_connect with a malformed host: adb CLI doesn't actually validate
// the host string — it prints an error message to stdout but exits 0,
// which the tool surfaces as a "success" with the error text inside.
// Verify graceful handling (no crash) and that the output mentions
// the failed host.
// On-device mode: LocalBridge stubs adb_connect with a "not applicable"
// message since there's no ADB server. Just verify it doesn't crash.
if (onDevice) {
  await h.testContains("Connect to malformed host surfaces error (stub)",
    "adb_connect", { host: "not-a-valid-host:format:here" }, "not applicable", 5000);
} else {
  await h.testContains("Connect to malformed host surfaces error",
    "adb_connect", { host: "not-a-valid-host:format:here" }, "not-a-valid-host", 5000);
}

// adb_disconnect with no host should succeed (disconnects all wireless)
// but if already none connected, adb exits 0 with empty output — this is
// not a rejection, it's valid idempotent behavior.
await h.test("Disconnect all (idempotent)", "adb_disconnect", {});

// adb_pair with bogus host and code — the adb pair command blocks on the
// network attempt. Use a longer timeout than adb's internal pair timeout
// (adb pair waits ~30s before giving up). Test verifies that when it
// eventually returns, it's as a rejection, not a crash.
// On-device mode: LocalBridge stubs adb_pair with a "not applicable" success
// response. Just verify it doesn't crash and produces a sensible message.
if (onDevice) {
  await h.testContains("Pair with unreachable host (stub)",
    "adb_pair", { host: "192.0.2.1:37123", code: "000000" }, "not applicable", 5000);
} else {
  await h.testRejects("Pair with unreachable host",
    "adb_pair", { host: "192.0.2.1:37123", code: "000000" }, 45000);
}

// ══════════════════════════════════════════════════════════
// Multi-Device Tools — Basic coverage (single-device OK for most)
// ══════════════════════════════════════════════════════════

h.section("Multi-Device — Basic");

// adb_multi_shell works with one device — just runs on the single device.
// In ADB mode `whoami` returns "shell" (uid=2000). In on-device mode via
// LocalBridge, it returns the Termux app user (e.g. "u0_a287") or "root"
// depending on elevation path. Rather than hardcode expected output, verify
// the tool executed and produced some non-empty output.
{
  const res = await h.callTool("adb_multi_shell", { command: "whoami" });
  const out = h.getText(res);
  h.assert("multi_shell on single device (whoami)",
    !h.isError(res) && out.trim().length > 0,
    h.isError(res) ? `tool errored: ${out.substring(0, 120)}` : "empty output");
}

// adb_multi_compare requires ≥2 devices — rejection path
await h.testRejects("multi_compare with <2 devices",
  "adb_multi_compare", { command: "uname -r" });

// adb_multi_test with no args should list available profiles
await h.testContains("multi_test lists profiles when no args",
  "adb_multi_test", {}, "firmware");

// adb_multi_test with firmware profile runs safe read-only checks
await h.testContains("multi_test firmware profile",
  "adb_multi_test", { profile: "firmware" }, "Baseband version");

// adb_multi_test with custom command injection via command field
// Each custom command goes through ctx.security.checkCommand which should
// reject dangerous patterns when security middleware is enabled — with it
// disabled (default), the command runs literally; verify execution at least.
await h.test("multi_test custom command",
  "adb_multi_test", { commands: [{ label: "uptime", command: "uptime" }] });

// ══════════════════════════════════════════════════════════
// Other Previously-Untested Tools
// ══════════════════════════════════════════════════════════

h.section("Other Untested Tools");

// adb_at_probe — scans standard AT diagnostic sequence against a modem node.
// Auto-detection requires the modem node to actually respond to AT commands,
// which depends on the SIM and RIL state. Test with an explicit Shannon port
// (Pixel 6a). On devices without this path, the tool returns an error cleanly
// rather than crashing — either outcome verifies the plumbing works.
// We use h.callTool + manual check so either success or clean rejection passes.
const probeRes = await h.callTool("adb_at_probe", { port: "/dev/umts_router0" }, 20000);
const probeText = h.getText(probeRes);
const probeErr = h.isError(probeRes);
h.assert("at_probe runs without crashing",
  probeErr ? probeText.length > 0 : probeText.includes("AT Diagnostic Probe"),
  probeErr ? `rejected cleanly: ${probeText.substring(0, 120)}` : "");

// adb_profile_save requires a name AND a profile JSON string.
// Test with a minimal valid profile (just enough to serialize).
const minimalProfile = JSON.stringify({
  name: "DA_test_profile",
  source: "manual",
  model: "test",
  chipsetFamily: "test",
  quirks: [],
});
await h.testContains("profile_save writes JSON",
  "adb_profile_save", { name: "DA_test_profile", profile: minimalProfile }, "Profile saved");

// Invalid JSON should fail gracefully
await h.testRejects("profile_save rejects invalid JSON",
  "adb_profile_save", { name: "bad", profile: "not-valid-json{" });

// adb_tcpdump_stop when nothing is running should fail gracefully
await h.testRejects("tcpdump_stop when not running",
  "adb_tcpdump_stop", {});

// adb_network_auto_connect with a small TEST-NET-1 range (RFC 5737, never routable)
// won't find any ADB listeners — the tool should return a graceful
// "No ADB listeners found" message, not crash. It's not a rejection
// because the tool succeeds in reporting no devices found.
await h.testContains("network_auto_connect (empty range) reports none",
  "adb_network_auto_connect", { ipRange: "192.0.2.1-2", port: 5555 }, "No ADB listeners found", 15000);

const exitCode = h.finish();
process.exit(exitCode);
