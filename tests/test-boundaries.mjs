// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
/**
 * Boundary & Error Handling Test Suite — Edge cases, Zod bounds enforcement,
 * input injection via adb_input, error paths, and tools with zero prior coverage.
 *
 * These tests validate defensive boundaries without requiring a connected device
 * for most checks (Zod rejection happens before device communication). The
 * subset of assertions that do exercise a live device (package queries, data
 * clears, APK extraction, baseband read, multi-device shell) auto-skip cleanly
 * when no authorized device is attached — see the deviceAvailable probe below.
 */
import { createHarness } from "./lib/harness.mjs";
import { existsSync } from "fs";

const h = await createHarness("Boundaries & Error Handling");

// Mode detection: wireless ADB tools and multi-device whoami behave
// differently in on-device mode (LocalBridge stubs wireless ops; shell
// commands run as root rather than the shell user).
const onDevice = existsSync("/data/data/com.termux");

// Device-availability probe (mirrors test-result-handles.mjs). A handful of
// assertions below run a tool against a live device; probe adb_devices for an
// authorized "(device)" connection so those tests skip cleanly rather than fail
// hard when no device is attached or USB debugging authorization has lapsed. In
// on-device (Termux) mode the LocalBridge reports the local device, so this is
// true there too.
let deviceAvailable = false;
try {
  const dev = await h.callTool("adb_devices", {});
  if (!h.isError(dev)) {
    deviceAvailable = /\(device\)/.test(h.getText(dev));
  }
} catch {
  deviceAvailable = false;
}

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
if (deviceAvailable) {
  await h.test("Package info for nonexistent package (graceful)",
    "adb_package_info", { packageName: "com.nonexistent.fake.package.xyz" });
} else {
  h.skip("Package info for nonexistent package (graceful)", "no device authorized");
}

// getprop with empty key
await h.testRejects("Settings get with empty key",
  "adb_settings_get", { namespace: "global", key: "" });

// ══════════════════════════════════════════════════════════
// Tools with Zero Prior Coverage (safe subset)
// ══════════════════════════════════════════════════════════

h.section("Previously Untested Tools");

// adb_clear_data — clear a known safe test package (if it existed, this is idempotent)
// We test that the tool runs without crashing, even if the package has no data.
// AP5 fix: now requires `confirm` parameter matching packageName.
if (deviceAvailable) {
  await h.test("Clear data (Magisk — safe, idempotent)", "adb_clear_data",
    { packageName: "com.topjohnwu.magisk", confirm: "com.topjohnwu.magisk" });
} else {
  h.skip("Clear data (Magisk — safe, idempotent)", "no device authorized");
}

// AP5 regression: clear_data must reject when confirm omitted
await h.testRejects("Clear data without confirm rejected (AP5)", "adb_clear_data",
  { packageName: "com.topjohnwu.magisk" });

// AP5 regression: clear_data must reject when confirm doesn't match packageName
await h.testRejects("Clear data with mismatched confirm rejected (AP5)", "adb_clear_data",
  { packageName: "com.topjohnwu.magisk", confirm: "com.different.package" });

// adb_extract_apks — extract splits for a known package
if (deviceAvailable) {
  await h.testContains("Extract APKs (Magisk)", "adb_extract_apks",
    { packageName: "com.topjohnwu.magisk" }, "base.apk");
} else {
  h.skip("Extract APKs (Magisk)", "no device authorized");
}

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
if (deviceAvailable) {
  await h.testContains("Baseband IMEI hidden by default", "adb_baseband_info",
    {}, "includeImei");
} else {
  h.skip("Baseband IMEI hidden by default", "no device authorized");
}

// Health check output must never leak a raw stack trace, whether the check
// passes or reports an unhealthy adb. On a runner with no functional adb it
// returns isError with a clean message that must still be stack-trace-free, so
// assert on the output text directly rather than requiring overall success.
{
  const res = await h.callTool("adb_health_check", {});
  h.assert("Health check hides stack traces", !/stack trace/i.test(h.getText(res)), "health output leaked a stack trace");
}

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

// adb_connect graceful-error path (option C, post-N1/BI1 hardening):
//
// The HOST_PORT_RE schema regex now rejects obviously-malformed hosts
// at the Zod boundary BEFORE adb is invoked — see wireless.ts HOST_PORT_RE (N1).
// We test two distinct surfaces:
//   1. Schema rejection of malformed input (regression for N1/BI1).
//   2. Graceful runtime-error surfacing when the host parses but the
//      target is unreachable. Use 127.0.0.1:1 — valid format, no
//      listener, so connect() returns ECONNREFUSED immediately
//      (avoids the blackhole-timeout problem of TEST-NET-1).
//
// On-device mode: LocalBridge stubs adb_connect with "not applicable"
// since there's no ADB server. Schema rejection still applies.

// Surface 1: schema rejection (N1/BI1 hardening).
await h.testRejects("Connect with malformed host is rejected at schema (N1/BI1)",
  "adb_connect", { host: "not-a-valid-host:format:here" });

// Surface 2: runtime-error surfacing for valid-format-but-unreachable host.
if (onDevice) {
  await h.testContains("Connect to unreachable host surfaces error (stub)",
    "adb_connect", { host: "127.0.0.1:1" }, "not applicable", 5000);
} else {
  // A reachable adb echoes the unreachable target in its failure text; a
  // non-functional adb (e.g. a CI runner with no adb server) surfaces isError
  // with a generic message instead. Both are valid surfaced-error outcomes;
  // the point is graceful degradation, not a hang or a false success.
  try {
    const res = await h.callTool("adb_connect", { host: "127.0.0.1:1" }, 5000);
    const ok = h.isError(res) || h.getText(res).includes("127.0.0.1");
    h.assert("Connect to unreachable host surfaces error", ok, "expected isError or the host in output");
  } catch (e) {
    h.assert("Connect to unreachable host surfaces error", false, "crash/timeout: " + e.message);
  }
}

// adb_disconnect with no host should succeed (disconnects all wireless)
// but if already none connected, adb exits 0 with empty output — this is
// not a rejection, it's valid idempotent behavior.
// On a runner with no functional adb, disconnect surfaces a clean adb error
// rather than the idempotent success a working adb returns. Accept either;
// only a crash/timeout is a real failure here.
try {
  const res = await h.callTool("adb_disconnect", {});
  const ok = !h.isError(res) || /adb|disconnect|server|daemon|device/.test(h.getText(res).toLowerCase());
  h.assert("Disconnect all (idempotent)", ok, "unexpected disconnect failure shape");
} catch (e) {
  h.assert("Disconnect all (idempotent)", false, "crash/timeout: " + e.message);
}

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
if (deviceAvailable) {
  const res = await h.callTool("adb_multi_shell", { command: "whoami" });
  const out = h.getText(res);
  h.assert("multi_shell on single device (whoami)",
    !h.isError(res) && out.trim().length > 0,
    h.isError(res) ? `tool errored: ${out.substring(0, 120)}` : "empty output");
} else {
  h.skip("multi_shell on single device (whoami)", "no device authorized");
}

// adb_multi_compare requires ≥2 devices — rejection path
await h.testRejects("multi_compare with <2 devices",
  "adb_multi_compare", { command: "uname -r" });

// adb_multi_test with no args should list available profiles
await h.testContains("multi_test lists profiles when no args",
  "adb_multi_test", {}, "firmware");

// adb_multi_test with firmware profile runs safe read-only checks
if (deviceAvailable) {
  await h.testContains("multi_test firmware profile",
    "adb_multi_test", { profile: "firmware" }, "Baseband version");
} else {
  h.skip("multi_test firmware profile", "no device authorized");
}

// adb_multi_test with custom command injection via command field
// Each custom command goes through ctx.security.checkCommand which should
// reject dangerous patterns when security middleware is enabled — with it
// disabled (default), the command runs literally; verify execution at least.
if (deviceAvailable) {
  await h.test("multi_test custom command",
    "adb_multi_test", { commands: [{ label: "uptime", command: "uptime" }] });
} else {
  h.skip("multi_test custom command", "no device authorized");
}

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

// ══════════════════════════════════════════════════════════
// Tunnel automation (adb_tunnel_open / list / close)
// Boundary checks — exercising schema validation, empty-state
// list, unknown-ID close, reverse-without-hostSpec required check.
// Tests that actually open a tunnel are skipped without a real
// device since adb forward needs a connected target.
// ══════════════════════════════════════════════════════════

h.section("Tunnel Automation Boundaries");

// Zod: bad direction
await h.testRejects("tunnel_open rejects bad direction",
  "adb_tunnel_open", { direction: "sideways", deviceSpec: "tcp:3000" });

// Zod: bad deviceSpec (shell metachar smuggling attempt)
await h.testRejects("tunnel_open rejects shell-metachar in deviceSpec",
  "adb_tunnel_open", { direction: "forward", deviceSpec: "tcp:3000; rm -rf /" });

// Zod: bad deviceSpec (unknown scheme)
await h.testRejects("tunnel_open rejects unknown spec scheme",
  "adb_tunnel_open", { direction: "forward", deviceSpec: "udp:3000" });

// Zod: bad hostSpec format
await h.testRejects("tunnel_open rejects bad hostSpec",
  "adb_tunnel_open", { direction: "forward", deviceSpec: "tcp:3000", hostSpec: "not-a-spec" });

// Required hostSpec for reverse direction — tool returns isError:true
// with a clear message explaining why. testRejects rather than testContains
// because the message-content check happens via isError flag, not text match.
await h.testRejects("tunnel_open requires hostSpec for reverse",
  "adb_tunnel_open", { direction: "reverse", deviceSpec: "tcp:3000" });

// tunnel_list when empty (always works — no device required)
await h.testContains("tunnel_list when empty",
  "adb_tunnel_list", {}, "No managed tunnels open");

// tunnel_list with device filter when empty
await h.testContains("tunnel_list device-filtered when empty",
  "adb_tunnel_list", { device: "nonexistent_serial" }, "No managed tunnels open");

// tunnel_close with unknown ID
await h.testRejects("tunnel_close rejects unknown ID",
  "adb_tunnel_close", { id: "tun_deadbe" });

// tunnel_close 'all' when empty
await h.testContains("tunnel_close 'all' when empty",
  "adb_tunnel_close", { id: "all" }, "No managed tunnels to close");

// ══════════════════════════════════════════════════════════
// Coverage Completion — device-free Zod boundaries for tools
// that previously had zero test references. Every assertion here
// triggers Zod rejection at the MCP boundary BEFORE any device
// communication or destructive side effect (radio toggles, reboots,
// installs, builds, mirroring) — so they run safely without a device.
// ══════════════════════════════════════════════════════════

h.section("Coverage — Enum Constraints");

// adb_location mode: z.enum(["off","sensors","battery","high"])
await h.testRejects("location rejects invalid mode",
  "adb_location", { mode: "ultra" });

// adb_reboot mode: z.enum(["normal","recovery","bootloader"])
await h.testRejects("reboot rejects invalid mode",
  "adb_reboot", { mode: "fastboot" });

// adb_farm_matrix type: z.enum(["models","versions"])
await h.testRejects("farm_matrix rejects invalid type",
  "adb_farm_matrix", { type: "devices" });

// adb_emulator_start gpuMode: z.enum(["auto","host","swiftshader_indirect","off"])
await h.testRejects("emulator_start rejects invalid gpuMode",
  "adb_emulator_start", { avdName: "DA_test_avd", gpuMode: "vulkan" });

h.section("Coverage — Numeric Bounds");

// adb_airplane_cycle delaySeconds: .min(1).max(60)
await h.testRejects("airplane_cycle delaySeconds below min (0)",
  "adb_airplane_cycle", { delaySeconds: 0 });
await h.testRejects("airplane_cycle delaySeconds above max (99)",
  "adb_airplane_cycle", { delaySeconds: 99 });

// adb_gradle timeout: .min(30000).max(1800000)
await h.testRejects("gradle timeout below min (100ms)",
  "adb_gradle", { projectPath: "/tmp/proj", task: "assembleDebug", timeout: 100 });
await h.testRejects("gradle timeout above max (9999999ms)",
  "adb_gradle", { projectPath: "/tmp/proj", task: "assembleDebug", timeout: 9999999 });

// adb_build_and_install timeout: .min(30000).max(1800000)
await h.testRejects("build_and_install timeout below min (100ms)",
  "adb_build_and_install", { projectPath: "/tmp/proj", timeout: 100 });

// adb_ci_run_tests timeout: .min(10000).max(600000)
await h.testRejects("ci_run_tests timeout below min (100ms)",
  "adb_ci_run_tests", { testPackage: "com.example.app.test", timeout: 100 });

// adb_mirror_start maxFps: .min(1).max(120)
await h.testRejects("mirror_start maxFps below min (0)",
  "adb_mirror_start", { maxFps: 0 });
await h.testRejects("mirror_start maxFps above max (999)",
  "adb_mirror_start", { maxFps: 999 });

h.section("Coverage — Regex & Array Constraints");

// adb_mirror_start bitrate: regex /^\d+(\.\d+)?[KMG]?$/
await h.testRejects("mirror_start rejects malformed bitrate",
  "adb_mirror_start", { bitrate: "fast" });

// adb_install_bundle apkPaths: .min(1)
await h.testRejects("install_bundle rejects empty apkPaths array",
  "adb_install_bundle", { apkPaths: [] });

h.section("Coverage — Required Parameter Types");

// adb_wifi enabled: required z.boolean()
await h.testRejects("wifi rejects non-boolean enabled",
  "adb_wifi", { enabled: "yes" });

// adb_mobile_data enabled: required z.boolean()
await h.testRejects("mobile_data rejects non-boolean enabled",
  "adb_mobile_data", { enabled: "true" });

// adb_airplane_mode enabled: required z.boolean()
await h.testRejects("airplane_mode rejects missing enabled",
  "adb_airplane_mode", {});

// adb_install apkPath: required z.string()
await h.testRejects("install rejects missing apkPath",
  "adb_install", {});

// adb_uninstall packageName: required z.string()
await h.testRejects("uninstall rejects missing packageName",
  "adb_uninstall", {});

// adb_farm_run testApk: required (appApk provided, testApk omitted)
await h.testRejects("farm_run rejects missing testApk",
  "adb_farm_run", { appApk: "/tmp/app.apk" });

const exitCode = h.finish();
process.exit(exitCode);
