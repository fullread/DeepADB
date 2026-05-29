// Copyright 2026 Jason <fullread@github>
// SPDX-License-Identifier: Apache-2.0
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
// tcpdump is root-only on this device; over a non-root ADB shell the tool
// short-circuits on a not-found error before any filter or interface
// validation runs, which would mask the real behavior and yield a spurious
// pass. Skip-guard so these assertions are meaningful only where tcpdump is
// actually reachable (on-device / rooted).
{
  const tcpdumpProbe = await h.callTool("adb_shell", { command: "which tcpdump || echo NONE" });
  const haveTcpdump = !/NONE/.test(h.getText(tcpdumpProbe) || "");
  if (!haveTcpdump) {
    h.skip("Inject via tcpdump interface (backtick)", "tcpdump unavailable in this environment");
    h.skip("tcpdump filter metachar injection is neutralized", "tcpdump unavailable in this environment");
    h.skip("Inject via tcpdump filter (single quote)", "tcpdump unavailable in this environment");
  } else {
    // interface IS validated by validateShellArg, so metacharacters are rejected.
    await h.testRejects("Inject via tcpdump interface (backtick)",
      "adb_tcpdump_start", { interface: "wlan0`id`" });
    // The filter is intentionally NOT rejected for shell metacharacters (BPF
    // expressions need parens, bitwise ops, and spaces); it is single-quote
    // wrapped so an injected semicolon is neutralized rather than rejected.
    // Prove the injected side effect does NOT occur.
    const marker = `/data/local/tmp/.inj_proof_${Date.now()}`;
    await h.callTool("adb_shell", { command: `rm -f ${marker}` });
    await h.callTool("adb_tcpdump_start", { filter: `port 80; touch ${marker}`, interface: "any" });
    await h.callTool("adb_tcpdump_stop", {});
    const injCheck = await h.callTool("adb_shell", { command: `[ -f ${marker} ] && echo INJECTED || echo SAFE; rm -f ${marker}` });
    h.assert("tcpdump filter metachar injection is neutralized (not executed)",
      /SAFE/.test(h.getText(injCheck) || ""));
    // Chars that CAN break out of the single-quote wrap ARE rejected.
    await h.testRejects("Inject via tcpdump filter (single quote)",
      "adb_tcpdump_start", { filter: "port 80'; rm -rf /", interface: "any" });
  }
}

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

// ── adb_heap_dump input validation (regression for Pass 4 Finding #2) ──
// Prior version called validateShellArg(target, "target") but discarded
// the return value, so malicious target strings would slip through (though
// shellEscape provided a second line of defense). Test that metacharacter
// payloads now yield a clean rejection at the validator layer.

h.section("Heap Dump Input Validation");
await h.testRejects("Heap dump inject via target (semicolon)",
  "adb_heap_dump", { target: "com.test; rm -rf /" });
await h.testRejects("Heap dump inject via target (pipe)",
  "adb_heap_dump", { target: "com.test | id" });
await h.testRejects("Heap dump inject via target (backtick)",
  "adb_heap_dump", { target: "com.test`id`" });
await h.testRejects("Heap dump inject via target ($())",
  "adb_heap_dump", { target: "com.test$(whoami)" });

// ── shellQuote (unit) ───────────────────────────────────
// shellQuote() from middleware/sanitize.ts wraps every input in single
// quotes and uses the '\''-close-reopen pattern for embedded quotes.
// It is the canonical primitive for safe shell-argument interpolation,
// replacing 3 separate inline implementations (qemu.ts escapeQemuShellArg,
// local-bridge.ts shellQuote method, and the files.ts inline pattern).
// This block is the regression test for that primitive.

h.section("shellQuote (unit)");
const { shellQuote } = await import("../build/middleware/sanitize.js");

h.assertEq("Plain string is quoted",
  shellQuote("abc"), "'abc'");

h.assertEq("Empty string is quoted",
  shellQuote(""), "''");

h.assertEq("Arg with spaces is quoted",
  shellQuote("foo bar"), "'foo bar'");

h.assertEq("Arg with = is quoted",
  shellQuote("init=/init"), "'init=/init'");

// Injection payloads:
h.assertEq("Injection via semicolon is neutralized",
  shellQuote("; reboot"), "'; reboot'");

h.assertEq("Injection via pipe is neutralized",
  shellQuote("| cat /etc/passwd"), "'| cat /etc/passwd'");

h.assertEq("Injection via backtick is neutralized",
  shellQuote("`id`"), "'`id`'");

h.assertEq("Injection via $() is neutralized",
  shellQuote("$(whoami)"), "'$(whoami)'");

h.assertEq("Injection via ampersand is neutralized",
  shellQuote("foo & bar"), "'foo & bar'");

h.assertEq("Embedded single quote is escaped via '\\'' pattern",
  shellQuote("it's"), "'it'\\''s'");

h.assertEq("Attempted quote-break is neutralized",
  shellQuote("'; reboot; '"), "''\\''; reboot; '\\'''");

h.assertEq("Multiple embedded quotes",
  shellQuote("a'b'c"), "'a'\\''b'\\''c'");

// Round-trip: whatever's inside, when the shell parses, must equal input.
// Skipped on Windows where /bin/sh isn't available.
if (process.platform !== "win32") {
  const { spawnSync } = await import("child_process");
  const roundTripCases = [
    "abc",
    "; reboot",
    "$(whoami)",
    "it's a test",
    "'; rm -rf /; '",
    "foo bar baz",
    "",
  ];
  for (const input of roundTripCases) {
    const escaped = shellQuote(input);
    const r = spawnSync("/bin/sh", ["-c", `printf %s ${escaped}`], { encoding: "utf8" });
    h.assertEq(`shellQuote round-trip: ${JSON.stringify(input)}`, r.stdout, input);
  }
} else {
  h.skip("shellQuote round-trip (requires /bin/sh)", "Windows host");
}

// ── QEMU Shell-Arg Escaping (unit test — regression for Pass 4 fix) ──
// escapeQemuShellArg() wraps every arg in single quotes and uses the
// '\''-close-reopen pattern for embedded quotes. A prior heuristic only
// quoted args containing =/,/: — which missed payloads like "; reboot"
// that contain no trigger chars but break shell parsing.
// This test directly exercises the exported helper so a revert is caught
// whether or not the KVM path is reachable on the test host.

h.section("QEMU Shell Escaping (unit)");
const { escapeQemuShellArg } = await import("../build/tools/qemu.js");

h.assertEq("Plain string is quoted",
  escapeQemuShellArg("abc"), "'abc'");

h.assertEq("Empty string is quoted",
  escapeQemuShellArg(""), "''");

h.assertEq("Arg with spaces is quoted",
  escapeQemuShellArg("foo bar"), "'foo bar'");

h.assertEq("Arg with = is quoted (was trigger in old heuristic)",
  escapeQemuShellArg("init=/init"), "'init=/init'");

// Injection payloads — the Pass 4 regression cases:
h.assertEq("Injection via semicolon is neutralized",
  escapeQemuShellArg("; reboot"), "'; reboot'");

h.assertEq("Injection via pipe is neutralized",
  escapeQemuShellArg("| cat /etc/passwd"), "'| cat /etc/passwd'");

h.assertEq("Injection via backtick is neutralized",
  escapeQemuShellArg("`id`"), "'`id`'");

h.assertEq("Injection via $() is neutralized",
  escapeQemuShellArg("$(whoami)"), "'$(whoami)'");

h.assertEq("Embedded single quote is escaped via '\\'' pattern",
  escapeQemuShellArg("it's"), "'it'\\''s'");

h.assertEq("Attempted quote-break is neutralized",
  escapeQemuShellArg("'; reboot; '"), "''\\''; reboot; '\\'''");

h.assertEq("Multiple embedded quotes",
  escapeQemuShellArg("a'b'c"), "'a'\\''b'\\''c'");

// Verify the round-trip property: whatever's inside the quotes, when the
// shell parses it back, must equal the original input. Skipped on Windows
// where /bin/sh isn't available.
if (process.platform !== "win32") {
  const { spawnSync } = await import("child_process");
  const roundTripCases = [
    "abc",
    "; reboot",
    "$(whoami)",
    "it's a test",
    "'; rm -rf /; '",
    "console=ttyAMA0 root=/dev/vda",
  ];
  for (const input of roundTripCases) {
    const escaped = escapeQemuShellArg(input);
    const r = spawnSync("/bin/sh", ["-c", `printf %s ${escaped}`], { encoding: "utf8" });
    h.assertEq(`Shell round-trip: ${JSON.stringify(input)}`, r.stdout, input);
  }
} else {
  h.skip("Shell round-trip (requires /bin/sh)", "Windows host");
}

// ── Filename Component Sanitization (unit) ─────────────────
// sanitizeFilenameComponent and sanitizeFilenameComponentDotted from
// middleware/fs-utils.ts. Both are used as the centralized sanitizer for
// user-supplied identifier strings that end up in filesystem paths.
//
// The C1 audit batch (May 12, 2026) folded ~10 inline regex sites across
// testing.ts, snapshot.ts, screenshot-diff.ts, workflow-market.ts,
// test-gen.ts, regression.ts, split-apk.ts, and qemu.ts onto these helpers.
// These tests lock in the security-relevant invariants — traversal defense,
// pure-dot defang, empty-input coercion, and length cap — so future drift
// or "improvements" don't quietly weaken the centralized sanitizer.

h.section("Filename Component Sanitization (unit)");
const { sanitizeFilenameComponent, sanitizeFilenameComponentDotted } =
  await import("../build/middleware/fs-utils.js");

// ── sanitizeFilenameComponent ────────────────────────────────────────────

h.assertEq("sanitizeFilenameComponent preserves allowed chars (a-z, A-Z, 0-9, _, -)",
  sanitizeFilenameComponent("abc_DEF-123"), "abc_DEF-123");

h.assertEq("sanitizeFilenameComponent replaces single dot",
  sanitizeFilenameComponent("."), "_");

h.assertEq("sanitizeFilenameComponent replaces parent-dir traversal `..`",
  sanitizeFilenameComponent(".."), "__");

h.assertEq("sanitizeFilenameComponent replaces slash",
  sanitizeFilenameComponent("a/b"), "a_b");

h.assertEq("sanitizeFilenameComponent replaces backslash",
  sanitizeFilenameComponent("a\\b"), "a_b");

h.assertEq("sanitizeFilenameComponent replaces full traversal path",
  sanitizeFilenameComponent("../../etc/passwd"), "______etc_passwd");

h.assertEq("sanitizeFilenameComponent replaces null byte",
  sanitizeFilenameComponent("a\u0000b"), "a_b");

h.assertEq("sanitizeFilenameComponent coerces empty input to underscore",
  sanitizeFilenameComponent(""), "_");

h.assertEq("sanitizeFilenameComponent coerces all-special input to underscores",
  sanitizeFilenameComponent("///"), "___");

h.assertEq("sanitizeFilenameComponent truncates with maxLen",
  sanitizeFilenameComponent("abcdefghij", 5), "abcde");

h.assertEq("sanitizeFilenameComponent maxLen no-op when input shorter",
  sanitizeFilenameComponent("abc", 100), "abc");

h.assertEq("sanitizeFilenameComponent maxLen applied after replacement",
  sanitizeFilenameComponent("a/b/c/d/e/f", 5), "a_b_c");

// A6 regression: maxLen=0 edge case for the non-dotted version.
// Empty-check moved to AFTER truncation so degenerate maxLen still yields
// a non-empty component.
h.assertEq("A6: sanitizeFilenameComponent with maxLen=0 returns underscore (not empty)",
  sanitizeFilenameComponent("abc", 0), "_");

h.assertEq("A6: sanitizeFilenameComponentDotted with maxLen=0 returns underscore (not empty)",
  sanitizeFilenameComponentDotted("abc", 0), "_");

// ── sanitizeFilenameComponentDotted ──────────────────────────────────────

h.assertEq("sanitizeFilenameComponentDotted preserves package-style dots",
  sanitizeFilenameComponentDotted("com.example.app"), "com.example.app");

h.assertEq("sanitizeFilenameComponentDotted preserves allowed chars including dot",
  sanitizeFilenameComponentDotted("com.example_v2-rc1"), "com.example_v2-rc1");

h.assertEq("sanitizeFilenameComponentDotted defangs single dot (current-dir reference)",
  sanitizeFilenameComponentDotted("."), "_");

h.assertEq("sanitizeFilenameComponentDotted defangs `..` (parent-dir traversal)",
  sanitizeFilenameComponentDotted(".."), "_");

h.assertEq("sanitizeFilenameComponentDotted defangs longer all-dot sequences",
  sanitizeFilenameComponentDotted("....."), "_");

h.assertEq("sanitizeFilenameComponentDotted does NOT defang dots mixed with other chars",
  sanitizeFilenameComponentDotted("..app"), "..app");

h.assertEq("sanitizeFilenameComponentDotted defangs slash but preserves embedded `..` text",
  sanitizeFilenameComponentDotted("com.example/../other"), "com.example_.._other");

h.assertEq("sanitizeFilenameComponentDotted still replaces backslash",
  sanitizeFilenameComponentDotted("com.example\\other"), "com.example_other");

h.assertEq("sanitizeFilenameComponentDotted still replaces null byte",
  sanitizeFilenameComponentDotted("a.\u0000.b"), "a._.b");

h.assertEq("sanitizeFilenameComponentDotted coerces empty input to underscore",
  sanitizeFilenameComponentDotted(""), "_");

h.assertEq("sanitizeFilenameComponentDotted truncates with maxLen",
  sanitizeFilenameComponentDotted("com.example.app.long", 11), "com.example");

h.assertEq("sanitizeFilenameComponentDotted maxLen no-op when input shorter",
  sanitizeFilenameComponentDotted("com.app", 100), "com.app");


// ── sanitizeFilenameComponentDotted A7 regression ──────────────────────
// A7 (medium): the previous implementation ran the pure-dot defang BEFORE
// the maxLen truncation. Input "..a" with maxLen=2 would survive the defang
// (not pure-dot at that point), then truncate to "..", and a parent-dir
// traversal would reach the caller. The fix moves the defang AND empty
// check to AFTER truncation. These cases lock that in.

h.assertEq("A7: truncation that produces \"..\" is re-defanged",
  sanitizeFilenameComponentDotted("..a", 2), "_");

h.assertEq("A7: truncation that produces \".\" is re-defanged",
  sanitizeFilenameComponentDotted(".ab", 1), "_");

h.assertEq("A7: truncation that produces longer pure-dot is re-defanged",
  sanitizeFilenameComponentDotted("....abc", 3), "_");

h.assertEq("A7: truncation that produces a non-pure-dot result is preserved",
  sanitizeFilenameComponentDotted("a..", 2), "a.");

h.assertEq("A7: truncation that keeps embedded dots is unaffected",
  sanitizeFilenameComponentDotted("..ab", 3), "..a");

h.assertEq("A7: truncation that produces empty string is coerced to underscore",
  sanitizeFilenameComponentDotted("abc", 0), "_");

// ── gracefulKill (unit) ──────────────────────────────────────────────
// gracefulKill from middleware/cleanup.ts implements two-stage SIGTERM →
// SIGKILL escalation for child-process cleanup. Closes audit findings
// AC3 (emulator) and AK8 (mirroring), also applied to logcat-watch.ts
// and ril-intercept.ts which had the same hazard.
//
// Tests spawn real child processes; require POSIX signals.

h.section("gracefulKill (unit)");
const { gracefulKill, gracefulKillAll } = await import("../build/middleware/cleanup.js");

if (process.platform !== "win32") {
  const { spawn } = await import("child_process");

  // Case 1: already-dead child is a no-op (does not throw).
  {
    const child = spawn("/bin/sh", ["-c", "exit 0"]);
    await new Promise((r) => child.once("exit", r));
    let threw = false;
    try { await gracefulKill(child, 500); } catch { threw = true; }
    h.assert("gracefulKill: already-exited child is a no-op (no throw)", !threw);
  }

  // Case 2: cooperative child responds to SIGTERM well before graceMs.
  // 'sleep 60' is a clean POSIX target — SIGTERM kills it immediately.
  {
    const child = spawn("/bin/sh", ["-c", "sleep 60"]);
    const start = Date.now();
    await gracefulKill(child, 5000);
    const elapsed = Date.now() - start;
    h.assert(
      `gracefulKill: cooperative child exits via SIGTERM (took ${elapsed}ms, well under graceMs=5000)`,
      elapsed < 1500
    );
    // Cooperative child gets SIGTERM, which on POSIX surfaces as signal "SIGTERM".
    h.assert(
      `gracefulKill: cooperative child shows SIGTERM signalCode (got ${child.signalCode})`,
      child.signalCode === "SIGTERM"
    );
  }

  // Case 3: stubborn child ignores SIGTERM, gets SIGKILL after graceMs.
  // 'trap "" TERM' makes the shell ignore SIGTERM; the wait loop holds
  // until SIGKILL forcibly terminates it.
  {
    const child = spawn("/bin/sh", ["-c", "trap '' TERM; while true; do sleep 1; done"]);
    // Give the trap time to install before we attempt SIGTERM.
    await new Promise((r) => setTimeout(r, 100));
    const start = Date.now();
    await gracefulKill(child, 500);
    const elapsed = Date.now() - start;
    h.assert(
      `gracefulKill: stubborn child takes at least graceMs to die (took ${elapsed}ms, graceMs=500)`,
      elapsed >= 500
    );
    // gracefulKill returns right after sending SIGKILL without awaiting the
    // child exit, so signalCode is only populated once the exit event fires.
    // Wait for it before asserting (otherwise this races and reads null).
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((r) => child.once("exit", r));
    }
    // SIGKILL surfaces as signalCode SIGKILL on most POSIX systems; some
    // platforms (e.g. Android/Bionic) report null while still terminating the
    // child by signal (exitCode null). Accept either: the timing assertion
    // above already proves the SIGKILL escalation occurred.
    h.assert(
      `gracefulKill: stubborn child force-killed after grace period (signalCode=${child.signalCode}, exitCode=${child.exitCode})`,
      child.signalCode === "SIGKILL" || (child.signalCode === null && child.exitCode === null)
    );
  }

  // Case 4: gracefulKillAll handles multiple children concurrently.
  // Total elapsed should be ~graceMs, not 3×graceMs.
  {
    const children = [
      spawn("/bin/sh", ["-c", "trap '' TERM; sleep 60"]),
      spawn("/bin/sh", ["-c", "trap '' TERM; sleep 60"]),
      spawn("/bin/sh", ["-c", "trap '' TERM; sleep 60"]),
    ];
    await new Promise((r) => setTimeout(r, 100));
    const start = Date.now();
    await gracefulKillAll(children, 500);
    const elapsed = Date.now() - start;
    h.assert(
      `gracefulKillAll: 3 stubborn children killed concurrently (took ${elapsed}ms, expected < 1500ms = 3×graceMs)`,
      elapsed < 1500
    );
    // Wait for each forced exit to be observed before asserting (see note above).
    await Promise.all(children.map((c) =>
      (c.exitCode === null && c.signalCode === null)
        ? new Promise((r) => c.once("exit", r))
        : Promise.resolve()
    ));
    h.assert(
      "gracefulKillAll: all children force-killed (SIGKILL or signal-terminated)",
      children.every((c) => c.signalCode === "SIGKILL" || (c.signalCode === null && c.exitCode === null))
    );
  }
} else {
  h.skip("gracefulKill: already-exited child no-op", "POSIX-only");
  h.skip("gracefulKill: cooperative SIGTERM exit", "POSIX-only");
  h.skip("gracefulKill: cooperative SIGTERM signalCode", "POSIX-only");
  h.skip("gracefulKill: stubborn SIGKILL escalation timing", "POSIX-only");
  h.skip("gracefulKill: stubborn SIGKILL signalCode", "POSIX-only");
  h.skip("gracefulKillAll: concurrent kill timing", "POSIX-only");
  h.skip("gracefulKillAll: all children SIGKILL'd", "POSIX-only");
}

// ── Path Containment (unit) ────────────────────────────────
// isWithinDir from middleware/fs-utils.ts. Used by tools/qemu.ts (image
// containment), tools/split-apk.ts (extract outputDir), and
// tools/registry.ts (plugin file paths). Previously each call site had
// its own inline check; AM1 and AO1 in the audit found that two of those
// inline checks used bare String.prototype.startsWith without a path
// separator boundary — meaning `dir = /tmp/X` and `candidate = /tmp/X_evil/y`
// passed containment incorrectly because the absolute path string-prefix
// matched. The shared helper uses a separator-aware boundary.

h.section("Path Containment — isWithinDir (unit)");
const { isWithinDir } = await import("../build/middleware/fs-utils.js");

// Equal path: candidate IS the directory itself. Allowed (some callers
// use this for "write directly into the temp dir").
h.assert("isWithinDir: candidate equals dir returns true",
  isWithinDir("/tmp/foo", "/tmp/foo") === true);

// Strictly inside: candidate is a subdirectory or file underneath dir.
h.assert("isWithinDir: candidate strictly inside returns true",
  isWithinDir("/tmp/foo/bar.json", "/tmp/foo") === true);

h.assert("isWithinDir: deeper nesting still inside",
  isWithinDir("/tmp/foo/a/b/c/d/e.json", "/tmp/foo") === true);

// THE BYPASS — AM1 / AO1. A sibling directory whose absolute path string
// happens to share a prefix with the target dir. Bare startsWith would
// pass this; isWithinDir correctly rejects it.
h.assert("isWithinDir: sibling with shared prefix (AM1/AO1 bypass) returns false",
  isWithinDir("/tmp/foo_evil/x", "/tmp/foo") === false);

h.assert("isWithinDir: longer-named sibling at same level returns false",
  isWithinDir("/tmp/foobar/x", "/tmp/foo") === false);

// Completely outside.
h.assert("isWithinDir: parent dir of target returns false",
  isWithinDir("/tmp", "/tmp/foo") === false);

h.assert("isWithinDir: unrelated path returns false",
  isWithinDir("/etc/passwd", "/tmp/foo") === false);

// Path traversal: `..` segments get resolved before the check, so a
// candidate that escapes the dir via `..` is correctly identified as
// outside.
h.assert("isWithinDir: candidate using `..` to escape returns false",
  isWithinDir("/tmp/foo/../../etc/passwd", "/tmp/foo") === false);

h.assert("isWithinDir: candidate using `..` but landing back inside returns true",
  isWithinDir("/tmp/foo/sub/../bar.json", "/tmp/foo") === true);

// Trailing-slash normalization: path.resolve strips trailing slashes,
// so the check is consistent whether or not the caller passed one.
h.assert("isWithinDir: trailing slash on dir doesn't affect result",
  isWithinDir("/tmp/foo/bar.json", "/tmp/foo/") === true);

h.assert("isWithinDir: trailing slash on candidate doesn't affect result",
  isWithinDir("/tmp/foo/sub/", "/tmp/foo") === true);


const exitCode = h.finish();
process.exit(exitCode);
