/**
 * Lifecycle Test Suite — Multi-step tool workflows requiring start→interact→stop patterns.
 * Tests: app lifecycle, file push/pull, port forwarding, screen recording,
 * test sessions, UI input, and activity launch.
 */
import { createHarness } from "./lib/harness.mjs";
import { existsSync } from "fs";

const h = await createHarness("Lifecycle & Interaction");

// Mode detection: port forwarding is stubbed in on-device LocalBridge since
// there's no ADB server to register forwards with.
const onDevice = existsSync("/data/data/com.termux");

// ── App Lifecycle ──────────────────────────────────────────

h.section("App Lifecycle (Magisk)");
await h.testContains("Force Stop", "adb_force_stop",
  { packageName: "com.topjohnwu.magisk" }, "Force-stopped");

await h.testContains("Start App", "adb_start_app",
  { packageName: "com.topjohnwu.magisk" }, "Launched");

await new Promise(r => setTimeout(r, 1500));

await h.testContains("Restart App", "adb_restart_app",
  { packageName: "com.topjohnwu.magisk", delayMs: 500 }, "Restarted");

await new Promise(r => setTimeout(r, 1000));

// Return to home screen for subsequent tests
await h.callTool("adb_shell", { command: "input keyevent KEYCODE_HOME" });
await new Promise(r => setTimeout(r, 500));

// ── File Push/Pull Round-Trip ──────────────────────────────

h.section("File Push/Pull");

// Pull: create file on device, pull to host
await h.callTool("adb_shell", { command: "echo 'DA_pull_test_67890' > /sdcard/DA_pull_test.txt" });
await h.testContains("Pull file from device", "adb_pull",
  { remotePath: "/sdcard/DA_pull_test.txt" }, "Saved to");
await h.callTool("adb_shell", { command: "rm /sdcard/DA_pull_test.txt" });

// Push: send a known host file to device, verify arrival
const pushSrc = new URL("../package.json", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
await h.test("Push file to device", "adb_push",
  { localPath: pushSrc, remotePath: "/sdcard/DA_push_test.json" });
await h.testContains("Verify pushed file", "adb_cat",
  { path: "/sdcard/DA_push_test.json" }, "deepadb");
await h.callTool("adb_shell", { command: "rm /sdcard/DA_push_test.json" });

// ── UI Input & Activity ────────────────────────────────────

h.section("UI Input & Activity Launch");

await h.test("Input tap (safe coords)", "adb_input",
  { type: "tap", args: "540 400" });

await h.testContains("Start Activity (Settings)", "adb_start_activity",
  { intent: "-a android.settings.SETTINGS" }, "Starting");

await new Promise(r => setTimeout(r, 1000));

// Return to home
await h.callTool("adb_shell", { command: "input keyevent KEYCODE_HOME" });
await new Promise(r => setTimeout(r, 500));

// ── Performance Snapshot ───────────────────────────────────

h.section("Performance Snapshot");
await h.testContains("Perf Snapshot (Magisk)", "adb_perf_snapshot",
  { packageName: "com.topjohnwu.magisk" }, "Memory");

// ── Port Forwarding Lifecycle ──────────────────────────────

h.section("Port Forwarding Lifecycle");

await h.test("Forward create", "adb_forward",
  { local: "tcp:19876", remote: "tcp:19876" });

await h.test("Reverse create", "adb_reverse",
  { remote: "tcp:19877", local: "tcp:19877" });

// Forward list content: in ADB mode the list should contain the tcp:19876
// forward we just created. In on-device mode, LocalBridge returns an empty
// list for `--list` (there's no ADB server to register forwards with, so
// `adb_forward` itself is a stub). Verify appropriately.
if (onDevice) {
  await h.test("Forward list (stub in on-device mode)", "adb_forward_list", {});
} else {
  await h.testContains("Forward list (shows entries)", "adb_forward_list", {}, "tcp:19876");
}

// Cleanup forwards
await h.callTool("adb_shell", { command: "true" }); // no-op, just ensuring device is responsive
// Note: forwards are cleaned up automatically when ADB connection resets,
// but we also test the list showing them

// ── Screen Recording Lifecycle ─────────────────────────────

h.section("Screen Recording Lifecycle");

await h.testContains("Screenrecord start", "adb_screenrecord_start",
  { maxDuration: 5 }, "Recording started");

await new Promise(r => setTimeout(r, 3000));

await h.testContains("Screenrecord stop", "adb_screenrecord_stop", {}, "Recording saved");

// ── Test Session Lifecycle ─────────────────────────────────

h.section("Test Session Lifecycle");

await h.testContains("Test session start", "adb_test_session_start",
  { name: "DA_automated_test" }, "Test session started");

await h.testContains("Test step 1", "adb_test_step",
  { description: "Home screen baseline", captureScreenshot: true, captureLogcat: true }, "Step 001");

await h.testContains("Test step 2", "adb_test_step",
  { description: "Second check", captureScreenshot: false, captureLogcat: true }, "Step 002");

await h.testContains("Test session end", "adb_test_session_end", {}, "Test session");

// ── Misc Safe Tools ────────────────────────────────────────

h.section("Misc Safe Tools");

await h.test("AVD List (no AVDs is OK)", "adb_avd_list", {});
await h.testContains("Mirror Status (scrcpy check)", "adb_mirror_status", {}, "scrcpy");
await h.testContains("Registry Installed (local)", "adb_registry_installed", {}, "installed");
await h.testContains("CI Wait Boot (already booted)", "adb_ci_wait_boot",
  { timeoutSeconds: 10 }, "booted and ready");

// ── Cleanup ─────────────────────────────────────────────────

h.section("Cleanup");

await h.testContains("Remove forward", "adb_forward_remove",
  { local: "tcp:19876" }, "Removed forward");

await h.testContains("Remove reverse forward", "adb_reverse_remove",
  { remote: "tcp:19877" }, "Removed reverse");

const exitCode = h.finish();
process.exit(exitCode);
