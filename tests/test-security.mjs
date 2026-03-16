/**
 * Security Test Suite — SELinux, permissions, and input sanitization validation.
 * Tests that shell injection attempts are properly rejected by validateShellArg.
 */
import { createHarness } from "./lib/harness.mjs";

const h = await createHarness("Security & Sanitization");

// ── SELinux ────────────────────────────────────────────────

h.section("SELinux Inspection");
await h.testContains("SELinux Status → Enforcing", "adb_selinux_status", {}, "Enforcing");
await h.testContains("SELinux Denials", "adb_selinux_denials", { lines: 20 }, "AVC Denials");
await h.test("SELinux Denials (with filter)", "adb_selinux_denials", { lines: 20, process: "zygote" });

// ── Permission Auditing ────────────────────────────────────

h.section("Permission Auditing");
await h.testContains("Permission Audit (Magisk)", "adb_permission_audit",
  { packageName: "com.topjohnwu.magisk" }, "Permission Audit");

// ── Input Sanitization — Shell Injection Rejection ─────────

h.section("Shell Injection Prevention (validateShellArg)");

// These should all be REJECTED — the tool should return isError: true
// because the package/filter/key contains shell metacharacters

await h.testRejects("Inject via package name (semicolon)",
  "adb_package_info", { packageName: "com.test; rm -rf /" });

await h.testRejects("Inject via package name (pipe)",
  "adb_package_info", { packageName: "com.test | cat /etc/passwd" });

await h.testRejects("Inject via package name (backtick)",
  "adb_package_info", { packageName: "com.test`id`" });

await h.testRejects("Inject via package name ($())",
  "adb_package_info", { packageName: "com.test$(whoami)" });

await h.testRejects("Inject via package name (ampersand)",
  "adb_package_info", { packageName: "com.test && echo pwned" });

await h.testRejects("Inject via getprop key (semicolon)",
  "adb_getprop", { key: "ro.build; id" });

await h.testRejects("Inject via settings key (pipe)",
  "adb_settings_get", { namespace: "global", key: "airplane|id" });

await h.testRejects("Inject via dumpsys service (backtick)",
  "adb_dumpsys", { service: "battery`id`" });

await h.testRejects("Inject via logcat tag (semicolon)",
  "adb_logcat", { tag: "MyApp;id", lines: 10 });

await h.testRejects("Inject via filter (single quote)",
  "adb_list_packages", { filter: "test'injection" });

await h.testRejects("Inject via modem_logs grep (pipe)",
  "adb_modem_logs", { grep: "test|cat /etc/passwd", lines: 10 });

// Verify legitimate inputs still work after all the rejection tests
await h.testContains("Legit package name after injections",
  "adb_package_info", { packageName: "com.topjohnwu.magisk" }, "com.topjohnwu.magisk");

await h.testContains("Legit getprop after injections",
  "adb_getprop", { key: "ro.product.model" }, "Pixel");

// ── Network tool (tcpdump filter validation) ───────────────

h.section("Network Capture Sanitization");
await h.testRejects("Inject via tcpdump filter",
  "adb_tcpdump_start", { filter: "port 80; rm -rf /", interface: "any" });

await h.testRejects("Inject via tcpdump interface",
  "adb_tcpdump_start", { interface: "wlan0`id`" });

// ── AT Command Sanitization ────────────────────────────────

h.section("AT Command Sanitization");
// AT commands reject shell-unsafe chars (backticks, $, ;, etc.)
await h.testRejects("AT inject via command (backtick)",
  "adb_at_send", { command: "AT`id`", port: "/dev/umts_router0" });

await h.testRejects("AT inject via command ($())",
  "adb_at_send", { command: "AT$(whoami)", port: "/dev/umts_router0" });

await h.testRejects("AT inject via port (traversal)",
  "adb_at_send", { command: "AT", port: "/dev/../etc/passwd" });

await h.testRejects("AT inject via port (no /dev/ prefix)",
  "adb_at_send", { command: "AT", port: "/etc/passwd" });

// Dangerous AT command blocklist
await h.testRejects("AT dangerous → AT+CFUN=0 (kill radio)",
  "adb_at_send", { command: "AT+CFUN=0" });

await h.testRejects("AT dangerous → AT+EGMR (write IMEI)",
  "adb_at_send", { command: "AT+EGMR=1,7,\"012345678901234\"" });

const exitCode = h.finish();
process.exit(exitCode);
